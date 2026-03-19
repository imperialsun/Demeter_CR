import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { ChunkDefinition } from "@/lib/chunking";
import { useAsrStore, type BackendImplementation, type PresetKey, type PresetQuantizationOverrides, type PipelineStatus } from "@/store/asr-store";
import logger from "@/lib/logger";
import type { ChunkTranscriptionResult, CreatePipelineOptions, TranscribeChunkOptions } from "@/lib/asr";
import type { TelemetryCollector } from "@/lib/telemetry";

export type WorkerAsrInitConfig = {
  modelPreset: PresetKey;
  customModelId: string;
  backendPreference: BackendImplementation;
  forceBackend?: BackendImplementation;
  forceSingleThread?: boolean;
  webGpuSupported: boolean;
  wasmAvailable: boolean;
  modelQuantizationOverrides: PresetQuantizationOverrides;
  cleanIntraChunk: boolean;
  enableWordTimestamps: boolean;
  showSegmentConfidence: boolean;
};

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
  status: PipelineStatus;
  detail?: string;
};

type WorkerProgressMessage = {
  type: "progress";
  progress?: number;
  status?: string;
};

type WorkerReadyMessage = {
  type: "ready";
  backend: BackendImplementation;
  modelId: string;
  modelType: string | null;
  wasmThreads: number | null;
  forceSingleThread: boolean;
};

type WorkerResultMessage = {
  type: "transcribe-result";
  result: ChunkTranscriptionResult;
};

type WorkerDisposedMessage = {
  type: "disposed";
};

type WorkerErrorMessage = {
  type: "error";
  message: string;
  name?: string;
  stack?: string;
  requestId?: number;
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
  config: WorkerAsrInitConfig;
};

type TranscribeRequest = {
  type: "transcribe";
  chunk: ChunkDefinition;
  pcm: Float32Array;
  sampleRate: number;
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
};

type DisposeRequest = {
  type: "dispose";
};

type WorkerRequest = InitRequest | TranscribeRequest | DisposeRequest;

const WORKER_SESSION_SYMBOL = Symbol("asr-worker-session");

type WorkerSessionCarrier = {
  [WORKER_SESSION_SYMBOL]?: AsrWorkerRuntimeSession;
};

export interface AsrWorkerRuntimeSession {
  backend: BackendImplementation;
  modelId: string;
  modelType: string | null;
  transcribeChunk(args: Omit<TranscribeChunkOptions, "pipeline">): Promise<ChunkTranscriptionResult>;
  dispose(): Promise<void>;
  terminate(): void;
}

type WorkerPendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type RequestWithId = WorkerRequest & { requestId: number };

function toError(value: unknown, fallbackMessage: string) {
  if (value instanceof Error) return value;
  const error = new Error(fallbackMessage);
  error.name = "Error";
  if (typeof value === "string" && value.trim()) {
    error.message = value;
  }
  return error;
}

function applyTelemetryMessage(collector: TelemetryCollector, method: WorkerTelemetryMethod, args: unknown[]) {
  try {
    switch (method) {
      case "setRuntimeContext":
        collector.setRuntimeContext(args[0] as { backend: string; modelId: string });
        break;
      case "logEvent":
        collector.logEvent(
          args[0] as Parameters<TelemetryCollector["logEvent"]>[0],
          args[1] as Record<string, unknown> | undefined
        );
        break;
      case "startTimer":
        collector.startTimer(String(args[0] ?? ""));
        break;
      case "stopTimer":
        collector.stopTimer(String(args[0] ?? ""));
        break;
      case "pushChunkMetric":
        collector.pushChunkMetric(args[0] as Parameters<TelemetryCollector["pushChunkMetric"]>[0]);
        break;
      case "recordAlert":
        collector.recordAlert(String(args[0] ?? ""), args[1] as Record<string, unknown> | undefined);
        break;
      case "snapshotMemory":
        collector.snapshotMemory(String(args[0] ?? ""));
        break;
      default:
        break;
    }
  } catch (error) {
    logger.warn("[asr][worker-runtime] telemetry mirror failed", error);
  }
}

function buildPipelineProxy(session: AsrWorkerRuntimeSession): AutomaticSpeechRecognitionPipeline {
  const proxy = (async () => {
    throw new Error("Worker-backed ASR pipeline cannot be invoked directly.");
  }) as unknown as AutomaticSpeechRecognitionPipeline;

  Object.defineProperty(proxy, "dispose", {
    configurable: true,
    value: () => session.dispose(),
  });
  Object.defineProperty(proxy, "model", {
    configurable: true,
    value: {
      config: {
        model_type: session.modelType ?? undefined,
      },
    },
  });
  Object.defineProperty(proxy, WORKER_SESSION_SYMBOL, {
    configurable: false,
    enumerable: false,
    value: session,
  });
  return proxy;
}

export function getWorkerRuntimeSession(pipeline: unknown): AsrWorkerRuntimeSession | undefined {
  if (!pipeline || (typeof pipeline !== "object" && typeof pipeline !== "function")) return undefined;
  return (pipeline as WorkerSessionCarrier)[WORKER_SESSION_SYMBOL];
}

export async function createAsrWorkerRuntime(options: CreatePipelineOptions): Promise<{
  pipeline: AutomaticSpeechRecognitionPipeline;
  backend: BackendImplementation;
  modelId: string;
}> {
  const telemetry = options.telemetry ?? useAsrStore.getState().telemetryCollector ?? null;
  const onStatus = options.onStatus;
  const onProgress = options.onProgress;
  const state = useAsrStore.getState();
  const workerConfig: WorkerAsrInitConfig = {
    modelPreset: options.modelPreset,
    customModelId: options.customModelId,
    backendPreference: options.backendPreference,
    forceBackend: options.forceBackend,
    forceSingleThread: options.forceSingleThread ?? state.forceSingleThread,
    webGpuSupported: state.webGpuSupported,
    wasmAvailable: state.wasmAvailable,
    modelQuantizationOverrides: state.modelQuantizationOverrides,
    cleanIntraChunk: state.cleanIntraChunk,
    enableWordTimestamps: state.enableWordTimestamps,
    showSegmentConfidence: state.showSegmentConfidence,
  };

  const worker = new Worker(new URL("../workers/asr-worker.ts", import.meta.url), {
    type: "module",
    name: "asr-runtime-worker",
  });

  let disposed = false;
  let nextRequestId = 1;
  const pending = new Map<number, WorkerPendingRequest>();

  const rejectAll = (error: unknown) => {
    const reason = toError(error, "ASR worker failed");
    for (const { reject } of pending.values()) {
      reject(reason);
    }
    pending.clear();
  };

  const terminateWorker = (error?: unknown) => {
    if (disposed) return;
    disposed = true;
    try {
      worker.terminate();
    } finally {
      rejectAll(error ?? new Error("ASR worker terminated"));
    }
  };

  const sendRequest = <T,>(request: WorkerRequest, transfer: Transferable[] = []): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("ASR worker already disposed"));
    }
    const requestId = nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      pending.set(requestId, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      try {
        worker.postMessage({ ...request, requestId } as RequestWithId, transfer);
      } catch (error) {
        pending.delete(requestId);
        reject(error);
      }
    });
  };

  const session: AsrWorkerRuntimeSession = {
    backend: options.backendPreference,
    modelId: "",
    modelType: null,
    async transcribeChunk(args: Omit<TranscribeChunkOptions, "pipeline">) {
      const abortSignal = args.abortSignal;
      if (abortSignal?.aborted) {
        throw new Error("Transcription annulée");
      }
      const pcm = args.pcm;
      const request = sendRequest<ChunkTranscriptionResult>(
        {
          type: "transcribe",
          chunk: args.chunk,
          pcm,
          sampleRate: args.sampleRate,
          enableWordTimestamps: args.enableWordTimestamps,
          showSegmentConfidence: args.showSegmentConfidence,
        },
        [pcm.buffer]
      );

      if (!abortSignal) {
        return request;
      }

      return new Promise<ChunkTranscriptionResult>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          abortSignal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          if (settled) return;
          settled = true;
          cleanup();
          session.terminate();
          reject(new Error("Transcription annulée"));
        };

        abortSignal.addEventListener("abort", onAbort, { once: true });
        request.then(
          (result) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(result);
          },
          (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          }
        );
      });
    },
    async dispose() {
      session.terminate();
    },
    terminate() {
      terminateWorker(new Error("ASR worker terminated"));
    },
  };

  worker.onmessage = (event: MessageEvent<WorkerResponse & { requestId?: number }>) => {
    const message = event.data;

    if (message.type === "telemetry") {
      if (telemetry) {
        applyTelemetryMessage(telemetry, message.method, message.args);
      }
      return;
    }

    if (message.type === "status") {
      onStatus?.(message.status, message.detail);
      return;
    }

    if (message.type === "progress") {
      onProgress?.(typeof message.progress === "number" ? message.progress : 0, message.status ?? "loading");
      return;
    }

    const requestId = message.requestId;
    if (message.type === "error") {
      const error = new Error(message.message);
      error.name = message.name ?? "Error";
      if (message.stack) {
        error.stack = message.stack;
      }
      if (typeof requestId === "number") {
        const callback = pending.get(requestId);
        if (callback) {
          callback.reject(error);
          pending.delete(requestId);
          return;
        }
      }
      terminateWorker(error);
      return;
    }

    if (typeof requestId !== "number") {
      return;
    }

    const callback = pending.get(requestId);
    if (!callback) {
      return;
    }

    switch (message.type) {
      case "ready":
        callback.resolve(message);
        break;
      case "transcribe-result":
        callback.resolve(message.result);
        break;
      case "disposed":
        callback.resolve(undefined);
        break;
      default:
        break;
    }
    pending.delete(requestId);
  };

  worker.onerror = (event: ErrorEvent) => {
    terminateWorker(event.error instanceof Error ? event.error : new Error(event.message || "ASR worker error"));
  };

  worker.onmessageerror = (event) => {
    terminateWorker(new Error(`ASR worker message error: ${String((event as MessageEvent).data ?? "unknown")}`));
  };

  try {
    const ready = await sendRequest<WorkerReadyMessage>({
      type: "init",
      config: workerConfig,
    });
    session.backend = ready.backend;
    session.modelId = ready.modelId;
    session.modelType = ready.modelType;
    useAsrStore.getState().setForceSingleThread(ready.forceSingleThread);
    useAsrStore.getState().setWasmThreads(ready.wasmThreads);

    const pipeline = buildPipelineProxy(session);
    return { pipeline, backend: ready.backend, modelId: ready.modelId };
  } catch (error) {
    session.terminate();
    throw error;
  }
}
