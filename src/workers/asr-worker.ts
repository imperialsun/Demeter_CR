import { createAsrPipeline, disposePipeline, transcribeChunk } from "@/lib/asr";
import logger from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";
import type { ChunkDefinition } from "@/lib/chunking";
import type { ChunkTranscriptionResult } from "@/lib/asr";
import type { WorkerAsrInitConfig } from "@/lib/asr-worker-runtime";

type WorkerTelemetryMethod =
  | "setRuntimeContext"
  | "logEvent"
  | "startTimer"
  | "stopTimer"
  | "pushChunkMetric"
  | "recordAlert"
  | "snapshotMemory";

type WorkerTelemetryMessage = {
  type: "telemetry";
  method: WorkerTelemetryMethod;
  args: unknown[];
};

type WorkerStatusMessage = {
  type: "status";
  status: "idle" | "downloading" | "loading" | "ready" | "transcribing" | "stopping" | "error";
  detail?: string;
  requestId?: number;
};

type WorkerProgressMessage = {
  type: "progress";
  progress?: number;
  status?: string;
  requestId?: number;
};

type WorkerReadyMessage = {
  type: "ready";
  requestId: number;
  backend: "webgpu" | "wasm";
  modelId: string;
  modelType: string | null;
  wasmThreads: number | null;
  forceSingleThread: boolean;
};

type WorkerResultMessage = {
  type: "transcribe-result";
  requestId: number;
  result: ChunkTranscriptionResult;
};

type WorkerDisposedMessage = {
  type: "disposed";
  requestId: number;
};

type WorkerErrorMessage = {
  type: "error";
  requestId?: number;
  message: string;
  name?: string;
  stack?: string;
};

type WorkerResponse =
  | WorkerTelemetryMessage
  | WorkerStatusMessage
  | WorkerProgressMessage
  | WorkerReadyMessage
  | WorkerResultMessage
  | WorkerDisposedMessage
  | WorkerErrorMessage;

type InitRequest = {
  type: "init";
  requestId: number;
  config: WorkerAsrInitConfig;
};

type TranscribeRequest = {
  type: "transcribe";
  requestId: number;
  chunk: ChunkDefinition;
  pcm: Float32Array;
  sampleRate: number;
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
};

type DisposeRequest = {
  type: "dispose";
  requestId: number;
};

type WorkerRequest = InitRequest | TranscribeRequest | DisposeRequest;

type WorkerPipeline = Awaited<ReturnType<typeof createAsrPipeline>>["pipeline"];

const statePatch = (config: WorkerAsrInitConfig) => {
  useAsrStore.setState({
    webGpuSupported: config.webGpuSupported,
    wasmAvailable: config.wasmAvailable,
    forceSingleThread: config.forceSingleThread ?? false,
    modelQuantizationOverrides: config.modelQuantizationOverrides ?? {},
    cleanIntraChunk: config.cleanIntraChunk ?? true,
    enableWordTimestamps: config.enableWordTimestamps ?? false,
    showSegmentConfidence: config.showSegmentConfidence ?? false,
  } as never);
};

const createTelemetryProxy = () => {
  const post = (method: WorkerTelemetryMethod, ...args: unknown[]) => {
    const message: WorkerTelemetryMessage = { type: "telemetry", method, args };
    globalThis.postMessage(message);
  };
  return {
    setRuntimeContext: (context: { backend: string; modelId: string }) => post("setRuntimeContext", context),
    logEvent: (type: string, data?: Record<string, unknown>) => post("logEvent", type, data),
    startTimer: (label: string) => post("startTimer", label),
    stopTimer: (label: string) => post("stopTimer", label),
    pushChunkMetric: (metric: Record<string, unknown>) => post("pushChunkMetric", metric),
    recordAlert: (alertType: string, data?: Record<string, unknown>) => post("recordAlert", alertType, data),
    snapshotMemory: (label: string) => post("snapshotMemory", label),
  };
};

let pipeline: WorkerPipeline | null = null;

function postResponse(message: WorkerResponse) {
  globalThis.postMessage(message);
}

function resolveModelType(activePipeline: WorkerPipeline | null) {
  const modelType = (
    activePipeline as unknown as { model?: { config?: { model_type?: unknown } } }
  )?.model?.config?.model_type;
  return typeof modelType === "string" ? modelType : null;
}

globalThis.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const telemetry = createTelemetryProxy();
  try {
    if (request.type === "init") {
      useAsrStore.setState({ telemetryCollector: telemetry as never } as never);
      statePatch(request.config);
      postResponse({ type: "status", requestId: request.requestId, status: "downloading", detail: "Préparation du modèle" });
      const result = await createAsrPipeline({
        modelPreset: request.config.modelPreset,
        customModelId: request.config.customModelId,
        backendPreference: request.config.backendPreference,
        forceBackend: request.config.forceBackend,
        forceSingleThread: request.config.forceSingleThread,
        telemetry: telemetry as never,
        onStatus: (status, detail) => postResponse({ type: "status", requestId: request.requestId, status, detail }),
        onProgress: (progress, status) => postResponse({ type: "progress", requestId: request.requestId, progress, status }),
        runtimeMode: "direct",
      });
      pipeline = result.pipeline as WorkerPipeline;
      postResponse({
        type: "ready",
        requestId: request.requestId,
        backend: result.backend,
        modelId: result.modelId,
        modelType: resolveModelType(pipeline),
        wasmThreads:
          result.backend === "wasm"
            ? useAsrStore.getState().wasmThreads
            : null,
        forceSingleThread: useAsrStore.getState().forceSingleThread,
      });
      return;
    }

    if (request.type === "transcribe") {
      if (!pipeline) {
        throw new Error("ASR worker pipeline not initialized");
      }
      const result = await transcribeChunk({
        pipeline,
        chunk: request.chunk,
        pcm: request.pcm,
        sampleRate: request.sampleRate,
        telemetry: telemetry as never,
        enableWordTimestamps: request.enableWordTimestamps,
        showSegmentConfidence: request.showSegmentConfidence,
      });
      postResponse({ type: "transcribe-result", requestId: request.requestId, result });
      return;
    }

    if (request.type === "dispose") {
      if (pipeline) {
        await disposePipeline(pipeline as unknown as Parameters<typeof disposePipeline>[0]);
        pipeline = null;
      }
      postResponse({ type: "disposed", requestId: request.requestId });
    }
  } catch (error) {
    logger.warn("[asr-worker] request failed", {
      type: request.type,
      message: error instanceof Error ? error.message : String(error),
    });
    const serialised = error instanceof Error ? error : new Error(String(error));
    postResponse({
      type: "error",
      requestId: request.requestId,
      message: serialised.message,
      name: serialised.name,
      stack: serialised.stack,
    });
  }
};
