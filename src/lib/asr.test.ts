import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAsrStore } from "@/store/asr-store";

const mocks = vi.hoisted(() => {
  const state = {
    webGpuSupported: false,
  };
  return {
    state,
    detectWebGpuSupport: vi.fn(async () => state.webGpuSupported),
    pipelineFactory: vi.fn(async () => async () => ({ text: "ok" })),
    moduleEnv: { backends: { onnx: { wasm: {} as Record<string, unknown> } } },
  };
});

const ortMocks = vi.hoisted(() => {
  return {
    flagWasmSessionOptions: vi.fn(),
    patchOrtWasmEnv: vi.fn(),
  };
});

const toastMocks = vi.hoisted(() => {
  return {
    toast: vi.fn(),
  };
});

vi.mock("@/lib/backend-support", () => ({
  detectWebGpuSupport: mocks.detectWebGpuSupport,
}));

vi.mock("@/lib/transformers-loader", () => ({
  loadTransformers: async () => ({
    pipeline: mocks.pipelineFactory,
    env: mocks.moduleEnv,
  }),
}));

vi.mock("@/lib/ort-wasm", () => ({
  flagWasmSessionOptions: ortMocks.flagWasmSessionOptions,
  patchOrtWasmEnv: ortMocks.patchOrtWasmEnv,
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: toastMocks.toast,
}));

describe("asr module", () => {
  beforeEach(() => {
    mocks.state.webGpuSupported = false;
    mocks.detectWebGpuSupport.mockClear();
    mocks.pipelineFactory.mockClear();
    ortMocks.flagWasmSessionOptions.mockClear();
    ortMocks.patchOrtWasmEnv.mockClear();
    toastMocks.toast.mockClear();
    mocks.moduleEnv.backends.onnx.wasm = {};
    useAsrStore.getState().resetApp();
    useAsrStore.setState({
      wasmAvailable: true,
      forceSingleThread: true,
      enableWordTimestamps: true,
      showSegmentConfidence: true,
      cleanIntraChunk: true,
      modelQuantizationOverrides: {},
    } as never);
  });

  it("detects model-too-large errors", async () => {
    const { isModelTooLargeError } = await import("@/lib/asr");
    expect(isModelTooLargeError(new Error("std::bad_alloc"))).toBe(true);
    expect(isModelTooLargeError("out of memory")).toBe(true);
    expect(isModelTooLargeError(new Error("network issue"))).toBe(false);
    expect(isModelTooLargeError(undefined)).toBe(false);

    const throwingMessage = {};
    Object.defineProperty(throwingMessage, "message", {
      get() {
        throw new Error("boom");
      },
    });
    expect(isModelTooLargeError(throwingMessage)).toBe(false);
  });

  it("disposePipeline ignores disposal errors", async () => {
    const { disposePipeline } = await import("@/lib/asr");
    const pipe = {
      dispose: vi.fn(async () => {
        throw new Error("dispose failed");
      }),
    };
    await expect(disposePipeline(pipe)).resolves.toBeUndefined();
  });

  it("transcribes chunk and maps word timestamps from top-level words", async () => {
    const { transcribeChunk } = await import("@/lib/asr");
    const invoke = vi.fn(async () => ({
      text: " Bonjour test ",
      words: [{ word: "Bonjour", start: 0.1, end: 0.4, probability: 0.8 }],
    }));

    const result = await transcribeChunk({
      pipeline: invoke as never,
      chunk: {
        id: "c1",
        index: 0,
        start: 3,
        end: 5,
        paddedStart: 3,
        paddedEnd: 5,
      },
      pcm: new Float32Array([0.1, 0.2]),
      sampleRate: 16000,
    });

    expect(result.text).toBe("Bonjour test");
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.words?.[0]).toMatchObject({
      word: "Bonjour",
      start: 3.1,
      end: 3.4,
      confidence: 0.8,
    });
  });

  it("retries once without word timestamps when cross-attention is unsupported", async () => {
    const { transcribeChunk } = await import("@/lib/asr");
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new Error("cross attentions are disabled"))
      .mockResolvedValueOnce({ text: "fallback text" });

    const result = await transcribeChunk({
      pipeline: invoke as never,
      chunk: {
        id: "c2",
        index: 1,
        start: 0,
        end: 1,
        paddedStart: 0,
        paddedEnd: 1,
      },
      pcm: new Float32Array([0.1, 0.2]),
      sampleRate: 16000,
    });

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("fallback text");
  });

  it("throws immediately when transcription is already aborted", async () => {
    const { transcribeChunk } = await import("@/lib/asr");
    const controller = new AbortController();
    controller.abort();
    const invoke = vi.fn(async () => ({ text: "ok" }));

    await expect(
      transcribeChunk({
        pipeline: invoke as never,
        chunk: {
          id: "c-abort",
          index: 4,
          start: 0,
          end: 1,
          paddedStart: 0,
          paddedEnd: 1,
        },
        pcm: new Float32Array([0.1]),
        sampleRate: 16000,
        abortSignal: controller.signal,
      })
    ).rejects.toThrow("Transcription annulée");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("rethrows non cross-attention runtime errors", async () => {
    const { transcribeChunk } = await import("@/lib/asr");
    const invoke = vi.fn(async () => {
      throw new Error("backend crash");
    });

    await expect(
      transcribeChunk({
        pipeline: invoke as never,
        chunk: {
          id: "c-err",
          index: 5,
          start: 0,
          end: 1,
          paddedStart: 0,
          paddedEnd: 1,
        },
        pcm: new Float32Array([0.1]),
        sampleRate: 16000,
      })
    ).rejects.toThrow("backend crash");
  });

  it("adds whisper language hint and handles rich chunk payload logging path", async () => {
    const { transcribeChunk } = await import("@/lib/asr");
    const invoke = vi.fn(async () => ({
      text: "bonjour monde",
      token_timestamps: [0.1, 0.2, 0.3],
      chunks: [
        {
          text: "bonjour monde",
          words: [{ word: "bonjour", start: 0, end: 0.5, score: 0.9 }],
          timestamp_tokens: [1, 2, 3],
        },
      ],
    }));
    (invoke as unknown as { model?: { config?: { model_type?: string } } }).model = {
      config: { model_type: "whisper" },
    };

    const result = await transcribeChunk({
      pipeline: invoke as never,
      chunk: {
        id: "c-rich",
        index: 6,
        start: 10,
        end: 12,
        paddedStart: 10,
        paddedEnd: 12,
      },
      pcm: new Float32Array([0.1, 0.2]),
      sampleRate: 16000,
    });

    expect(result.text).toContain("bonjour");
    expect(invoke).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({
        language: "fr",
      })
    );
  });

  it("creates a wasm pipeline with expected options", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    mocks.pipelineFactory.mockResolvedValueOnce(async () => ({ text: "ok" }));

    const result = await createAsrPipeline({
      modelPreset: "fast",
      customModelId: "",
      backendPreference: "wasm",
    });

    expect(result.backend).toBe("wasm");
    expect(result.modelId).toContain("whisper");
    expect(mocks.pipelineFactory).toHaveBeenCalledWith(
      "automatic-speech-recognition",
      expect.any(String),
      expect.objectContaining({
        device: "wasm",
      })
    );
    expect(ortMocks.flagWasmSessionOptions).toHaveBeenCalled();
  });

  it("falls back to wasm when webgpu is unavailable", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    useAsrStore.setState({ wasmAvailable: true } as never);
    mocks.state.webGpuSupported = false;
    mocks.pipelineFactory.mockResolvedValueOnce(async () => ({ text: "ok" }));

    const result = await createAsrPipeline({
      modelPreset: "fast",
      customModelId: "",
      backendPreference: "webgpu",
    });

    expect(result.backend).toBe("wasm");
    expect(mocks.pipelineFactory).toHaveBeenCalled();
  });

  it("retries wasm initialization in single-thread mode after a first failure", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    const firstError = new Error("WASM init failed");
    mocks.pipelineFactory
      .mockRejectedValueOnce(firstError)
      .mockResolvedValueOnce(async () => ({ text: "ok" }));

    const result = await createAsrPipeline({
      modelPreset: "fast",
      customModelId: "",
      backendPreference: "wasm",
      forceSingleThread: false,
    });

    expect(result.backend).toBe("wasm");
    expect(mocks.pipelineFactory).toHaveBeenCalledTimes(2);
    expect(ortMocks.patchOrtWasmEnv).toHaveBeenCalled();
  });

  it("records model fetch diagnostics and memory snapshots during pipeline load", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    const telemetry = {
      logEvent: vi.fn(),
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
      setRuntimeContext: vi.fn(),
      recordAlert: vi.fn(),
    };

    const perf = performance as Performance & {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit?: number };
      measureUserAgentSpecificMemory?: () => Promise<{
        bytes?: number;
        breakdown?: Array<{ bytes?: number; attribution?: unknown; types?: unknown }>;
      }>;
    };
    const originalMemory = perf.memory;
    const originalMeasure = perf.measureUserAgentSpecificMemory;
    Object.defineProperty(perf, "memory", {
      configurable: true,
      value: { usedJSHeapSize: 1_000_000, totalJSHeapSize: 2_000_000, jsHeapSizeLimit: 4_000_000 },
    });
    Object.defineProperty(perf, "measureUserAgentSpecificMemory", {
      configurable: true,
      value: vi.fn(async () => ({
        bytes: 9_000_000,
        breakdown: [{ bytes: 1234 }],
      })),
    });

    vi.spyOn(performance, "getEntriesByName").mockReturnValue([
      { transferSize: 100, encodedBodySize: 200 } as PerformanceResourceTiming,
    ]);
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    mocks.pipelineFactory.mockImplementationOnce(
      async (_task: string, _model?: string, options?: Record<string, unknown>) => {
        const callback = options?.progress_callback as ((data: Record<string, unknown>) => void) | undefined;
        callback?.({ progress: 0.5, status: "downloading", file: "model.onnx" });
        return async () => ({ text: "ok" });
      }
    );

    try {
      const result = await createAsrPipeline({
        modelPreset: "fast",
        customModelId: "",
        backendPreference: "wasm",
        telemetry: telemetry as never,
      });

      expect(result.backend).toBe("wasm");
      expect(telemetry.logEvent).toHaveBeenCalledWith(
        "MODEL_FETCH",
        expect.objectContaining({ file: "model.onnx" })
      );
      expect(telemetry.logEvent).toHaveBeenCalledWith(
        "RAM_USAGE",
        expect.objectContaining({ context: "transformers_worker" })
      );
      expect(telemetry.logEvent).toHaveBeenCalledWith(
        "RAM_USAGE",
        expect.objectContaining({ context: "total_memory_snapshot" })
      );
    } finally {
      Object.defineProperty(perf, "memory", { configurable: true, value: originalMemory });
      Object.defineProperty(perf, "measureUserAgentSpecificMemory", {
        configurable: true,
        value: originalMeasure,
      });
    }
  });

  it("handles resource timing and memory-measure failures gracefully", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    const telemetry = {
      logEvent: vi.fn(),
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
      setRuntimeContext: vi.fn(),
      recordAlert: vi.fn(),
    };
    const storeTelemetry = { logEvent: vi.fn() };
    useAsrStore.setState({ telemetryCollector: storeTelemetry as never } as never);

    vi.spyOn(performance, "getEntriesByName").mockImplementation(() => {
      throw new Error("timing blocked");
    });
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([]);

    const perf = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<unknown>;
    };
    const originalMeasure = perf.measureUserAgentSpecificMemory;
    Object.defineProperty(perf, "measureUserAgentSpecificMemory", {
      configurable: true,
      value: vi.fn(async () => {
        throw new Error("no permission");
      }),
    });

    mocks.pipelineFactory.mockImplementationOnce(
      async (_task: string, _model?: string, options?: Record<string, unknown>) => {
        const callback = options?.progress_callback as ((data: Record<string, unknown>) => void) | undefined;
        callback?.({ progress: 0.2, status: "downloading", file: "broken.bin" });
        return async () => ({ text: "ok" });
      }
    );

    try {
      const result = await createAsrPipeline({
        modelPreset: "fast",
        customModelId: "",
        backendPreference: "wasm",
        telemetry: telemetry as never,
      });
      expect(result.backend).toBe("wasm");
      expect(storeTelemetry.logEvent).toHaveBeenCalledWith(
        "WASM_MEMORY_MEASURE_FAILED",
        expect.objectContaining({ message: expect.stringContaining("Error: no permission") })
      );
    } finally {
      Object.defineProperty(perf, "measureUserAgentSpecificMemory", {
        configurable: true,
        value: originalMeasure,
      });
    }
  });

  it("surfaces fallback failure after wasm single-thread retry", async () => {
    const { createAsrPipeline } = await import("@/lib/asr");
    Object.defineProperty(window, "crossOriginIsolated", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      value: 8,
    });
    ortMocks.patchOrtWasmEnv.mockImplementationOnce(() => {
      throw new Error("ort patch failed");
    });
    mocks.pipelineFactory
      .mockRejectedValueOnce(new Error("first wasm init failed"))
      .mockRejectedValueOnce(new Error("second wasm init failed"));

    await expect(
      createAsrPipeline({
        modelPreset: "fast",
        customModelId: "",
        backendPreference: "wasm",
        forceSingleThread: false,
      })
    ).rejects.toThrow("second wasm init failed");
    expect(toastMocks.toast).toHaveBeenCalled();
  });

  it("fails with explicit backend message when no backend is available", async () => {
    useAsrStore.setState({ wasmAvailable: false } as never);
    const { createAsrPipeline } = await import("@/lib/asr");

    await expect(
      createAsrPipeline({
        modelPreset: "fast",
        customModelId: "",
        backendPreference: "webgpu",
      })
    ).rejects.toThrow("Aucun backend utilisable");
  });
});
