/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { useAsrStore } from "@/store/asr-store";

const mocks = vi.hoisted(() => ({
  createAsrPipeline: vi.fn(),
  disposePipeline: vi.fn(async () => {}),
  transcribeChunk: vi.fn(async (args: any) => ({
    chunk: args.chunk,
    text: "ok",
    segments: [],
    processingMs: 1,
    realtimeFactor: 1,
  })),
  isModelTooLargeError: vi.fn((err?: unknown) => {
    void err;
    return false;
  }),
  detectWebGpuSupport: vi.fn(async () => true),
}));

vi.mock("@/lib/asr", () => ({
  createAsrPipeline: mocks.createAsrPipeline,
  disposePipeline: mocks.disposePipeline,
  transcribeChunk: mocks.transcribeChunk,
  isModelTooLargeError: mocks.isModelTooLargeError,
}));

vi.mock("@/lib/backend-support", () => ({
  detectWebGpuSupport: mocks.detectWebGpuSupport,
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: vi.fn(),
}));

import { useModelCompatibilityTest } from "./useModelCompatibilityTest";

type HookState = ReturnType<typeof useModelCompatibilityTest>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useModelCompatibilityTest", () => {
  let latest: HookState | null = null;

  function TestComp() {
    const hook = useModelCompatibilityTest();
    useEffect(() => {
      latest = hook;
    });
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.detectWebGpuSupport.mockResolvedValue(true);
    mocks.isModelTooLargeError.mockImplementation((err?: unknown) => {
      void err;
      return false;
    });
    mocks.createAsrPipeline.mockResolvedValue({
      pipeline: {} as any,
      backend: "webgpu",
      modelId: "m",
    });
    mocks.transcribeChunk.mockImplementation(async (args: any) => ({
      chunk: args.chunk,
      text: "ok",
      segments: [],
      processingMs: 1,
      realtimeFactor: 1,
    }));
    useAsrStore.setState({
      backendPreference: "webgpu",
      forceSingleThread: false,
      isTranscribing: false,
      blockedPresets: [],
      webGpuSupported: true,
      wasmAvailable: true,
    } as any);
  });

  afterEach(() => {
    latest = null;
  });

  it("skips webgpu when unsupported and tests wasm", async () => {
    mocks.detectWebGpuSupport.mockResolvedValueOnce(false);
    mocks.createAsrPipeline.mockResolvedValue({
      pipeline: {} as any,
      backend: "wasm",
      modelId: "m",
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      await latest!.runTest();
    });

    expect(mocks.createAsrPipeline).toHaveBeenCalled();
    const allCalls = mocks.createAsrPipeline.mock.calls.map((call) => call[0]);
    expect(allCalls.every((args) => args.forceBackend === "wasm")).toBe(true);
    expect(latest!.state.results[0].backends.webgpu.status).toBe("unavailable");
    expect(latest!.state.results[0].backends.wasm.status).toBe("ok");
  });

  it("stops after the current step when stopTest is called", async () => {
    const deferred = createDeferred<{ pipeline: any; backend: "webgpu"; modelId: string }>();
    mocks.createAsrPipeline.mockImplementationOnce(() => deferred.promise as any);
    mocks.createAsrPipeline.mockResolvedValue({
      pipeline: {} as any,
      backend: "webgpu",
      modelId: "m",
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    let runPromise: Promise<void> | undefined;
    await act(async () => {
      runPromise = latest!.runTest();
    });

    await waitFor(() => expect(mocks.createAsrPipeline).toHaveBeenCalledTimes(1));

    act(() => {
      latest!.stopTest();
    });

    await act(async () => {
      deferred.resolve({ pipeline: {}, backend: "webgpu", modelId: "m" } as any);
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => expect(latest!.state.running).toBe(false));
    expect(latest!.state.stopRequested).toBe(true);
    expect(mocks.createAsrPipeline).toHaveBeenCalledTimes(1);
  });

  it("blocks presets when all backends fail with too large", async () => {
    mocks.detectWebGpuSupport.mockResolvedValueOnce(true);
    mocks.isModelTooLargeError.mockImplementation((err: unknown) => {
      return String((err as Error)?.message ?? err).toLowerCase().includes("memory");
    });
    mocks.createAsrPipeline.mockImplementation(async (args: { forceBackend?: string }) => ({
      pipeline: {} as any,
      backend: (args.forceBackend ?? "webgpu") as any,
      modelId: "m",
    }));
    mocks.transcribeChunk.mockImplementation(async (args: { chunk: { id: string } }) => {
      if (args.chunk.id.startsWith("compat-fast")) {
        throw new Error("out of memory");
      }
      return {
        chunk: args.chunk,
        text: "ok",
        segments: [],
        processingMs: 1,
        realtimeFactor: 1,
      };
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      await latest!.runTest();
    });

    await waitFor(() => {
      expect(useAsrStore.getState().blockedPresets).toEqual(["fast"]);
    });
  });

  it("blocks presets when all backends fail with error", async () => {
    mocks.detectWebGpuSupport.mockResolvedValueOnce(true);
    mocks.isModelTooLargeError.mockImplementation(() => false);
    mocks.createAsrPipeline.mockImplementation(async (args: { forceBackend?: string }) => ({
      pipeline: {} as any,
      backend: (args.forceBackend ?? "webgpu") as any,
      modelId: "m",
    }));
    mocks.transcribeChunk.mockImplementation(async (args: { chunk: { id: string } }) => {
      if (args.chunk.id.startsWith("compat-fast")) {
        throw new Error("boom");
      }
      return {
        chunk: args.chunk,
        text: "ok",
        segments: [],
        processingMs: 1,
        realtimeFactor: 1,
      };
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      await latest!.runTest();
    });

    await waitFor(() => {
      expect(useAsrStore.getState().blockedPresets).toEqual(["fast"]);
    });
  });

  it("keeps the recap open until closeSummary is called", async () => {
    mocks.detectWebGpuSupport.mockResolvedValueOnce(true);
    mocks.createAsrPipeline.mockResolvedValue({
      pipeline: {} as any,
      backend: "webgpu",
      modelId: "m",
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      await latest!.runTest();
    });

    expect(latest!.state.summaryOpen).toBe(true);

    act(() => {
      latest!.closeSummary();
    });

    await waitFor(() => expect(latest!.state.summaryOpen).toBe(false));
  });

  it("tests multiple quantizations and restores initial overrides", async () => {
    useAsrStore.setState({
      modelQuantizationOverrides: {
        fast: { webgpu: "fp16" },
      },
    } as any);

    mocks.detectWebGpuSupport.mockResolvedValueOnce(true);
    mocks.createAsrPipeline.mockResolvedValue({
      pipeline: {} as any,
      backend: "webgpu",
      modelId: "m",
    });

    render(<TestComp />);
    await waitFor(() => expect(latest).not.toBeNull());

    await act(async () => {
      await latest!.runTest();
    });

    const testedChunkIds = mocks.transcribeChunk.mock.calls.map(
      (call) => (call[0] as { chunk: { id: string } }).chunk.id
    );
    expect(testedChunkIds).toContain("compat-fast-webgpu-fp16-1");
    expect(testedChunkIds).toContain("compat-fast-webgpu-q8-2");
    expect(testedChunkIds).toContain("compat-fast-webgpu-auto-3");
    expect(useAsrStore.getState().modelQuantizationOverrides).toEqual({
      fast: { webgpu: "fp16" },
    });
  });
});
