import { useCallback, useEffect, useRef, useState } from "react";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { createAsrPipeline, disposePipeline, isModelTooLargeError, transcribeChunk } from "@/lib/asr";
import { isWebGpuRuntimeIncompatibilityError } from "@/lib/asr-internals";
import { detectSilenceRegions } from "@/lib/silence";
import { computePreprocessParams, estimateNoiseProfileWithVad, preprocessPcmChunk } from "@/lib/preprocessing";
import type { ChunkDefinition } from "@/lib/chunking";
import type { TranscriptionSegment } from "@/lib/export";
import { TelemetryCollector } from "@/lib/telemetry";
import { toast } from "@/components/ui/use-toast";
import logger from "@/lib/logger";
import { MODEL_PRESETS, resolveLighterPresetForMemoryFallback, resolveModelId, useAsrStore } from "@/store/asr-store";
import { getFfmpeg } from "@/lib/ffmpeg-loader";
import { encodeWavBuffer, resampleMono } from "@/lib/audio";
import { createSessionTranscriptMemoryEntry } from "@/lib/sessionTranscriptMemory";
import {
  getSharedRunId,
  nextSharedRunId,
  normaliseSegments,
  setSharedAbortController,
} from "@/hooks/useTranscriptionController";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";

const DEFAULT_BUFFER_SIZE = 4096;
const MIN_DETECT_INTERVAL_MS = 250;
const MIN_METADATA_INTERVAL_MS = 800;
const FIXED_MIC_CHUNK_SEC = 15;
const MIC_DEBUG_AUDIO_LOG_INTERVAL_MS = 2000;
const MIC_NOISE_WINDOW_SEC = 3;
const MIC_NOISE_CALIBRATION_MS = (() => {
  const env = (import.meta as unknown as { env?: { MODE?: string } }).env;
  // Keep tests fast: calibration capture duration is not a product requirement.
  if (env?.MODE === "test") return 5;
  return 1500;
})();
const MIC_NOISE_THRESHOLD_MARGIN_DB = 6;
const MIC_ASR_SAMPLE_RATE = 16000;
const ERROR_STATUS_HOLD_MS = 10_000;

type PendingChunk = {
  chunk: ChunkDefinition;
  pcm: Float32Array;
  sampleRate: number;
};

type SegmentWindow = { startSec: number; endSec: number };

type MicAutoTuneParams = {
  noiseFloorDb: number;
  reductionDb: number;
  smoothing: number;
  targetLufs: number;
  highpassHz: number;
  lowpassHz: number;
  limiterThresholdDb: number;
  limiterSoftness: number;
  vadThresholdDb: number;
  overlapBlockSec: number;
  overlapSec: number;
  snrDb: number;
};

function round3(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(3));
}

function summariseSegmentWindows(windows: SegmentWindow[]) {
  const max = 6;
  const head = windows.slice(0, max).map((w) => ({ startSec: round3(w.startSec), endSec: round3(w.endSec) }));
  const tail = windows.length > max ? windows[windows.length - 1] : null;
  return {
    count: windows.length,
    head,
    tail: tail ? { startSec: round3(tail.startSec), endSec: round3(tail.endSec) } : null,
  };
}

function takeLastSamples(chunks: Float32Array[], sampleCount: number) {
  const target = Math.max(0, Math.floor(sampleCount));
  if (target === 0 || chunks.length === 0) return new Float32Array(0);
  const out = new Float32Array(target);
  let remaining = target;
  let writeOffset = target;
  for (let i = chunks.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const chunk = chunks[i];
    const copyCount = Math.min(remaining, chunk.length);
    writeOffset -= copyCount;
    out.set(chunk.subarray(chunk.length - copyCount), writeOffset);
    remaining -= copyCount;
  }
  if (remaining > 0) {
    return out.subarray(remaining);
  }
  return out;
}

function estimateNoiseDb(pcm: Float32Array, sampleRate: number) {
  if (!pcm.length || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;
  const frameSamples = Math.max(1, Math.floor(sampleRate * 0.02));
  const dbs: number[] = [];
  for (let offset = 0; offset + frameSamples <= pcm.length; offset += frameSamples) {
    let sumSquares = 0;
    for (let i = 0; i < frameSamples; i += 1) {
      const v = pcm[offset + i] ?? 0;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / frameSamples);
    if (rms <= 0) continue;
    const db = 20 * Math.log10(rms);
    if (Number.isFinite(db)) dbs.push(db);
  }
  if (!dbs.length) return null;
  dbs.sort((a, b) => a - b);
  const idx = Math.min(dbs.length - 1, Math.max(0, Math.floor(dbs.length * 0.9)));
  return dbs[idx] ?? null;
}

function appendFloat32(base: Float32Array, chunk: Float32Array) {
  if (base.length === 0) return chunk.slice();
  const merged = new Float32Array(base.length + chunk.length);
  merged.set(base, 0);
  merged.set(chunk, base.length);
  return merged;
}

function buildFixedSegments(durationSec: number, chunkSec: number, flush: boolean): SegmentWindow[] {
  if (durationSec <= 0 || chunkSec <= 0) return [];
  const segments: SegmentWindow[] = [];
  const fullCount = Math.floor(durationSec / chunkSec);
  const totalCount = flush ? Math.ceil(durationSec / chunkSec) : fullCount;
  for (let i = 0; i < totalCount; i += 1) {
    const start = i * chunkSec;
    const end = Math.min(durationSec, start + chunkSec);
    if (end <= start) continue;
    segments.push({ startSec: start, endSec: end });
  }
  return segments;
}

function buildStreamingSilenceSegments(
  regions: SegmentWindow[],
  minChunkSec: number,
  maxChunkSec: number,
  flush: boolean
): SegmentWindow[] {
  if (!regions.length) return [];
  const minSec = Math.max(0, minChunkSec);
  const maxSecRaw = Math.max(0, maxChunkSec);
  const maxSec = maxSecRaw > 0 && maxSecRaw < minSec ? minSec : maxSecRaw;

  const out: SegmentWindow[] = [];
  let openStart: number | null = null;
  let openEnd: number | null = null;

  const emit = (startSec: number, endSec: number) => {
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return;
    if (endSec <= startSec) return;
    out.push({ startSec, endSec });
  };

  for (const region of regions) {
    if (openStart === null || openEnd === null) {
      openStart = region.startSec;
      openEnd = region.endSec;
    } else {
      openEnd = Math.max(openEnd, region.endSec);
    }

    if (maxSec > 0 && openStart !== null && openEnd !== null) {
      while (openStart !== null && openEnd !== null && openEnd - openStart >= maxSec) {
        const start: number = openStart;
        const endLimit: number = openEnd;
        const cutEnd: number = start + maxSec;
        emit(start, cutEnd);
        openStart = cutEnd;
        if (cutEnd >= endLimit) {
          openStart = null;
          openEnd = null;
        }
      }
    }

    if (openStart !== null && openEnd !== null && openEnd - openStart >= minSec) {
      emit(openStart, openEnd);
      openStart = null;
      openEnd = null;
    }
  }

  if (flush && openStart !== null && openEnd !== null) {
    emit(openStart, openEnd);
  }

  return out;
}

function publishMicTranscriptMemory(segments: TranscriptionSegment[]) {
  const state = useAsrStore.getState();
  state.setSessionTranscriptMemory(
    "mic",
    createSessionTranscriptMemoryEntry({
      mode: "mic",
      provider: "mic",
      segments,
      audioSource: state.audioSource,
      audioMetadata: state.audioMetadata,
    })
  );
}

export function useMicTranscription() {
  const [isRecording, setIsRecording] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [isCalibratingNoise, setIsCalibratingNoise] = useState(false);
  const [noiseCalibrated, setNoiseCalibrated] = useState(false);
  const resetCounter = useAsrStore((state) => state.resetCounter);
  const noiseCalibratedRef = useRef(false);

  const isRecordingRef = useRef(false);
  const stopAfterQueueRef = useRef(false);
  const finishedRef = useRef(false);
  const runIdRef = useRef(0);
  const finishModeRef = useRef<"complete" | "abort" | "error">("complete");

  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const pendingWorkletFlushRef = useRef<(() => void) | null>(null);
  const handlePcmChunkRef = useRef<((chunk: Float32Array, rms?: number) => void) | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  const sampleRateRef = useRef<number | null>(null);
  const sourceRef = useRef<{ id: string; label: string; type: "mic" } | null>(null);

  const pipelineRef = useRef<AutomaticSpeechRecognitionPipeline | null>(null);
  const pipelinePromiseRef = useRef<Promise<AutomaticSpeechRecognitionPipeline> | null>(null);
  const telemetryRef = useRef<TelemetryCollector | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const pcmQueueRef = useRef<Float32Array[]>([]);
  const pcmProcessingRef = useRef(false);
  const pcmProcessingPromiseRef = useRef<Promise<void> | null>(null);
  const flushRequestedRef = useRef(false);
  const bufferPcmRef = useRef<Float32Array>(new Float32Array(0));
  const bufferStartSecRef = useRef(0);
  const lastDetectMsRef = useRef(0);
  const lastMetadataMsRef = useRef(0);

  const pendingChunksRef = useRef<PendingChunk[]>([]);
  const queueProcessingRef = useRef(false);
  const inFlightInferenceRef = useRef(0);
  const nextChunkIndexRef = useRef(0);
  const nextSegmentIndexRef = useRef(0);
  const lastSegmentRef = useRef<TranscriptionSegment | undefined>(undefined);
  const micAutoTuneParamsRef = useRef<MicAutoTuneParams | null>(null);

  const levelAnimationFrameRef = useRef<number | null>(null);
  const pendingLevelRef = useRef(0);
  const recordedChunksRef = useRef<Float32Array[]>([]);
  const lastRecordingBufferRef = useRef<Float32Array | null>(null);
  const lastRecordingSampleRateRef = useRef<number | null>(null);
  const [hasRecording, setHasRecording] = useState(false);
  const micLogRef = useRef({
    maxPendingChunks: 0,
    maxPcmQueue: 0,
    lastAudioLogMs: 0,
  });
  const errorResetTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const noiseChunksRef = useRef<Float32Array[]>([]);
  const noiseSamplesRef = useRef(0);

  const recordingStartRef = useRef<number | null>(null);

  const updateRecordingTimer = useCallback(() => {
    if (!recordingStartRef.current) return;
    const elapsed = Math.max(0, (Date.now() - recordingStartRef.current) / 1000);
    setRecordingSeconds(elapsed);
  }, []);

  const updateMicProgress = useCallback(() => {
    const state = useAsrStore.getState();
    const total = state.chunkPlan.length;
    const done = state.chunkMetrics.length;
    if (total > 0) {
      state.setProgress(Math.max(0, Math.min(1, done / total)));
    } else {
      state.setProgress(0);
    }
  }, []);

  useEffect(() => {
    if (!isRecording) return;
    updateRecordingTimer();
    const id = window.setInterval(updateRecordingTimer, 300);
    return () => window.clearInterval(id);
  }, [isRecording, updateRecordingTimer]);

  useEffect(() => {
    return () => {
      if (levelAnimationFrameRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame(levelAnimationFrameRef.current);
      }
      if (errorResetTimeoutRef.current !== null) {
        globalThis.clearTimeout(errorResetTimeoutRef.current);
        errorResetTimeoutRef.current = null;
      }
    };
  }, []);

  const clearErrorResetTimer = useCallback(() => {
    if (errorResetTimeoutRef.current !== null) {
      globalThis.clearTimeout(errorResetTimeoutRef.current);
      errorResetTimeoutRef.current = null;
    }
  }, []);

  const scheduleErrorReset = useCallback((runId: number) => {
    clearErrorResetTimer();
    errorResetTimeoutRef.current = globalThis.setTimeout(() => {
      errorResetTimeoutRef.current = null;
      if (runId !== getSharedRunId()) return;
      const snapshot = useAsrStore.getState();
      if (snapshot.isTranscribing || snapshot.status !== "error") return;
      snapshot.resetSession();
    }, ERROR_STATUS_HOLD_MS);
  }, [clearErrorResetTimer]);

  const resetLocalState = useCallback(() => {
    pcmQueueRef.current = [];
    bufferPcmRef.current = new Float32Array(0);
    bufferStartSecRef.current = 0;
    lastDetectMsRef.current = 0;
    lastMetadataMsRef.current = 0;
    pendingChunksRef.current = [];
    queueProcessingRef.current = false;
    pcmProcessingRef.current = false;
    pcmProcessingPromiseRef.current = null;
    flushRequestedRef.current = false;
    sampleRateRef.current = null;
    sourceRef.current = null;
    nextChunkIndexRef.current = 0;
    nextSegmentIndexRef.current = 0;
    lastSegmentRef.current = undefined;
    micAutoTuneParamsRef.current = null;
    setPendingCount(0);
    recordedChunksRef.current = [];
    lastRecordingBufferRef.current = null;
    lastRecordingSampleRateRef.current = null;
    setHasRecording(false);
    if (levelAnimationFrameRef.current !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(levelAnimationFrameRef.current);
      levelAnimationFrameRef.current = null;
    }
    pendingLevelRef.current = 0;
    setAudioLevel(0);
    micLogRef.current = { maxPendingChunks: 0, maxPcmQueue: 0, lastAudioLogMs: 0 };
    noiseChunksRef.current = [];
    noiseSamplesRef.current = 0;
  }, []);

  const scheduleAudioLevelUpdate = useCallback((value: number) => {
    pendingLevelRef.current = value;
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      if (levelAnimationFrameRef.current === null) {
        levelAnimationFrameRef.current = window.requestAnimationFrame(() => {
          setAudioLevel(pendingLevelRef.current);
          levelAnimationFrameRef.current = null;
        });
      }
    } else {
      setAudioLevel(value);
    }
  }, []);

  const captureRecordingBuffer = useCallback(() => {
    const sampleRate = sampleRateRef.current ?? 16000;
    if (!recordedChunksRef.current.length) {
      lastRecordingBufferRef.current = null;
      lastRecordingSampleRateRef.current = null;
      setHasRecording(false);
      return;
    }
    const merged = mergeFloat32Arrays(recordedChunksRef.current);
    lastRecordingBufferRef.current = merged;
    lastRecordingSampleRateRef.current = sampleRate;
    setHasRecording(true);
    recordedChunksRef.current = [];
  }, []);

  const cleanupCapture = useCallback(async () => {
    if (workletRef.current) {
      try {
        workletRef.current.port.onmessage = null;
      } catch (err) {
        void err;
      }
      try {
        workletRef.current.disconnect();
      } catch (err) {
        void err;
      }
    }
    if (processorRef.current) {
      try {
        processorRef.current.disconnect();
      } catch (err) {
        void err;
      }
      processorRef.current.onaudioprocess = null;
    }
    if (gainRef.current) {
      try {
        gainRef.current.disconnect();
      } catch (err) {
        void err;
      }
    }
    if (audioContextRef.current) {
      try {
        await audioContextRef.current.close();
      } catch (err) {
        void err;
      }
    }
    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        try {
          track.stop();
        } catch (err) {
          void err;
        }
      }
    }
    processorRef.current = null;
    workletRef.current = null;
    pendingWorkletFlushRef.current = null;
    gainRef.current = null;
    audioContextRef.current = null;
    mediaStreamRef.current = null;
  }, []);

  useEffect(() => {
    // When the user clicks the global "Réinitialiser" button we need to restore /mic
    // to the same state as a fresh page load (no recording, no calibration, no buffers).
    noiseCalibratedRef.current = false;
    setNoiseCalibrated(false);
    setIsCalibratingNoise(false);
    setIsStopping(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    stopAfterQueueRef.current = false;
    finishedRef.current = false;
    recordingStartRef.current = null;
    setRecordingSeconds(0);
    pendingWorkletFlushRef.current = null;
    clearErrorResetTimer();
    resetLocalState();
    void cleanupCapture();
  }, [cleanupCapture, clearErrorResetTimer, resetCounter, resetLocalState]);

  const ensurePipeline = useCallback(async () => {
    if (pipelineRef.current) return pipelineRef.current;
    const promise = pipelinePromiseRef.current;
    if (!promise) {
      throw new Error("Pipeline non initialisé");
    }
    return promise;
  }, []);

  const finishSession = useCallback(async (mode: "complete" | "abort" | "error") => {
    if (finishedRef.current) return;
    finishedRef.current = true;

    const state = useAsrStore.getState();
    const telemetry = telemetryRef.current;
    const pendingPipeline = pipelinePromiseRef.current;
    const resolvedPipeline = pipelineRef.current;
    logger.info("[mic] finish session", {
      mode,
      pendingChunks: pendingChunksRef.current.length,
      pcmQueue: pcmQueueRef.current.length,
      maxPendingChunks: micLogRef.current.maxPendingChunks,
      maxPcmQueue: micLogRef.current.maxPcmQueue,
    });

    try {
      if (mode !== "complete") {
        const start = Date.now();
        const timeoutMs = 30000;
        while (queueProcessingRef.current || pcmProcessingRef.current || inFlightInferenceRef.current > 0) {
          if (Date.now() - start >= timeoutMs) {
            logger.warn("[mic] finish session timeout waiting for in-flight work", {
              mode,
              queueProcessing: queueProcessingRef.current,
              pcmProcessing: pcmProcessingRef.current,
              inFlightInference: inFlightInferenceRef.current,
            });
            break;
          }
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 50));
        }
      }
      if (pipelineRef.current) {
        await disposePipeline(pipelineRef.current);
      }
    } catch (err) {
      logger.warn("[mic] pipeline dispose failed", err);
    } finally {
      pipelineRef.current = null;
      pipelinePromiseRef.current = null;
    }

    if (pendingPipeline && !resolvedPipeline) {
      pendingPipeline
        .then((pipeline) => disposePipeline(pipeline))
        .catch((err) => logger.warn("[mic] pending pipeline dispose failed", err));
    }

    if (telemetry && mode !== "abort") {
      telemetry.logEvent("STOPPED");
      state.setTelemetrySummary(telemetry.exportSummary());
    }

    try {
      if (mode !== "complete") {
        throw new Error("skip confidence summary");
      }
      const { computeOverallConfidence, computeOverallConfidenceSource } = await import("@/lib/confidence");
      const segments = useAsrStore.getState().segments;
      state.setTranscriptionConfidence(computeOverallConfidence(segments));
      state.setTranscriptionConfidenceSource(computeOverallConfidenceSource(segments));
    } catch (err) {
      logger.warn("[mic] confidence summary failed", err);
    }

    if (mode === "complete") {
      trackBackendActivityEvent({
        eventKind: "transcription",
        sourceMode: "local",
        provider: "mic",
        status: "success",
        meta: {
          source: "mic",
          backend: state.activeBackend ?? state.backendPreference,
        },
      });
      state.setStatus("ready", "Prêt");
      toast("Transcription micro terminée.");
    }
    if (mode === "error") {
      trackBackendActivityEvent({
        eventKind: "transcription",
        sourceMode: "local",
        provider: "mic",
        status: "error",
        meta: {
          source: "mic",
          backend: state.activeBackend ?? state.backendPreference,
        },
      });
      state.setIsTranscribing(false);
      state.resetStopRequest();
      state.registerTelemetry(null);
      scheduleErrorReset(runIdRef.current);
    } else {
      state.setIsTranscribing(false);
      state.resetStopRequest();
      state.registerTelemetry(null);
    }

    telemetryRef.current = null;
    abortControllerRef.current = null;
    setSharedAbortController(null);
    setIsStopping(false);
    setIsRecording(false);
    isRecordingRef.current = false;
    stopAfterQueueRef.current = false;
    recordingStartRef.current = null;
  }, [scheduleErrorReset]);

  const maybeFinish = useCallback(async () => {
    if (!stopAfterQueueRef.current) return;
    if (pcmProcessingRef.current) return;
    if (queueProcessingRef.current) return;
    if (pendingChunksRef.current.length > 0) return;
    if (isRecordingRef.current) return;
    await finishSession(finishModeRef.current);
  }, [finishSession]);

  const transcribeQueuedChunk = useCallback(
    async (item: PendingChunk, pipeline: AutomaticSpeechRecognitionPipeline) => {
      const state = useAsrStore.getState();
      const telemetry = telemetryRef.current ?? undefined;
      let pcm = item.pcm;
      let sampleRate = item.sampleRate;
      const chunkDurationSec = Math.max(0, item.chunk.end - item.chunk.start);

      if (sampleRate !== MIC_ASR_SAMPLE_RATE) {
        const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
        try {
          const resampled = await resampleMono(pcm, sampleRate, MIC_ASR_SAMPLE_RATE);
          pcm = resampled;
          sampleRate = MIC_ASR_SAMPLE_RATE;
          const endedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
          logger.debug("[mic][resample] done", {
            from: item.sampleRate,
            to: MIC_ASR_SAMPLE_RATE,
            inputSamples: item.pcm.length,
            outputSamples: pcm.length,
            durationMs: Math.round(endedAt - startedAt),
          });
        } catch (err) {
          logger.warn("[mic][resample] failed; using original sample rate", err);
        }
      }

      logger.info("[mic][chunk] start", {
        chunkIndex: item.chunk.index,
        chunkId: item.chunk.id,
        startSec: round3(item.chunk.start),
        endSec: round3(item.chunk.end),
        durationSec: round3(chunkDurationSec),
        pcmSamples: pcm.length,
        sampleRate,
        pendingChunks: pendingChunksRef.current.length,
      });

      const shouldAutoTune = state.micAutoTunePreprocess;
      if (shouldAutoTune && !micAutoTuneParamsRef.current) {
        logger.debug("[mic][autotune] calibration start", {
          calibrationSeconds: state.micDenoiseCalibrationSeconds,
          vadThresholdDb: state.micPreprocessVadThresholdDb,
          vadMinSilenceMs: state.micPreprocessVadMinSilenceMs,
        });
        try {
          const calibrationSeconds = state.micDenoiseCalibrationSeconds;
          const calibrationSamples = Math.min(
            pcm.length,
            Math.max(1, Math.floor(calibrationSeconds * sampleRate))
          );
          const { profile, frames, vadUsed, silenceRanges } = estimateNoiseProfileWithVad(
            pcm,
            sampleRate,
            calibrationSeconds,
            state.micPreprocessVadThresholdDb,
            state.micPreprocessVadMinSilenceMs
          );
          const tune = computePreprocessParams(profile, pcm.subarray(0, calibrationSamples));
          micAutoTuneParamsRef.current = {
            noiseFloorDb: tune.noiseFloorDb,
            reductionDb: tune.reductionDb,
            smoothing: tune.smoothing,
            targetLufs: tune.targetLufs,
            highpassHz: tune.highpassHz,
            lowpassHz: tune.lowpassHz,
            limiterThresholdDb: tune.limiterThresholdDb,
            limiterSoftness: tune.limiterSoftness,
            vadThresholdDb: tune.vadThresholdDb,
            overlapBlockSec: tune.overlapBlockSec,
            overlapSec: tune.overlapSec,
            snrDb: tune.snrDb,
          };
          telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
            frames,
            source: "mic_autotune",
            vadUsed,
            silenceRanges,
          });
          telemetry?.logEvent("PREPROCESS_AUTOTUNE", {
            source: "mic_first_chunk",
            snrDb: tune.snrDb,
            noiseFloorDb: tune.noiseFloorDb,
            reductionDb: tune.reductionDb,
            smoothing: tune.smoothing,
            targetLufs: tune.targetLufs,
            highpassHz: tune.highpassHz,
            lowpassHz: tune.lowpassHz,
            limiterThresholdDb: tune.limiterThresholdDb,
            limiterSoftness: tune.limiterSoftness,
            vadThresholdDb: tune.vadThresholdDb,
            overlapBlockSec: tune.overlapBlockSec,
            overlapSec: tune.overlapSec,
          });
          logger.debug("[mic][autotune] applied", { snrDb: tune.snrDb });
        } catch (err) {
          logger.warn("[mic][autotune] failed", err);
          telemetry?.recordAlert?.("PREPROCESS_AUTOTUNE_FAILED", { message: String(err) });
        }
      }

      const autoTuneParams = shouldAutoTune ? micAutoTuneParamsRef.current : null;
      const micPreprocessMode = state.micPreprocessingMode;
      const preprocessStart = typeof performance !== "undefined" ? performance.now() : Date.now();
      try {
        logger.debug("[mic][preprocess] start", {
          mode: micPreprocessMode,
          pcmSamples: pcm.length,
          sampleRate,
          enableFilters: state.micPreprocessEnableFilters,
          enableLufs: state.micPreprocessEnableLufs,
          limiterEnabled: state.micPreprocessLimiterEnabled,
          vadEnabled: state.micPreprocessVadEnabled,
          overlapAdd: state.micPreprocessOverlapAdd,
          autoTune: Boolean(autoTuneParams),
        });
        const processed = await preprocessPcmChunk(
          pcm,
          sampleRate,
          {
            noiseFloorDb: autoTuneParams?.noiseFloorDb ?? state.micDenoiseNoiseFloorDb,
            reductionDb: autoTuneParams?.reductionDb ?? state.micDenoiseReductionDb,
            smoothing: autoTuneParams?.smoothing ?? state.micDenoiseSmoothing,
            calibrationSeconds: state.micDenoiseCalibrationSeconds,
            noiseProfile: undefined,
            preprocessEnableFilters: state.micPreprocessEnableFilters,
            preprocessHighpassHz: autoTuneParams?.highpassHz ?? state.micPreprocessHighpassHz,
            preprocessLowpassHz: autoTuneParams?.lowpassHz ?? state.micPreprocessLowpassHz,
            preprocessEnableLufs: state.micPreprocessEnableLufs,
            preprocessTargetLufs: autoTuneParams?.targetLufs ?? state.micPreprocessTargetLufs,
            preprocessLimiterEnabled: state.micPreprocessLimiterEnabled,
            preprocessLimiterThresholdDb:
              autoTuneParams?.limiterThresholdDb ?? state.micPreprocessLimiterThresholdDb,
            preprocessLimiterSoftness:
              autoTuneParams?.limiterSoftness ?? state.micPreprocessLimiterSoftness,
            preprocessVadEnabled: state.micPreprocessVadEnabled,
            preprocessVadThresholdDb:
              autoTuneParams?.vadThresholdDb ?? state.micPreprocessVadThresholdDb,
            preprocessVadMinSilenceMs: state.micPreprocessVadMinSilenceMs,
            preprocessOverlapAdd: state.micPreprocessOverlapAdd,
            preprocessOverlapBlockSec:
              autoTuneParams?.overlapBlockSec ?? state.micPreprocessOverlapBlockSec,
            preprocessOverlapSec: autoTuneParams?.overlapSec ?? state.micPreprocessOverlapSec,
          },
          telemetry,
          { mode: micPreprocessMode }
        );
        pcm = processed.pcm;
        sampleRate = processed.sampleRate;
        const preprocessEnd = typeof performance !== "undefined" ? performance.now() : Date.now();
        logger.debug("[mic][preprocess] done", {
          durationMs: Math.round(preprocessEnd - preprocessStart),
          pcmSamples: pcm.length,
          sampleRate,
        });
      } catch (err) {
        logger.warn("[mic] preprocess chunk failed", err);
      }

      logger.info("[mic][transcribe] start", {
        chunkIndex: item.chunk.index,
        durationSec: round3(chunkDurationSec),
        sampleRate,
        pcmSamples: pcm.length,
        enableWordTimestamps: state.micEnableWordTimestamps,
        showSegmentConfidence: state.micShowSegmentConfidence,
        abortRequested: Boolean(abortControllerRef.current?.signal.aborted),
      });
      inFlightInferenceRef.current += 1;
      let result: Awaited<ReturnType<typeof transcribeChunk>>;
      try {
        result = await transcribeChunk({
          pipeline,
          chunk: item.chunk,
          pcm,
          sampleRate,
          telemetry,
          abortSignal: abortControllerRef.current?.signal,
          enableWordTimestamps: state.micEnableWordTimestamps,
          showSegmentConfidence: state.micShowSegmentConfidence,
        });
      } finally {
        inFlightInferenceRef.current = Math.max(0, inFlightInferenceRef.current - 1);
      }
      logger.info("[mic][transcribe] done", {
        chunkIndex: item.chunk.index,
        processingMs: result.processingMs,
        realtimeFactor: result.realtimeFactor,
        textLength: result.text?.length ?? 0,
      });

      const segments = normaliseSegments(
        result,
        state.micSegmentationMode,
        nextSegmentIndexRef.current,
        lastSegmentRef.current,
        { enableWordTimestamps: state.micEnableWordTimestamps, dedupeMode: state.dedupeMode }
      );

      if (segments.length) {
        nextSegmentIndexRef.current += segments.length;
        lastSegmentRef.current = segments[segments.length - 1];
        state.appendSegments(segments);
        publishMicTranscriptMemory(useAsrStore.getState().segments);
      }
      logger.debug("[mic][segments] normalised", {
        chunkIndex: item.chunk.index,
        appendedSegments: segments.length,
        nextSegmentIndex: nextSegmentIndexRef.current,
        lastSegmentEndSec: lastSegmentRef.current ? round3(lastSegmentRef.current.end) : null,
      });

      const metric = {
        id: item.chunk.id,
        index: item.chunk.index,
        startSec: item.chunk.start,
        endSec: item.chunk.end,
        transcriptionMs: result.processingMs,
        realtimeFactor: result.realtimeFactor,
        text: result.text,
      };
      telemetry?.pushChunkMetric(metric);
      state.pushChunkMetric(metric);
      updateMicProgress();
    },
    [updateMicProgress]
  );

  const processTranscriptionQueue = useCallback(async () => {
    if (queueProcessingRef.current) return;
    queueProcessingRef.current = true;
    try {
      const pipeline = await ensurePipeline();
      logger.debug("[mic][queue] pump start", { pendingChunks: pendingChunksRef.current.length });

      while (pendingChunksRef.current.length > 0) {
        const controller = abortControllerRef.current;
        if (controller?.signal.aborted) {
          logger.info("[mic][queue] pump aborted");
          break;
        }
        if (runIdRef.current !== getSharedRunId()) {
          logger.info("[mic][queue] pump run changed", { runId: runIdRef.current, sharedRunId: getSharedRunId() });
          break;
        }

        const next = pendingChunksRef.current.shift();
        if (!next) break;
        setPendingCount(pendingChunksRef.current.length);
        logger.debug("[mic][queue] dequeue", {
          chunkIndex: next.chunk.index,
          pendingChunks: pendingChunksRef.current.length,
        });
        await transcribeQueuedChunk(next, pipeline);

        const state = useAsrStore.getState();
        if (state.stopRequested) {
          if (state.status !== "stopping") {
            state.setStatus("stopping", "Arrêt après le chunk courant");
          }
          logger.info("[mic][queue] stop requested; stopping after current chunk", {
            pendingChunks: pendingChunksRef.current.length,
            inFlight: inFlightInferenceRef.current,
          });
          pendingChunksRef.current = [];
          setPendingCount(0);
          stopAfterQueueRef.current = true;
          break;
        }
      }
    } catch (error) {
      const state = useAsrStore.getState();
      logger.error("[mic] transcription failed", error);
      const message = (error as Error)?.message ?? String(error);
      if (isModelTooLargeError(error)) {
        const fallbackPreset = resolveLighterPresetForMemoryFallback(state.micActivePreset, state.blockedPresets);
        if (fallbackPreset) {
          const previousPreset = state.micActivePreset;
          state.setMicPreset(fallbackPreset);
          logger.warn("[memory-fallback] switched mic preset after OOM", {
            from: previousPreset,
            to: fallbackPreset,
            message,
          });
          const fallbackLabel = MODEL_PRESETS[fallbackPreset].label;
          const friendly = `Erreur mémoire (modèle trop gros pour cette plateforme). Preset micro basculé automatiquement vers "${fallbackLabel}". Relancez l'enregistrement.`;
          state.setStatus("error", friendly);
          toast(friendly);
        } else {
          const friendly =
            "Erreur : modèle trop gros pour cette plateforme (mémoire insuffisante). Aucun preset plus léger n'est disponible, activez le mode single-thread ou utilisez un modèle custom plus petit.";
          state.setStatus("error", friendly);
          toast(friendly);
        }
      } else if (isWebGpuRuntimeIncompatibilityError(error)) {
        const ranOnWebGpu = state.activeBackend === "webgpu" || state.micBackendPreference === "webgpu";
        const canSwitchToWasm = ranOnWebGpu && state.wasmAvailable;
        if (canSwitchToWasm) {
          state.setMicBackendPreference("wasm");
          logger.warn("[webgpu-fallback] switched mic backend preference to wasm after runtime incompatibility", {
            previousPreference: state.micBackendPreference,
            activeBackend: state.activeBackend,
            message,
          });
        }
        telemetryRef.current?.recordAlert?.("ASR_WEBGPU_RUNTIME_INCOMPATIBLE", {
          source: "mic",
          activeBackend: state.activeBackend,
          backendPreference: state.micBackendPreference,
          wasmAvailable: state.wasmAvailable,
          message,
        });
        const friendly = canSwitchToWasm
          ? "Erreur runtime WebGPU (ONNX) : incompatibilité de forme interne detectee (component=4). La preference micro a ete basculee vers WASM. Relancez l'enregistrement."
          : "Erreur runtime WebGPU (ONNX) : incompatibilité de forme interne detectee (component=4). WASM est indisponible, verifiez les assets /onnx/ ou utilisez un autre modele.";
        state.setStatus("error", friendly);
        toast(friendly);
      } else {
        state.setStatus("error", message);
        toast(`Échec de la transcription : ${message}`);
      }
      finishModeRef.current = "error";
      stopAfterQueueRef.current = true;
      pendingChunksRef.current = [];
      setPendingCount(0);
      isRecordingRef.current = false;
      setIsRecording(false);
      setIsStopping(false);
      await cleanupCapture();
    } finally {
      queueProcessingRef.current = false;
    }
    if (pendingChunksRef.current.length > 0) {
      void processTranscriptionQueue();
      return;
    }
    logger.debug("[mic][queue] pump idle", { pendingChunks: pendingChunksRef.current.length });
    await maybeFinish();
  }, [cleanupCapture, ensurePipeline, maybeFinish, transcribeQueuedChunk]);

  const queueSegments = useCallback((segments: Array<{ startSec: number; endSec: number }>, sampleRate: number) => {
    if (!segments.length) return;
    const state = useAsrStore.getState();
    const buffer = bufferPcmRef.current;
    const offset = bufferStartSecRef.current;
    const queuedChunks: ChunkDefinition[] = [];
    const pendingBefore = pendingChunksRef.current.length;
    let skippedEmpty = 0;

    logger.debug("[mic][queue] enqueue segments", {
      segments: summariseSegmentWindows(segments),
      sampleRate,
      bufferOffsetSec: round3(offset),
      bufferSamples: buffer.length,
      pendingBefore,
    });

    for (const segment of segments) {
      const startSample = Math.max(0, Math.floor(segment.startSec * sampleRate));
      const endSample = Math.min(buffer.length, Math.ceil(segment.endSec * sampleRate));
      if (endSample <= startSample) continue;

      const pcm = buffer.slice(startSample, endSample);
      if (!pcm.length) {
        skippedEmpty += 1;
        continue;
      }

      const chunk: ChunkDefinition = {
        id: crypto.randomUUID(),
        index: nextChunkIndexRef.current,
        start: offset + segment.startSec,
        end: offset + segment.endSec,
        paddedStart: offset + segment.startSec,
        paddedEnd: offset + segment.endSec,
      };
      nextChunkIndexRef.current += 1;

      pendingChunksRef.current.push({ chunk, pcm, sampleRate });
      queuedChunks.push(chunk);
    }

    if (queuedChunks.length) {
      micLogRef.current.maxPendingChunks = Math.max(micLogRef.current.maxPendingChunks, pendingChunksRef.current.length);
      logger.debug("[mic][queue] enqueued chunks", {
        queued: queuedChunks.length,
        skippedEmpty,
        pendingAfter: pendingChunksRef.current.length,
        maxPending: micLogRef.current.maxPendingChunks,
        firstChunk: queuedChunks[0]
          ? {
              index: queuedChunks[0].index,
              startSec: round3(queuedChunks[0].start),
              endSec: round3(queuedChunks[0].end),
            }
          : null,
        lastChunk: queuedChunks[queuedChunks.length - 1]
          ? {
              index: queuedChunks[queuedChunks.length - 1].index,
              startSec: round3(queuedChunks[queuedChunks.length - 1].start),
              endSec: round3(queuedChunks[queuedChunks.length - 1].end),
            }
          : null,
      });
      state.setChunkPlan([...state.chunkPlan, ...queuedChunks]);
      setPendingCount(pendingChunksRef.current.length);
      updateMicProgress();
      void processTranscriptionQueue();
    } else {
      logger.debug("[mic][queue] no chunks enqueued", { skippedEmpty, pendingAfter: pendingChunksRef.current.length });
    }
  }, [processTranscriptionQueue, updateMicProgress]);

  const finalizeSegments = useCallback(
    (flush: boolean) => {
      const state = useAsrStore.getState();
      const sampleRate = sampleRateRef.current;
      const buffer = bufferPcmRef.current;
      if (!sampleRate || buffer.length === 0) return;

      const durationSec = buffer.length / sampleRate;
      let segments: SegmentWindow[];

      if (state.micSegmentationMode === "silence") {
        logger.debug("[mic][segment] detect(silence) start", {
          flush,
          bufferDurationSec: round3(durationSec),
          bufferSamples: buffer.length,
          sampleRate,
          silenceThresholdDb: state.micSilenceThresholdDb,
          minSilenceMs: state.micMinSilenceMs,
          minChunkMs: state.micMinChunkMs,
          maxChunkMs: state.micMaxChunkMs,
        });
        segments = detectSilenceRegions(buffer, {
          sampleRate,
          silenceThresholdDb: state.micSilenceThresholdDb,
          minSilenceMs: state.micMinSilenceMs,
          minChunkMs: state.micMinChunkMs,
          maxChunkMs: state.micMaxChunkMs,
        });

        if (!segments.length) {
          logger.debug("[mic][segment] detect(silence) none", { flush, bufferDurationSec: round3(durationSec) });
          return;
        }

        let ready = segments;
        if (!flush) {
          const last = segments[segments.length - 1];
          const minSilenceSec = state.micMinSilenceMs / 1000;
          if (durationSec - last.endSec < minSilenceSec) {
            ready = segments.slice(0, -1);
          }
        }

        if (!ready.length) {
          logger.debug("[mic][segment] detect(silence) waiting for trailing silence", {
            bufferDurationSec: round3(durationSec),
            detected: summariseSegmentWindows(segments),
          });
          return;
        }
        const minChunkSec = state.micMinChunkMs / 1000;
        const maxChunkSec = state.micMaxChunkMs / 1000;
        const bounded = buildStreamingSilenceSegments(ready, minChunkSec, maxChunkSec, flush);
        if (!bounded.length) {
          logger.debug("[mic][segment] detect(silence) waiting for min chunk duration", {
            flush,
            minChunkSec: round3(minChunkSec),
            maxChunkSec: round3(maxChunkSec),
            ready: summariseSegmentWindows(ready),
          });
          return;
        }
        segments = bounded;
      } else {
        logger.debug("[mic][segment] detect(fixed) start", {
          flush,
          chunkSec: FIXED_MIC_CHUNK_SEC,
          bufferDurationSec: round3(durationSec),
        });
        segments = buildFixedSegments(durationSec, FIXED_MIC_CHUNK_SEC, flush);
        if (!segments.length) {
          logger.debug("[mic][segment] detect(fixed) none", { flush, bufferDurationSec: round3(durationSec) });
          return;
        }
      }

      logger.debug("[mic][segment] ready", {
        flush,
        mode: state.micSegmentationMode,
        segments: summariseSegmentWindows(segments),
        bufferStartSec: round3(bufferStartSecRef.current),
      });
      queueSegments(segments, sampleRate);

      const last = segments[segments.length - 1];
      const dropSamples = Math.min(buffer.length, Math.floor(last.endSec * sampleRate));
      bufferPcmRef.current = buffer.slice(dropSamples);
      bufferStartSecRef.current += dropSamples / sampleRate;
      logger.debug("[mic][segment] buffer advanced", {
        dropSamples,
        newBufferStartSec: round3(bufferStartSecRef.current),
        remainingSamples: bufferPcmRef.current.length,
      });
    },
    [queueSegments]
  );

  const processPcmQueue = useCallback(
    (flush: boolean) => {
      if (flush) {
        flushRequestedRef.current = true;
        logger.debug("[mic][pcm] flush requested", {
          pcmQueue: pcmQueueRef.current.length,
          bufferSamples: bufferPcmRef.current.length,
          bufferStartSec: round3(bufferStartSecRef.current),
        });
      }
      if (pcmProcessingPromiseRef.current) {
        return pcmProcessingPromiseRef.current;
      }

      pcmProcessingRef.current = true;
      pcmProcessingPromiseRef.current = (async () => {
        const sampleRate = sampleRateRef.current;
        if (!sampleRate) return;
        try {
          while (pcmQueueRef.current.length > 0) {
            const chunk = pcmQueueRef.current.shift();
            if (!chunk) continue;
            bufferPcmRef.current = appendFloat32(bufferPcmRef.current, chunk);
            micLogRef.current.maxPcmQueue = Math.max(micLogRef.current.maxPcmQueue, pcmQueueRef.current.length);

            const now = Date.now();
            if (now - micLogRef.current.lastAudioLogMs >= MIC_DEBUG_AUDIO_LOG_INTERVAL_MS) {
              micLogRef.current.lastAudioLogMs = now;
              logger.debug("[mic][pcm] status", {
                bufferSamples: bufferPcmRef.current.length,
                bufferDurationSec: round3(bufferPcmRef.current.length / sampleRate),
                bufferStartSec: round3(bufferStartSecRef.current),
                pcmQueue: pcmQueueRef.current.length,
                maxPcmQueue: micLogRef.current.maxPcmQueue,
                pendingChunks: pendingChunksRef.current.length,
                maxPendingChunks: micLogRef.current.maxPendingChunks,
              });
            }
            if (now - lastDetectMsRef.current >= MIN_DETECT_INTERVAL_MS) {
              lastDetectMsRef.current = now;
              finalizeSegments(false);
            }

            if (now - lastMetadataMsRef.current >= MIN_METADATA_INTERVAL_MS) {
              lastMetadataMsRef.current = now;
              const durationSec = bufferStartSecRef.current + bufferPcmRef.current.length / sampleRate;
              const source = sourceRef.current;
              if (source) {
                useAsrStore.getState().registerAudioSource(source, {
                  durationSec,
                  sampleRate,
                  channels: 1,
                });
              }
            }
          }

          if (flush || flushRequestedRef.current) {
            flushRequestedRef.current = false;
            finalizeSegments(true);
          }
        } catch (err) {
          logger.error("[mic][pcm] processing failed", err);
          throw err;
        }
      })().finally(() => {
        pcmProcessingRef.current = false;
        pcmProcessingPromiseRef.current = null;
      });

      return pcmProcessingPromiseRef.current;
    },
    [finalizeSegments]
  );

  const handlePcmChunk = useCallback(
    (chunk: Float32Array, rms?: number) => {
      if (!isRecordingRef.current && !stopAfterQueueRef.current) return;
      recordedChunksRef.current.push(chunk);

      const sampleRate = sampleRateRef.current;
      if (sampleRate) {
        noiseChunksRef.current.push(chunk);
        noiseSamplesRef.current += chunk.length;
        const maxSamples = Math.floor(MIC_NOISE_WINDOW_SEC * sampleRate);
        if (noiseSamplesRef.current > maxSamples) {
          const trimmed = takeLastSamples(noiseChunksRef.current, maxSamples);
          noiseChunksRef.current = trimmed.length ? [trimmed] : [];
          noiseSamplesRef.current = trimmed.length;
        }
      }

      let computedRms = rms;
      if (typeof computedRms !== "number") {
        let sumSquares = 0;
        for (let i = 0; i < chunk.length; i += 1) {
          const value = chunk[i] ?? 0;
          sumSquares += value * value;
        }
        computedRms = chunk.length ? Math.sqrt(sumSquares / chunk.length) : 0;
      }

      scheduleAudioLevelUpdate(Math.min(1, (computedRms ?? 0) * 12));
      pcmQueueRef.current.push(chunk);
      void processPcmQueue(false);
    },
    [processPcmQueue, scheduleAudioLevelUpdate]
  );
  handlePcmChunkRef.current = handlePcmChunk;

  const handleAudioProcess = useCallback(
    (event: AudioProcessingEvent) => {
      const input = event.inputBuffer.getChannelData(0);
      const chunk = new Float32Array(input.length);
      chunk.set(input);
      handlePcmChunkRef.current?.(chunk);
    },
    []
  );

  const calibrateSilenceThreshold = useCallback(async () => {
    if (isCalibratingNoise) return;
    setIsCalibratingNoise(true);
    const state = useAsrStore.getState();
    const env = (import.meta as unknown as { env?: { MODE?: string } }).env;
    try {
      const durationMs = MIC_NOISE_CALIBRATION_MS;
      const marginDb =
        typeof state.micNoiseCalibrationMarginDb === "number" && Number.isFinite(state.micNoiseCalibrationMarginDb)
          ? state.micNoiseCalibrationMarginDb
          : MIC_NOISE_THRESHOLD_MARGIN_DB;
      logger.info("[mic][noise-calibration] start", {
        durationMs,
        marginDb,
        isRecording: isRecordingRef.current,
      });

      let pcm: Float32Array | null = null;
      let sampleRate: number | null = sampleRateRef.current ?? null;

      if (env?.MODE === "test" && !isRecordingRef.current) {
        const sr = sampleRate ?? 1000;
        sampleRate = sr;
        pcm = new Float32Array(Math.max(1, Math.floor(sr * 0.2))).fill(0.01);
      } else
      if (isRecordingRef.current && sampleRate) {
        const needSamples = Math.floor((durationMs / 1000) * sampleRate);
        pcm = takeLastSamples(noiseChunksRef.current, needSamples);
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
          const ctx = new AudioContext();
          try {
            await ctx.resume();
            sampleRate = ctx.sampleRate;
            const chunks: Float32Array[] = [];
            const source = ctx.createMediaStreamSource(stream);
            const gain = ctx.createGain();
            gain.gain.value = 0;

            if (ctx.audioWorklet && typeof ctx.audioWorklet.addModule === "function") {
              await ctx.audioWorklet.addModule(new URL("../worklets/mic-capture.worklet.ts", import.meta.url));
              const node = new AudioWorkletNode(ctx, "mic-capture", {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                channelCount: 1,
              });
              node.port.onmessage = (event) => {
                const data = event.data as { type?: string; pcm?: Float32Array };
                if (data?.type === "chunk" && data.pcm instanceof Float32Array) {
                  chunks.push(data.pcm);
                }
              };
              source.connect(node);
              node.connect(gain);
              gain.connect(ctx.destination);
              await new Promise<void>((resolve) => {
                window.setTimeout(() => resolve(), durationMs);
              });
              await new Promise<void>((resolve) => {
                node.port.onmessage = (event) => {
                  const data = event.data as { type?: string; pcm?: Float32Array };
                  if (data?.type === "chunk" && data.pcm instanceof Float32Array) {
                    chunks.push(data.pcm);
                    return;
                  }
                  if (data?.type === "flushed") {
                    resolve();
                  }
                };
                node.port.postMessage({ type: "flush" });
              });
              try {
                node.disconnect();
              } catch (err) {
                void err;
              }
              try {
                gain.disconnect();
              } catch (err) {
                void err;
              }
              pcm = mergeFloat32Arrays(chunks);
            } else {
              const processor = ctx.createScriptProcessor(DEFAULT_BUFFER_SIZE, 1, 1);
              source.connect(processor);
              processor.connect(gain);
              gain.connect(ctx.destination);
              processor.onaudioprocess = (event) => {
                const input = event.inputBuffer.getChannelData(0);
                const next = new Float32Array(input.length);
                next.set(input);
                chunks.push(next);
              };
              await new Promise<void>((resolve) => {
                window.setTimeout(() => resolve(), durationMs);
              });
              processor.disconnect();
              gain.disconnect();
              processor.onaudioprocess = null;
              pcm = mergeFloat32Arrays(chunks);
            }
          } finally {
            try {
              await ctx.close();
            } catch (err) {
              void err;
            }
          }
        } finally {
          for (const track of stream.getTracks()) {
            try {
              track.stop();
            } catch (err) {
              void err;
            }
          }
        }
      }

      if (!pcm || !pcm.length || !sampleRate) {
        toast("Calibration impossible : audio indisponible.");
        return;
      }

      const noiseDb = estimateNoiseDb(pcm, sampleRate);
      if (noiseDb === null) {
        toast("Calibration impossible : signal trop faible.");
        return;
      }

      let threshold = noiseDb + marginDb;
      threshold = Math.max(-80, Math.min(-5, threshold));
      threshold = Number(threshold.toFixed(1));

      state.setMicSilenceParams({ silenceThresholdDb: threshold });
      noiseCalibratedRef.current = true;
      setNoiseCalibrated(true);
      logger.info("[mic][noise-calibration] done", {
        sampleRate,
        noiseDb: Number(noiseDb.toFixed(1)),
        thresholdDb: threshold,
      });
      toast(`Seuil de silence ajusté à ${threshold} dB`);
    } catch (err) {
      logger.warn("[mic][noise-calibration] failed", err);
      toast("Échec de la calibration du bruit.");
    } finally {
      setIsCalibratingNoise(false);
    }
  }, [isCalibratingNoise]);

  const abortRecording = useCallback(async () => {
    logger.info("[mic] abort requested", {
      pendingChunks: pendingChunksRef.current.length,
      pcmQueue: pcmQueueRef.current.length,
    });
    finishModeRef.current = "abort";
    clearErrorResetTimer();
    stopAfterQueueRef.current = true;
    isRecordingRef.current = false;
    setIsRecording(false);
    scheduleAudioLevelUpdate(0);
    setIsStopping(false);
    resetLocalState();
    pendingChunksRef.current = [];
    setPendingCount(0);
    await cleanupCapture();
    await finishSession("abort");
  }, [cleanupCapture, clearErrorResetTimer, finishSession, resetLocalState, scheduleAudioLevelUpdate]);

  const startRecording = useCallback(async () => {
    const state = useAsrStore.getState();
    if (state.isTranscribing) {
      toast("Une transcription est déjà en cours.");
      return;
    }
    if (!noiseCalibratedRef.current) {
      toast("Faites silence puis initialisez le bruit de fond avant de démarrer l'enregistrement.");
      return;
    }
    clearErrorResetTimer();

    finishModeRef.current = "complete";
    setIsRecording(true);
    isRecordingRef.current = true;
    setIsStopping(false);
    finishedRef.current = false;
    stopAfterQueueRef.current = false;
    setPendingCount(0);

    runIdRef.current = nextSharedRunId();
    const runId = runIdRef.current;
    logger.info("[mic] start recording", {
      runId,
      preset: state.micActivePreset,
      customModelId: state.micCustomModelId,
      backendPreference: state.micBackendPreference,
      forceSingleThread: state.micForceSingleThread,
      segmentationMode: state.micSegmentationMode,
      silenceThresholdDb: state.micSilenceThresholdDb,
      minSilenceMs: state.micMinSilenceMs,
      minChunkMs: state.micMinChunkMs,
      maxChunkMs: state.micMaxChunkMs,
      preprocessingMode: state.micPreprocessingMode,
      autoTunePreprocess: state.micAutoTunePreprocess,
      enableWordTimestamps: state.micEnableWordTimestamps,
      showSegmentConfidence: state.micShowSegmentConfidence,
    });

    state.setRunExportHeader("mic", {
      exportedAt: new Date().toISOString(),
      mode: "mic",
      settings: {
        mic: {
          modelPreset: state.micActivePreset,
          customModelId: state.micCustomModelId,
          requestedModelId: resolveModelId(state.micActivePreset, state.micCustomModelId),
          backendPreference: state.micBackendPreference,
          forceSingleThread: state.micForceSingleThread,
          preprocessingMode: state.micPreprocessingMode,
          segmentationMode: state.micSegmentationMode,
          silenceThresholdDb: state.micSilenceThresholdDb,
          minSilenceMs: state.micMinSilenceMs,
          minChunkMs: state.micMinChunkMs,
          maxChunkMs: state.micMaxChunkMs,
          autoTunePreprocess: state.micAutoTunePreprocess,
          denoiseNoiseFloorDb: state.micDenoiseNoiseFloorDb,
          denoiseReductionDb: state.micDenoiseReductionDb,
          denoiseSmoothing: state.micDenoiseSmoothing,
          denoiseCalibrationSeconds: state.micDenoiseCalibrationSeconds,
          preprocessEnableFilters: state.micPreprocessEnableFilters,
          preprocessHighpassHz: state.micPreprocessHighpassHz,
          preprocessLowpassHz: state.micPreprocessLowpassHz,
          preprocessEnableLufs: state.micPreprocessEnableLufs,
          preprocessTargetLufs: state.micPreprocessTargetLufs,
          preprocessLimiterEnabled: state.micPreprocessLimiterEnabled,
          preprocessLimiterThresholdDb: state.micPreprocessLimiterThresholdDb,
          preprocessLimiterSoftness: state.micPreprocessLimiterSoftness,
          preprocessVadEnabled: state.micPreprocessVadEnabled,
          preprocessVadThresholdDb: state.micPreprocessVadThresholdDb,
          preprocessVadMinSilenceMs: state.micPreprocessVadMinSilenceMs,
          preprocessOverlapAdd: state.micPreprocessOverlapAdd,
          preprocessOverlapBlockSec: state.micPreprocessOverlapBlockSec,
          preprocessOverlapSec: state.micPreprocessOverlapSec,
          enableWordTimestamps: state.micEnableWordTimestamps,
          showSegmentConfidence: state.micShowSegmentConfidence,
        },
      },
      runtime: {
        runId,
        source: "microphone",
        activeBackend: null,
      },
    });

    state.resetStopRequest();
    state.setProgress(0);
    state.clearSpeakerAssignments("mic");
    state.clearSessionTranscriptMemory("mic");
    state.setSegments([]);
    state.setChunkPlan([]);
    state.setTelemetrySummary(null);
    state.setSegmentationStatus("idle");
    state.setSegmentationProgress(0);
    state.setTranscriptionConfidence(null);
    state.setTranscriptionConfidenceSource(null);

    resetLocalState();
    recordingStartRef.current = Date.now();
    setRecordingSeconds(0);

    const telemetry = new TelemetryCollector();
    telemetryRef.current = telemetry;
    state.registerTelemetry(telemetry);
    state.setStatus("downloading", "Chargement du pipeline micro");
    state.setIsTranscribing(true);

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    setSharedAbortController(abortController);
    abortController.signal.addEventListener(
      "abort",
      () => {
        void abortRecording();
      },
      { once: true }
    );

    logger.info("[mic] create pipeline", {
      runId,
      preset: state.micActivePreset,
      backendPreference: state.micBackendPreference,
      forceSingleThread: state.micForceSingleThread,
    });
    pipelinePromiseRef.current = createAsrPipeline({
      modelPreset: state.micActivePreset,
      customModelId: state.micCustomModelId,
      backendPreference: state.micBackendPreference,
      forceSingleThread: state.micForceSingleThread,
      telemetry,
      onStatus: (status, detail) => {
        useAsrStore.getState().setStatus(status, detail);
      },
    }).then(({ pipeline, backend, modelId }) => {
      if (runId !== getSharedRunId()) {
        throw new Error("Run annulé");
      }
      pipelineRef.current = pipeline;
      state.setActiveBackend(backend);
      telemetry.setRuntimeContext({ backend, modelId });
      const micRunHeader = useAsrStore.getState().runExportHeaders.mic;
      if (micRunHeader) {
        state.setRunExportHeader("mic", {
          ...micRunHeader,
          runtime: {
            ...micRunHeader.runtime,
            activeBackend: backend,
            activeModelId: modelId,
          },
        });
      }
      logger.info("[mic] pipeline ready", { runId, backend, modelId });
      if (isRecordingRef.current) {
        state.setStatus("transcribing", "Micro en cours d'écoute");
      }
      return pipeline;
    });

    try {
      logger.debug("[mic] request getUserMedia");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      sampleRateRef.current = audioContext.sampleRate;
      sourceRef.current = { id: crypto.randomUUID(), label: "Microphone", type: "mic" };
      logger.info("[mic] audio capture ready", {
        sampleRate: audioContext.sampleRate,
        bufferSize: DEFAULT_BUFFER_SIZE,
      });

      const source = audioContext.createMediaStreamSource(stream);
      const gain = audioContext.createGain();
      gain.gain.value = 0;
      gainRef.current = gain;

      if (audioContext.audioWorklet && typeof audioContext.audioWorklet.addModule === "function") {
        logger.debug("[mic] audioWorklet init");
        await audioContext.audioWorklet.addModule(new URL("../worklets/mic-capture.worklet.ts", import.meta.url));
        const node = new AudioWorkletNode(audioContext, "mic-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
        });
        workletRef.current = node;
        node.port.onmessage = (event) => {
          const data = event.data as { type?: string; pcm?: Float32Array; rms?: number };
          if (data?.type === "chunk" && data.pcm instanceof Float32Array) {
            handlePcmChunkRef.current?.(data.pcm, typeof data.rms === "number" ? data.rms : undefined);
            return;
          }
          if (data?.type === "flushed") {
            const resolve = pendingWorkletFlushRef.current;
            pendingWorkletFlushRef.current = null;
            resolve?.();
          }
        };
        source.connect(node);
        node.connect(gain);
        gain.connect(audioContext.destination);
      } else {
        const processor = audioContext.createScriptProcessor(DEFAULT_BUFFER_SIZE, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(gain);
        gain.connect(audioContext.destination);
        processor.onaudioprocess = handleAudioProcess;
      }
    } catch (error) {
      logger.error("[mic] getUserMedia failed", error);
      state.setStatus("error", "Accès micro refusé ou indisponible");
      toast("Impossible d'accéder au micro.");
      finishModeRef.current = "error";
      await cleanupCapture();
      stopAfterQueueRef.current = true;
      setIsRecording(false);
      isRecordingRef.current = false;
      await maybeFinish();
    }
  }, [abortRecording, cleanupCapture, clearErrorResetTimer, handleAudioProcess, maybeFinish, resetLocalState]);

  const stopRecording = useCallback(async () => {
    if (!isRecordingRef.current) return;
    logger.info("[mic] stop recording requested", {
      pendingChunks: pendingChunksRef.current.length,
      pcmQueue: pcmQueueRef.current.length,
      bufferSamples: bufferPcmRef.current.length,
      bufferStartSec: round3(bufferStartSecRef.current),
    });
    finishModeRef.current = "complete";
    setIsStopping(true);
    stopAfterQueueRef.current = true;
    // Stopping the microphone capture is not the same as stopping transcription:
    // we still want to drain the queued chunks and finish the session.
    useAsrStore.getState().resetStopRequest();
    useAsrStore.getState().setStatus("transcribing", "Finalisation des segments");

    isRecordingRef.current = false;
    setIsRecording(false);

    if (workletRef.current) {
      try {
        await new Promise<void>((resolve) => {
          pendingWorkletFlushRef.current = resolve;
          workletRef.current?.port.postMessage({ type: "flush" });
        });
      } catch (err) {
        logger.warn("[mic] worklet flush failed", err);
      }
    }

    try {
      await processPcmQueue(true);
    } catch (err) {
      logger.warn("[mic] flush pcm failed", err);
    }
    captureRecordingBuffer();
    // Ensure any remaining buffered audio is flushed into segments before shutdown.
    finalizeSegments(true);
    updateMicProgress();

    await cleanupCapture();
    await maybeFinish();
  }, [captureRecordingBuffer, cleanupCapture, finalizeSegments, maybeFinish, processPcmQueue, updateMicProgress]);

  const prepareRecordingMp3 = useCallback(async () => {
    const buffer = lastRecordingBufferRef.current;
    if (!buffer || !buffer.length) {
      throw new Error("Aucun enregistrement disponible");
    }
    const sampleRate = lastRecordingSampleRateRef.current ?? sampleRateRef.current ?? 16000;
    const wavBuffer = encodeWavBuffer(buffer, sampleRate);
    const blob = await transcodeWavToMp3(wavBuffer);
    return blob;
  }, []);

  const prepareRecordingWav = useCallback(() => {
    const buffer = lastRecordingBufferRef.current;
    if (!buffer || !buffer.length) {
      throw new Error("Aucun enregistrement disponible");
    }
    const sampleRate = lastRecordingSampleRateRef.current ?? sampleRateRef.current ?? 16000;
    const wavBuffer = encodeWavBuffer(buffer, sampleRate);
    return new Blob([wavBuffer], { type: "audio/wav" });
  }, []);

  return {
    isRecording,
    isStopping,
    pendingCount,
    recordingSeconds,
    audioLevel,
    hasRecording,
    isCalibratingNoise,
    noiseCalibrated,
    startRecording,
    stopRecording,
    prepareRecordingWav,
    prepareRecordingMp3,
    calibrateSilenceThreshold,
  };
}

function mergeFloat32Arrays(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (!total) return new Float32Array(0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

async function transcodeWavToMp3(wavBuffer: ArrayBuffer) {
  const ffmpeg = await getFfmpeg();
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  const inputName = `mic-recording-${sessionId}.wav`;
  const outputName = `mic-recording-${sessionId}.mp3`;

  const ffAny = ffmpeg as unknown as Record<string, unknown>;
  const hasLegacyFs = typeof ffAny["FS"] === "function" && typeof ffAny["run"] === "function";

  if (hasLegacyFs) {
    const ff = ffmpeg as unknown as {
      FS: (op: string, ...args: unknown[]) => unknown;
      run: (...args: string[]) => Promise<void>;
    };
    ff.FS("writeFile", inputName, new Uint8Array(wavBuffer));
    try {
      await ff.run("-y", "-i", inputName, "-codec:a", "libmp3lame", "-q:a", "2", outputName);
      const data = ff.FS("readFile", outputName) as Uint8Array;
      const bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      return new Blob([bytes], { type: "audio/mpeg" });
    } finally {
      try {
        ff.FS("unlink", inputName);
      } catch (err) {
        void err;
      }
      try {
        ff.FS("unlink", outputName);
      } catch (err) {
        void err;
      }
    }
  }

  // @ffmpeg/ffmpeg >= 0.12: FFmpeg class API (writeFile/readFile/exec/deleteFile)
  await ffmpeg.writeFile(inputName, new Uint8Array(wavBuffer));
  try {
    const exitCode = await ffmpeg.exec(["-y", "-i", inputName, "-codec:a", "libmp3lame", "-q:a", "2", outputName]);
    if (typeof exitCode === "number" && exitCode !== 0) {
      throw new Error(`ffmpeg failed with code ${exitCode}`);
    }
    const data = await ffmpeg.readFile(outputName);
    if (!(data instanceof Uint8Array)) {
      throw new Error("ffmpeg output is not binary data");
    }
    // Ensure the backing buffer is a plain ArrayBuffer (Blob types reject SharedArrayBuffer in TS).
    const bytes = new Uint8Array(data.byteLength);
    bytes.set(data);
    return new Blob([bytes], { type: "audio/mpeg" });
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch (err) {
      void err;
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch (err) {
      void err;
    }
  }
}
