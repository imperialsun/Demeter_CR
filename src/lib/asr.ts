import {
  resolveModelId,
  useAsrStore,
  type BackendImplementation,
  type PipelineStatus,
} from "@/store/asr-store";
import type { ChunkDefinition } from "@/lib/chunking";
import logger from "@/lib/logger";
import type { TelemetryCollector, TelemetryEventType } from "@/lib/telemetry";
import { flagWasmSessionOptions, patchOrtWasmEnv } from "@/lib/ort-wasm";
import { toast } from "@/components/ui/use-toast";
import { loadTransformers } from "@/lib/transformers-loader";
import type {
  AutomaticSpeechRecognitionPipeline,
  GenericPipeline,
} from "@/lib/transformers-loader";
import { detectWebGpuSupport } from "@/lib/backend-support";
import { cleanTranscriptText } from "@/lib/text-cleanup";

interface PipelineProgressPayload {
  progress?: number;
  status?: string;
  file?: string;
}

import type { WordSegment } from "@/lib/export";

interface PipelineInvokeChunk {
  text?: string;
  timestamp?: [number, number];
  probability?: number;
  // some pipelines include per-word timestamps inside each chunk
  words?: Array<{ word?: string; start?: number; end?: number; timestamp?: [number, number]; probability?: number; score?: number }>;
}

interface PipelineInvokeResult {
  text?: string;
  chunks?: PipelineInvokeChunk[];
  // top-level words array is also possible
  words?: Array<{ word?: string; start?: number; end?: number; timestamp?: [number, number]; probability?: number; score?: number }>;
  [key: string]: unknown;
}

export interface CreatePipelineOptions {
  modelPreset: "fast" | "balanced" | "medium" | "quality" | "french" | "custom";
  customModelId: string;
  backendPreference: BackendImplementation;
  telemetry?: TelemetryCollector;
  onStatus?: (status: PipelineStatus, detail?: string) => void;
  onProgress?: (progress: number, status: string) => void;
}

export interface ChunkTranscriptionResult {
  chunk: ChunkDefinition;
  text: string;
  segments: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
    words?: WordSegment[];
  }>;
  processingMs: number;
  realtimeFactor: number;
}

export interface TranscribeChunkOptions {
  pipeline: AutomaticSpeechRecognitionPipeline;
  chunk: ChunkDefinition;
  pcm: Float32Array;
  sampleRate: number;
  telemetry?: TelemetryCollector;
  abortSignal?: AbortSignal;
}

const BACKEND_SEQUENCE: Record<BackendImplementation, BackendImplementation[]> = {
  webgpu: ["webgpu", "wasm"],
  wasm: ["wasm"],
};
const WEBGPU_SUPPORT_PROMISE = detectWebGpuSupport();
const WASM_PATH = "/onnx/";


async function forceSingleThreadedWasmEnv() {
  const module = await loadTransformers();
  const moduleEnv = (module as unknown as { env?: { backends?: { onnx?: { wasm?: Record<string, unknown> } } } }).env;
  const config = {
    numThreads: 1,
    proxy: true,
    simd: true,
    wasmPaths: WASM_PATH,
    useJsep: false,
  };

  if (moduleEnv?.backends?.onnx?.wasm && typeof moduleEnv.backends.onnx.wasm === "object") {
    Object.assign(moduleEnv.backends.onnx.wasm, config);
  }

  try {
    // Use the shared patch helper to modify the runtime env where the ort module is statically imported
    patchOrtWasmEnv(config);
  } catch (error) {
    logger.warn("Unable to patch onnxruntime env for single-threaded WASM", error);
  }

  return module;
}

export async function createAsrPipeline({
  modelPreset,
  customModelId,
  backendPreference,
  telemetry,
  onStatus,
  onProgress,
}: CreatePipelineOptions): Promise<{
  pipeline: AutomaticSpeechRecognitionPipeline;
  backend: BackendImplementation;
  modelId: string;
}> {
  const modelId = resolveModelId(modelPreset, customModelId);
  telemetry?.setRuntimeContext({ backend: backendPreference, modelId });
  onStatus?.("downloading", "Préparation du modèle");
  logger.info("ASR model load start", { modelId, backendPreference });
  telemetry?.logEvent("START_LOAD_MODEL", { modelId });
  telemetry?.startTimer("load_model_total");

  const backends = BACKEND_SEQUENCE[backendPreference];
  let lastError: unknown;

  // Track per-file fetch/cache diagnostics reported during model bootstrap
  const modelFetchMap = new Map<string, { cached?: boolean; transferSize?: number | null; encodedBodySize?: number | null }>();

  const webGpuAvailable = await WEBGPU_SUPPORT_PROMISE;
  useAsrStore.getState().setWebGpuSupport(webGpuAvailable);

  const wasmAvailable = useAsrStore.getState().wasmAvailable;
  let triedWasmNoThreads = false;

  function computeWasmOptions() {
    const forceSingle = useAsrStore.getState().forceSingleThread;
    const crossIsolated = typeof window !== "undefined" && ((window as unknown) as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
    let numThreads = 1;
    if (!forceSingle && crossIsolated && typeof navigator !== "undefined") {
      numThreads = Math.max(2, navigator.hardwareConcurrency || 2);
    }
    return {
      wasmPaths: WASM_PATH,
      numThreads,
      proxy: true,
      simd: true,
      useJsep: false,
    } as const;
  }

  for (const backend of backends) {
    if (backend === "webgpu" && !webGpuAvailable) {
      lastError = new Error("WebGPU non supporté");
      continue;
    }

    if (backend === "wasm" && !wasmAvailable) {
      lastError = new Error("WASM assets non disponibles (vérifiez /onnx/)");
      continue;
    }

    let attemptedThreads = 1;
    try {
      onStatus?.("loading", `Initialisation ${backend}`);
      const device = backend;
      const sessionOptions: Record<string, unknown> = { executionProviders: [backend] };

      if (backend === "wasm") {
        const wasmOptions = computeWasmOptions();
        attemptedThreads = wasmOptions.numThreads ?? 1;
        sessionOptions.executionProviders = [ { name: "wasm", options: wasmOptions } ];
        flagWasmSessionOptions(sessionOptions);
      }
      logger.debug("ASR session options", { backend, sessionOptions });
      logger.info("ASR pipeline init", { backend, modelId, device, sessionOptions });
      const { pipeline } = await loadTransformers();
      const createPipeline = pipeline as unknown as (
        task: string,
        model?: string,
        options?: Record<string, unknown>
      ) => Promise<AutomaticSpeechRecognitionPipeline>;
      const pipe = await createPipeline("automatic-speech-recognition", modelId, {
        device,
        session_options: sessionOptions,
        progress_callback: (data: PipelineProgressPayload) => {
          const progressValue = typeof data.progress === "number" ? data.progress : undefined;
          const statusValue = typeof data.status === "string" ? data.status : "loading";
          onProgress?.(progressValue ?? 0, statusValue);
          telemetry?.logEvent("PROGRESS_MODEL", {
            backend,
            progress: progressValue,
            status: statusValue,
            file: typeof data.file === "string" ? data.file : undefined,
          });

          // If we receive a file name in progress updates, attempt to inspect the
          // corresponding resource timing entry to determine whether the asset
          // was fetched over network (transferSize > 0) or served from cache
          // (transferSize === 0). We log this to telemetry and to console for
          // easier debugging of cache vs download behavior.
          if (typeof data.file === "string" && typeof performance !== "undefined") {
            const fileName = data.file as string;
            try {
              const entries = performance.getEntriesByName(fileName) as PerformanceResourceTiming[];
              let entry = entries && entries.length ? entries[entries.length - 1] : undefined;
              if (!entry) {
                // fallback: try to find resource whose URL ends with the file string
                const all = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
                entry = all.find((e) => e.name.endsWith(fileName));
              }
              if (entry) {
                const transferSize = (entry as PerformanceResourceTiming).transferSize ?? null;
                const encodedBodySize = (entry as PerformanceResourceTiming).encodedBodySize ?? null;
                const cached = typeof transferSize === "number" ? transferSize === 0 : undefined;
                telemetry?.logEvent("MODEL_FETCH", { file: fileName, cached, transferSize, encodedBodySize });
                logger.info("[model-fetch]", { file: fileName, cached, transferSize, encodedBodySize });
                // record into summary map
                modelFetchMap.set(fileName, { cached, transferSize, encodedBodySize });
              } else {
                telemetry?.logEvent("MODEL_FETCH", { file: fileName, cached: undefined });
                logger.info("[model-fetch] resource timing not found for", { file: fileName });
                modelFetchMap.set(fileName, { cached: undefined });
              }
            } catch (err) {
              logger.warn("[model-fetch] failed to inspect resource timing", err);
            }
          }
        },
      });

      telemetry?.stopTimer("load_model_total");
      telemetry?.logEvent("READY", { backend });
      telemetry?.setRuntimeContext({ backend, modelId });
      // report effective wasm threads to the store
      if (backend === "wasm") {
        try {
          useAsrStore.getState().setWasmThreads(attemptedThreads);
        } catch (err) { void err; }
        // If multithread was actually used, emit telemetry (no immediate toast here)
        if (attemptedThreads > 1) {
          if (telemetry?.logEvent) telemetry.logEvent("WASM_MULTITHREAD_AVAILABLE", { attemptedThreads });
        }
      }
      const mem = readMemoryUsage();
      if (mem) {
        logger.info("[transformers] JS heap after pipeline init", { backend, ...mem });
        telemetry?.logEvent("RAM_USAGE", { context: "transformers_worker", backend, ...mem });
      }
      const uaMem = await readTotalMemory();
      if (uaMem) {
        logger.info("[transformers] Total memory snapshot after init", { backend, ...uaMem });
        telemetry?.logEvent("RAM_USAGE", { context: "total_memory_snapshot", backend, ...uaMem });
      }

      // Summarize model fetch diagnostics collected during the bootstrap
      const fetches = Array.from(modelFetchMap.entries()).map(([file, info]) => ({ file, ...info }));
      if (fetches.length > 0) {
        const cachedCount = fetches.filter((f) => f.cached === true).length;
        const networkCount = fetches.filter((f) => f.cached === false).length;
        logger.info("[model-fetch-summary]", { total: fetches.length, downloaded: networkCount, cached: cachedCount, unknown: fetches.length - cachedCount - networkCount, details: fetches });
        telemetry?.logEvent("MODEL_FETCH", { summary: true, total: fetches.length, downloaded: networkCount, cached: cachedCount });
      } else {
        logger.info("[model-fetch-summary] no resource timing entries were captured for model assets");
      }

      logger.info("ASR model load success", { backend, modelId });
      onStatus?.("ready", `Backend ${backend}`);

      return { pipeline: pipe, backend, modelId };
    } catch (error) {
      logger.warn(`Échec initialisation backend ${backend}`, error);
      lastError = error;
      telemetry?.logEvent("ERROR", { backend, message: (error as Error).message });
      const friendly = backend === "wasm"
        ? `Erreur initialisation WASM : ${(error as Error).message}. Vérifiez que les fichiers WASM sont accessibles dans /onnx/ et que les en-têtes COOP/COEP sont configurés si vous utilisez des threads.`
        : (error as Error).message;
      onStatus?.("error", friendly);

      // If wasm init failed and we haven't tried a no-threads fallback, try it now.
      if (backend === "wasm" && !triedWasmNoThreads) {
        triedWasmNoThreads = true;

        // If we attempted multithread and it failed, log/telemetry/toast and persist fallback to single-thread
        if (attemptedThreads > 1) {
          logger.warn("WASM multithread failed, falling back to single-threaded mode");
          if (telemetry?.recordAlert) telemetry.recordAlert("WASM_MULTITHREAD_UNAVAILABLE", { attemptedThreads, message: (error as Error).message });
          try { toast("mode multithread indisponible sur cette plateforme"); } catch (err) { void err; }
          // Persist fallback so UI updates
          useAsrStore.getState().setForceSingleThread(true);
        }

        try {
          logger.info("Retrying WASM backend with single-threaded fallback");
          telemetry?.logEvent("ERROR", { backend: "wasm", message: "Tentative de reprise sans threads" });

          const module = await forceSingleThreadedWasmEnv();

          const device = backend;
          const sessionOptions2: Record<string, unknown> = {
            executionProviders: [
              {
                name: "wasm",
                options: {
                  wasmPaths: WASM_PATH,
                  numThreads: 1,
                  proxy: true,
                  simd: true,
                  useJsep: false,
                },
              },
            ],
          };
          flagWasmSessionOptions(sessionOptions2);

          const { pipeline: pipeline2 } = module;
          const createPipeline2 = pipeline2 as unknown as (
            task: string,
            model?: string,
            options?: Record<string, unknown>
          ) => Promise<AutomaticSpeechRecognitionPipeline>;

          const pipe2 = await createPipeline2("automatic-speech-recognition", modelId, {
            device,
            session_options: sessionOptions2,
            progress_callback: (data: PipelineProgressPayload) => {
              const progressValue = typeof data.progress === "number" ? data.progress : undefined;
              const statusValue = typeof data.status === "string" ? data.status : "loading";
              onProgress?.(progressValue ?? 0, statusValue);
              telemetry?.logEvent("PROGRESS_MODEL", {
                backend,
                progress: progressValue,
                status: statusValue,
                file: typeof data.file === "string" ? data.file : undefined,
              });
            },
          });
          telemetry?.stopTimer("load_model_total");
          telemetry?.logEvent("READY", { backend: `${backend}-single-thread` });
          telemetry?.setRuntimeContext({ backend: `${backend}-single-thread`, modelId });
          onStatus?.("ready", `Backend ${backend} (sans threads)`);

          return { pipeline: pipe2, backend, modelId };
        } catch (err2) {
          logger.warn("Retry WASM single-thread failed", err2);
          lastError = err2;
          telemetry?.logEvent("ERROR", { backend: "wasm-single-thread", message: (err2 as Error).message });
          onStatus?.("error", `Échec initialisation WASM en mode sans threads : ${(err2 as Error).message}`);
        }
      }
    }
  }
  telemetry?.stopTimer("load_model_total");

  // Provide a clearer error for the common case where no runtime backend is available
  const webGpuAvailableFinal = webGpuAvailable;
  const wasmAvailableFinal = useAsrStore.getState().wasmAvailable;
  let finalMessage = (lastError as Error)?.message ?? "Impossible de charger le pipeline ASR";
  if (!webGpuAvailableFinal && !wasmAvailableFinal) {
    finalMessage = "Aucun backend utilisable trouvé : WebGPU non supporté et fichiers WASM manquants ou inaccessibles (/onnx/). Vérifiez que les assets WASM ont bien été déployés et que les en-têtes COOP/COEP sont configurés pour permettre WASM multithread (SharedArrayBuffer).";
  } else if (!webGpuAvailableFinal && wasmAvailableFinal && lastError && (lastError as Error).message.includes("WASM")) {
    finalMessage = `Erreur d'initialisation WASM : ${(lastError as Error).message}. Vérifiez la disponibilité des assets et les en-têtes COOP/COEP.`;
  }

  logger.error("ASR backend selection failed", { webGpuAvailable: webGpuAvailableFinal, wasmAvailable: wasmAvailableFinal, lastError });
  telemetry?.logEvent("ERROR", { stage: "select_backend", webGpuAvailable: webGpuAvailableFinal, wasmAvailable: wasmAvailableFinal, message: finalMessage });

  throw new Error(finalMessage);
}

const PIPELINES_WITHOUT_CROSS = new WeakSet<object>();

export async function transcribeChunk({
  pipeline: asr,
  chunk,
  pcm,
  sampleRate,
  telemetry,
  abortSignal,
}: TranscribeChunkOptions): Promise<ChunkTranscriptionResult> {
  if (abortSignal?.aborted) {
    throw new Error("Transcription annulée");
  }
  telemetry?.logEvent("START_CHUNK", {
    chunkId: chunk.id,
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
  });
  logger.info("ASR chunk start", {
    id: chunk.id,
    index: chunk.index,
    start: chunk.start,
    end: chunk.end,
    duration: chunk.end - chunk.start,
    pcmLength: pcm.length,
  });
  telemetry?.startTimer(`chunk_${chunk.index}`);
  const startTime = performance.now();

  const invokeAsr = asr as unknown as (
    input: Float32Array,
    options?: Record<string, unknown>
  ) => Promise<PipelineInvokeResult>;

  const supportsWordTimestamps = !PIPELINES_WITHOUT_CROSS.has(asr);
  const enabledInSettings = useAsrStore.getState().enableWordTimestamps || useAsrStore.getState().showSegmentConfidence;

  const invokeOptions = {
    sampling_rate: sampleRate,
    // request word-level timestamps when enabled in settings (or when confidence display is requested) and supported
    return_timestamps: supportsWordTimestamps && enabledInSettings ? "word" : false,
    chunk_length_s: chunk.end - chunk.start,
    stride_length_s: chunk.paddedStart < chunk.start ? chunk.start - chunk.paddedStart : 0,
    language: "fr",
  } as const;

  let result: PipelineInvokeResult;
  try {
    result = await invokeAsr(pcm, { ...invokeOptions });
  } catch (error) {
    const message = (error as Error)?.message ?? "";
    const lacksCrossAttn = /cross attentions|output_attentions/i.test(message);
    if (!lacksCrossAttn) {
      throw error;
    }
    // Remember that this pipeline does not support cross-attention/word timestamps
    PIPELINES_WITHOUT_CROSS.add(asr);
    logger.warn("Model lacks cross attentions; will skip word timestamps for subsequent chunks");
    telemetry?.logEvent("WARN" as TelemetryEventType, { chunkId: chunk.id, reason: "no_cross_attention" });
    // Retry once without word timestamps for this chunk
    result = await invokeAsr(pcm, {
      ...invokeOptions,
      return_timestamps: false,
    });
  }

  // More thorough debug logs to inspect the raw pipeline output and discover where word timestamps may be
  try {
    logger.info("ASR invoke options", invokeOptions);

    const resultUnknown = result as unknown as Record<string, unknown>;
    const rawKeys = Object.keys(resultUnknown ?? {});
    const chunks = Array.isArray(resultUnknown?.chunks) ? (resultUnknown.chunks as Array<Record<string, unknown>>) : [];
    const topWords = Array.isArray(resultUnknown?.words) ? (resultUnknown.words as Array<Record<string, unknown>>) : [];

    logger.info("ASR raw result keys", rawKeys);
    logger.info("ASR raw result summary", {
      text: result?.text,
      chunkCount: chunks.length,
      topWordsCount: topWords.length,
    });

    if (chunks.length) {
      const sample = chunks.slice(0, 5);
      const chunkKeySet = new Set<string>();
      sample.forEach((c) => Object.keys(c || {}).forEach((k) => chunkKeySet.add(k)));
      logger.info("ASR chunk keys (sample)", Array.from(chunkKeySet));

      sample.forEach((c, i: number) => {
        const info: Record<string, unknown> = {};
        Object.keys(c || {}).forEach((k) => {
          const v = c[k];
          if (Array.isArray(v)) info[k] = `[array:${v.length}]`;
          else if (v && typeof v === "object") info[k] = `[object keys: ${Object.keys(v as Record<string, unknown>).slice(0, 6).join(",")}]`;
          else info[k] = typeof v;
        });
        info.textSample = String(c.text ?? "").slice(0, 200);
        logger.info(`ASR chunk[${i}] keys/types`, info);

        const wordsField = c["words"];
        if (Array.isArray(wordsField) && (wordsField as unknown[]).length) {
          logger.info(`ASR chunk[${i}] words sample`, (wordsField as unknown[]).slice(0, 10));
        }
      });
    }

    if (topWords.length) {
      logger.info("ASR top-level words sample", (topWords as unknown[]).slice(0, 20));
    } else {
      // look for alternative fields that might contain token/timestamp information
      const interesting = new Set<string>();
      const keyCandidates = ["tokens", "token_timestamps", "pieces", "word_timestamps", "timestamps", "timestamp_tokens"];
      keyCandidates.forEach((k) => {
        if (k in resultUnknown) interesting.add(k);
      });
      chunks.forEach((c) => Object.keys(c || {}).forEach((k) => {
        if (/token|piece|word|timestamp|time/i.test(k)) interesting.add(k);
      }));
      logger.info("ASR alternative fields detected", Array.from(interesting));
    }
  } catch (err) {
      logger.warn("Failed to log ASR raw result safely", err);
  }

  const cleanedText = cleanTranscriptText(result.text);
  logger.info("ASR chunk transcript", {
    id: chunk.id,
    index: chunk.index,
    text: cleanedText,
  });

  const processingMs = performance.now() - startTime;
  telemetry?.stopTimer(`chunk_${chunk.index}`);

  let outputSegments = Array.isArray(result.chunks)
    ? result.chunks
        .map((segment) => {
          const timestamp = Array.isArray(segment.timestamp) ? segment.timestamp : undefined;
          const rawStart = timestamp?.[0] ?? 0;
          const rawEnd = timestamp?.[1] ?? chunk.end - chunk.start;
          const sanitized = cleanTranscriptText(segment.text);

          // map any word-level timestamps inside this chunk segment
          const rawWordsField = (segment as unknown as Record<string, unknown>)["words"];
          const words: WordSegment[] | undefined = Array.isArray(rawWordsField)
            ? (rawWordsField as Array<Record<string, unknown>>)
                .map((wObj) => {
                  const w = wObj as Record<string, unknown>;
                  const wStart = typeof w.start === "number" ? w.start : (Array.isArray(w.timestamp) && typeof (w.timestamp as unknown[])[0] === "number" ? (w.timestamp as unknown[])[0] as number : 0);
                  const wEnd = typeof w.end === "number" ? w.end : (Array.isArray(w.timestamp) && typeof (w.timestamp as unknown[])[1] === "number" ? (w.timestamp as unknown[])[1] as number : wStart);
                  const wordText = typeof (w.word ?? w.text) === "string" ? String(w.word ?? w.text) : "";
                  const prob = typeof w.probability === "number" ? w.probability : typeof w.score === "number" ? w.score : undefined;
                  return {
                    word: wordText,
                    start: chunk.start + wStart,
                    end: chunk.start + wEnd,
                    confidence: prob as number | undefined,
                  } as WordSegment;
                })
                .filter((w) => w.word.length > 0)
            : undefined;

          return {
            start: chunk.start + rawStart,
            end: chunk.start + rawEnd,
            text: sanitized,
            confidence: segment.probability,
            words,
          };
        })
        .filter((segment) => segment.text.length > 0)
    : [
        {
          start: chunk.start,
          end: chunk.end,
          text: cleanedText,
          // if pipeline provided top-level words, map them
          words: Array.isArray(result.words)
            ? (result.words as Array<Record<string, unknown>>)
                .map((wObj) => {
                  const w = wObj as Record<string, unknown>;
                  const wStart = typeof w.start === "number" ? w.start : (Array.isArray(w.timestamp) && typeof (w.timestamp as unknown[])[0] === "number" ? (w.timestamp as unknown[])[0] as number : 0);
                  const wEnd = typeof w.end === "number" ? w.end : (Array.isArray(w.timestamp) && typeof (w.timestamp as unknown[])[1] === "number" ? (w.timestamp as unknown[])[1] as number : wStart);
                  const wordText = typeof (w.word ?? w.text) === "string" ? String(w.word ?? w.text) : "";
                  const prob = typeof w.probability === "number" ? w.probability : typeof w.score === "number" ? w.score : undefined;
                  return {
                    word: wordText,
                    start: chunk.start + wStart,
                    end: chunk.start + wEnd,
                    confidence: prob as number | undefined,
                  } as WordSegment;
                })
                .filter((w) => w.word.length > 0)
            : undefined,
        },
      ];

  if (outputSegments.length === 0) {
    outputSegments = [
      {
        start: chunk.start,
        end: chunk.end,
        text: cleanedText,
        words: undefined,
      },
    ];
  }

  const chunkDuration = Math.max(0.1, chunk.end - chunk.start);
  const realtimeFactor = processingMs / 1000 / chunkDuration;

  logger.info("ASR chunk done", {
    id: chunk.id,
    index: chunk.index,
    durationMs: processingMs,
    durationSec: Number((processingMs / 1000).toFixed(3)),
    realtimeFactor,
    speed: `x${realtimeFactor.toFixed(2)}`,
    segments: outputSegments.length,
  });

  telemetry?.logEvent("END_CHUNK", {
    chunkId: chunk.id,
    index: chunk.index,
    processingMs,
    realtimeFactor,
  });

  return {
    chunk,
    text: cleanedText,
    segments: outputSegments,
    processingMs,
    realtimeFactor,
  };
}

function readMemoryUsage() {
  if (typeof performance === "undefined") return null;
  const perf = performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit?: number } };
  const mem = perf.memory;
  if (!mem) return null;
  const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;
  return {
    usedMB: toMb(mem.usedJSHeapSize),
    totalMB: toMb(mem.totalJSHeapSize),
    limitMB: mem.jsHeapSizeLimit ? toMb(mem.jsHeapSizeLimit) : undefined,
  };
}

async function readTotalMemory() {
  const measure = (performance as unknown as { measureUserAgentSpecificMemory?: () => Promise<{
    bytes?: number;
    breakdown?: Array<{ bytes?: number; attribution?: unknown; types?: unknown }>;
  }> }).measureUserAgentSpecificMemory;
  if (typeof measure !== "function") return null;
  try {
    // bind correct this (measure must be called with Performance as receiver)
    const result = await measure.call(performance) as {
      bytes?: number;
      breakdown?: Array<{ bytes?: number; attribution?: unknown; types?: unknown }>;
    };
    const toMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 100) / 100;
    const breakdown = Array.isArray(result.breakdown)
      ? result.breakdown.map((item) => ({
          bytes: item?.bytes,
          attribution: item?.attribution,
          types: item?.types,
        }))
      : undefined;
    return {
      totalMB: toMb(result.bytes ?? 0),
      breakdown,
    };
  } catch (error) {
    logger.warn("measureUserAgentSpecificMemory failed", error);
    try {
      const telemetry = useAsrStore.getState().telemetryCollector;
      if (telemetry?.logEvent) telemetry.logEvent("WASM_MEMORY_MEASURE_FAILED", { message: String(error) });
    } catch (err) {
      void err;
    }
    return null;
  }
}

// Heuristic to detect errors that are likely caused by insufficient memory / model too large
export function isModelTooLargeError(err: unknown): boolean {
  try {
    let raw = "";
    if (err === undefined || err === null) {
      raw = "";
    } else if (typeof err === "object" && err !== null && "message" in err && typeof (err as { message?: unknown }).message === "string") {
      raw = String((err as { message?: unknown }).message);
    } else {
      raw = String(err);
    }
    const s = raw.toLowerCase();
    // include numeric error codes observed in the wild and common OOM messages
    return /1261431424|out of memory|oom|insufficient memory|memory limit|cannot allocate|js_out_of_memory|wasm memory/i.test(s);
  } catch (e) {
    void e;
    return false;
  }
}

export async function disposePipeline(pipe: GenericPipeline | undefined) {
  if (!pipe) return;
  try {
    await pipe.dispose?.();
  } catch (error) {
    logger.warn("Erreur lors de la libération du pipeline", error);
  }
}
