import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useAsrStore } from "@/store/asr-store";
import {
  detectWebGpuSupport,
  initializeBackendSupport,
  resetWebGpuSupportCache,
  testWasmMultithreadSupport,
} from "@/lib/backend-support";

describe("backend-support", () => {
  const originalGpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;

  beforeEach(() => {
    useAsrStore.getState().resetApp();
    useAsrStore.setState({
      webGpuSupported: false,
      wasmAvailable: false,
      backendPreference: "webgpu",
      wasmThreads: null,
      telemetryCollector: null,
    } as never);
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
    resetWebGpuSupportCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: originalGpu,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: originalCreateObjectUrl,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: originalRevokeObjectUrl,
    });
    resetWebGpuSupportCache();
  });

  it("caches WebGPU support detection", async () => {
    const requestAdapter = vi.fn(async () => ({}));
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter },
    });

    const first = await detectWebGpuSupport();
    const second = await detectWebGpuSupport();

    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(requestAdapter).toHaveBeenCalledTimes(1);
  });

  it("returns false when WebGPU adapter request throws", async () => {
    const requestAdapter = vi.fn(async () => {
      throw new Error("gpu unavailable");
    });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter },
    });

    await expect(detectWebGpuSupport()).resolves.toBe(false);
  });

  it("initializes backend to webgpu when webgpu and wasm are available", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: { requestAdapter: vi.fn(async () => ({})) },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "application/wasm" } })
    );

    const supported = await initializeBackendSupport();

    expect(supported).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();
    const state = useAsrStore.getState();
    expect(state.webGpuSupported).toBe(true);
    expect(state.wasmAvailable).toBe(true);
    expect(state.backendPreference).toBe("webgpu");
  });

  it("falls back to wasm backend when webgpu is unavailable but wasm assets exist", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "application/wasm" } })
    );

    const supported = await initializeBackendSupport();
    const state = useAsrStore.getState();

    expect(supported).toBe(false);
    expect(state.webGpuSupported).toBe(false);
    expect(state.wasmAvailable).toBe(true);
    expect(state.backendPreference).toBe("wasm");
  });

  it("keeps wasm as default when no backend is available and telemetry fails", async () => {
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const telemetryLogEvent = vi.fn(() => {
      throw new Error("telemetry write failed");
    });
    useAsrStore.setState({
      telemetryCollector: { logEvent: telemetryLogEvent },
    } as never);

    const supported = await initializeBackendSupport();
    const state = useAsrStore.getState();

    expect(supported).toBe(false);
    expect(state.webGpuSupported).toBe(false);
    expect(state.wasmAvailable).toBe(false);
    expect(state.backendPreference).toBe("wasm");
    expect(state.wasmThreads).toBeNull();
    expect(telemetryLogEvent).toHaveBeenCalled();
  });

  it("stores wasm thread count when multithread test succeeds", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 8,
    });
    Object.defineProperty(navigator, "gpu", {
      configurable: true,
      value: undefined,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("ok", { status: 200, headers: { "content-type": "application/wasm" } })
    );

    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const workerTerminate = vi.fn();
    const workerCtor = vi.fn();
    class SuccessWorker {
      onmessage: ((event: { data?: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      constructor() {
        workerCtor();
      }
      postMessage() {
        this.onmessage?.({ data: { ok: true } });
      }
      terminate() {
        workerTerminate();
      }
    }
    vi.stubGlobal("Worker", SuccessWorker as unknown as typeof Worker);

    const supported = await initializeBackendSupport();
    const state = useAsrStore.getState();

    expect(supported).toBe(false);
    expect(state.backendPreference).toBe("wasm");
    expect(state.wasmThreads).toBe(8);
    expect(workerCtor).toHaveBeenCalledTimes(1);
    expect(workerTerminate).toHaveBeenCalledTimes(1);
  });

  it("returns no-window when executed outside browser context", async () => {
    vi.stubGlobal("window", undefined);
    const result = await testWasmMultithreadSupport(10);
    expect(result).toEqual({ ok: false, reason: "no-window" });
  });

  it("returns not_cross_origin_isolated when isolation is missing", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: false,
    });
    const result = await testWasmMultithreadSupport(10);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("not_cross_origin_isolated");
  });

  it("returns no_SAB when SharedArrayBuffer is unavailable", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    vi.stubGlobal("SharedArrayBuffer", undefined);
    const result = await testWasmMultithreadSupport(10);
    expect(result).toEqual({ ok: false, reason: "no_SAB" });
  });

  it("returns worker error reason when worker emits error", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    class ErrorWorker {
      onmessage: ((event: { data?: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      constructor() {}
      postMessage() {
        this.onerror?.({ message: "worker boom" });
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", ErrorWorker as unknown as typeof Worker);

    const result = await testWasmMultithreadSupport(25);
    expect(result).toEqual({ ok: false, reason: "worker boom" });
  });

  it("returns worker_failed when worker reports a failure payload", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    class FailedWorker {
      onmessage: ((event: { data?: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      constructor() {}
      postMessage() {
        this.onmessage?.({ data: { ok: false } });
      }
      terminate() {}
    }
    vi.stubGlobal("Worker", FailedWorker as unknown as typeof Worker);

    const result = await testWasmMultithreadSupport(25);
    expect(result).toEqual({ ok: false, reason: "worker_failed" });
  });

  it("returns constructor error when Worker cannot start", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    class ThrowingWorker {
      constructor() {
        throw new Error("cannot spawn worker");
      }
    }
    vi.stubGlobal("Worker", ThrowingWorker as unknown as typeof Worker);

    const result = await testWasmMultithreadSupport(25);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("cannot spawn worker");
  });

  it("returns timeout when worker never responds", async () => {
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:mock"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    class SilentWorker {
      onmessage: ((event: { data?: unknown }) => void) | null = null;
      onerror: ((event: { message?: string }) => void) | null = null;
      constructor() {}
      postMessage() {}
      terminate() {}
    }
    vi.stubGlobal("Worker", SilentWorker as unknown as typeof Worker);

    const result = await testWasmMultithreadSupport(1);
    expect(result).toEqual({ ok: false, reason: "timeout" });
  });
});
