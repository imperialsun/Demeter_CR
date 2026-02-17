import { useCallback, useEffect, useRef } from "react";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import { toast } from "@/components/ui/use-toast";
import { createAsrPipeline, disposePipeline, transcribeChunk, isModelTooLargeError } from "@/lib/asr";
import estimateConfidenceFromText, { scoreDetails } from "@/lib/textConfidence";
import * as logger from "@/lib/logger";
import { buildChunks, buildFixedSegments, offsetChunks } from "@/lib/chunking";
import {
  decodeFileFully,
  decodeCompressedBlobToPcm,
  extractChunkPcm,
  probeAudioMetadata,
} from "@/lib/audio";
import {
  preprocessDecodedAudio,
  estimateNoiseProfileWithVad,
  computePreprocessParams,
  type SpectralGateParams,
} from "@/lib/preprocessing";
import { createSegmentCache } from "@/lib/segmenter";
import { deleteSegment, deleteSessionSegments, getSegment } from "@/lib/segment-cache";
import { TelemetryCollector } from "@/lib/telemetry";
import type { TranscriptionSegment, WordSegment } from "@/lib/export";
import {
  MODEL_PRESETS,
  resolveLighterPresetForMemoryFallback,
  useAsrStore,
  type DedupeMode,
} from "@/store/asr-store";

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

const sharedAbortRef: { current: AbortController | null } = { current: null };
const sharedRunIdRef: { current: number } = { current: 0 };
const ERROR_STATUS_HOLD_MS = 10_000;

export function nextSharedRunId() {
  sharedRunIdRef.current += 1;
  return sharedRunIdRef.current;
}

export function getSharedRunId() {
  return sharedRunIdRef.current;
}

export function setSharedAbortController(controller: AbortController | null) {
  sharedAbortRef.current = controller;
}

export function useTranscriptionController() {
  const confidenceAccumulatorRef = useRef({
    totalDur: 0,
    weightedSum: 0,
    modelDur: 0,
    estimatedDur: 0,
  });
  const progressThrottleRef = useRef(0);
  const segmentationThrottleRef = useRef(0);
  const preprocessThrottleRef = useRef(0);
  const errorResetTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const throttleMs = 120;

  const isTranscribing = useAsrStore((state) => state.isTranscribing);

  const resetConfidenceAccumulator = () => {
    confidenceAccumulatorRef.current = {
      totalDur: 0,
      weightedSum: 0,
      modelDur: 0,
      estimatedDur: 0,
    };
  };

  const updateOverallConfidence = useCallback((
    newSegments: TranscriptionSegment[],
    telemetry: TelemetryCollector,
    chunkIndex?: number,
    fallbackText?: string,
    fallbackDurationSec?: number
  ) => {
    const acc = confidenceAccumulatorRef.current;
    for (const seg of newSegments) {
      const conf = seg.confidence;
      if (typeof conf !== "number" || Number.isNaN(conf)) continue;
      const dur = Math.max(0.001, seg.end - seg.start);
      acc.totalDur += dur;
      acc.weightedSum += conf * dur;
      if (seg.confidenceSource === "estimated") acc.estimatedDur += dur;
      else if (seg.confidenceSource === "model") acc.modelDur += dur;
    }

    let overall: number | null = null;
    let source: "model" | "estimated" | null = null;
    if (acc.totalDur > 0) {
      overall = clamp01(acc.weightedSum / acc.totalDur);
      source = acc.estimatedDur > acc.modelDur ? "estimated" : "model";
    } else if (fallbackText && fallbackText.trim().length) {
      try {
        const dur = Math.max(0.001, fallbackDurationSec ?? 0.001);
        overall = clamp01(estimateConfidenceFromText(fallbackText, dur));
        source = "estimated";
        logger.info("Computed overall from chunk text (fallback)", { chunkIndex, overall });
      } catch (err) {
        void err;
      }
    }

    useAsrStore.getState().setTranscriptionConfidence(overall);
    useAsrStore.getState().setTranscriptionConfidenceSource(source);
    telemetry?.logEvent("PROGRESS_CONFIDENCE", { chunkIndex, overall });
    logger.info("Progressive transcript confidence", { chunkIndex, overall, source });
  }, []);

  const setProgressThrottled = (value: number, force = false) => {
    const now = Date.now();
    if (force || value <= 0 || value >= 1 || now - progressThrottleRef.current >= throttleMs) {
      progressThrottleRef.current = now;
      useAsrStore.getState().setProgress(value);
    }
  };

  const setSegmentationProgressThrottled = (value: number, force = false) => {
    const now = Date.now();
    if (force || value <= 0 || value >= 1 || now - segmentationThrottleRef.current >= throttleMs) {
      segmentationThrottleRef.current = now;
      useAsrStore.getState().setSegmentationProgress(value);
    }
  };

  const setPreprocessingProgressThrottled = (value: number, force = false) => {
    const now = Date.now();
    if (force || value <= 0 || value >= 1 || now - preprocessThrottleRef.current >= throttleMs) {
      preprocessThrottleRef.current = now;
      useAsrStore.getState().setPreprocessingProgress(value);
    }
  };

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
      if (sharedRunIdRef.current !== runId) return;
      const snapshot = useAsrStore.getState();
      if (snapshot.isTranscribing || snapshot.status !== "error") return;
      snapshot.resetSession();
    }, ERROR_STATUS_HOLD_MS);
  }, [clearErrorResetTimer]);

  useEffect(() => {
    return () => {
      clearErrorResetTimer();
    };
  }, [clearErrorResetTimer]);

  const handleFullPipeline = useCallback(
    async ({
      file,
      telemetry,
      pipeline,
      source,
      preprocessConfig,
      preDecoded,
      preprocessed,
      runId,
    }: {
      file: File;
      telemetry: TelemetryCollector;
      pipeline: AutomaticSpeechRecognitionPipeline;
      source: { id: string; label: string; type: "file" };
      preprocessConfig?: SpectralGateParams | null;
      preDecoded?: import("@/lib/audio").DecodedAudio | null;
      preprocessed?: boolean | null;
      runId: number;
    }) => {
      const state = useAsrStore.getState();
      teleportStateToReady();

      logger.info("[decode] full pipeline start", {
        fileName: file.name,
        mode: preprocessConfig ? "complete-preprocess" : "full-memory",
        reusedPreDecoded: Boolean(preDecoded),
      });
      telemetry.logEvent("START_DECODE", {
        strategy: "full",
        reason: preprocessConfig ? "full_mode_with_preprocess" : "full_mode_no_preprocess",
      });

      // Use provided decoded audio if preprocessing was performed prior to model init
      let decoded = preDecoded ?? await decodeFileFully(file, telemetry);
      const pcmBytes = decoded.pcm.byteLength;
      const pcmMb = pcmBytes / (1024 * 1024);
      logger.info("[decode] full decode RAM footprint", {
        samples: decoded.pcm.length,
        sampleRate: decoded.sampleRate,
        pcmBytes,
        pcmMb: Number(pcmMb.toFixed(2)),
      });
      telemetry.logEvent("RAM_USAGE", {
        context: "full_decode_pcm",
        bytes: pcmBytes,
        mb: Number(pcmMb.toFixed(3)),
        samples: decoded.pcm.length,
        sampleRate: decoded.sampleRate,
      });
      if (preprocessConfig) {
        logger.info("[preprocess] applying full pipeline on decoded audio", preprocessConfig);

        // If preprocessed earlier (preDecoded contains preprocessed pcm), skip any calibration/apply steps
        if (preprocessed) {
          logger.info("[preprocess] skipped because preprocessing was done prior to model init");
          useAsrStore.getState().setPreprocessingStatus("done");
          useAsrStore.getState().setPreprocessingProgress(1);
        } else {
          // Try to reuse a pre-computed noise profile if available (from pre-model step)
          const preModel = (telemetry as unknown as { __preprocessConfig?: unknown }).__preprocessConfig as SpectralGateParams | undefined;
          try {
            if (!preprocessConfig.noiseProfile) {
              if (preModel && preModel.noiseProfile) {
                preprocessConfig.noiseProfile = preModel.noiseProfile;
                telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames: 0, source: "pre-model-reuse" });
              } else {
                useAsrStore.getState().setPreprocessingStatus("calibrating");
                useAsrStore.getState().setPreprocessingProgress(0);
                const { profile, frames, vadUsed, silenceRanges } = estimateNoiseProfileWithVad(
                  decoded.pcm,
                  decoded.sampleRate,
                  preprocessConfig.calibrationSeconds ?? state.denoiseCalibrationSeconds,
                  preprocessConfig.preprocessVadThresholdDb ?? state.preprocessVadThresholdDb,
                  preprocessConfig.preprocessVadMinSilenceMs ?? state.preprocessVadMinSilenceMs
                );
                preprocessConfig.noiseProfile = profile;
                telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "auto", vadUsed, silenceRanges });

                // Auto-tune gate parameters if enabled
                if (state.autoTunePreprocess) {
                  const calibrationSeconds = preprocessConfig.calibrationSeconds ?? state.denoiseCalibrationSeconds;
                  const tune = computePreprocessParams(
                    profile,
                    decoded.pcm.subarray(0, Math.floor(calibrationSeconds * decoded.sampleRate))
                  );
                  preprocessConfig.noiseFloorDb = tune.noiseFloorDb;
                  preprocessConfig.reductionDb = tune.reductionDb;
                  preprocessConfig.smoothing = tune.smoothing;
                  preprocessConfig.preprocessTargetLufs = tune.targetLufs;
                  preprocessConfig.preprocessHighpassHz = tune.highpassHz;
                  preprocessConfig.preprocessLowpassHz = tune.lowpassHz;
                  preprocessConfig.preprocessLimiterThresholdDb = tune.limiterThresholdDb;
                  preprocessConfig.preprocessLimiterSoftness = tune.limiterSoftness;
                  preprocessConfig.preprocessVadThresholdDb = tune.vadThresholdDb;
                  preprocessConfig.preprocessOverlapBlockSec = tune.overlapBlockSec;
                  preprocessConfig.preprocessOverlapSec = tune.overlapSec;
                  // apply autotuned params to global settings so sliders reflect current autotune
                  useAsrStore.getState().setDenoiseParams({
                    denoiseNoiseFloorDb: tune.noiseFloorDb,
                    denoiseReductionDb: tune.reductionDb,
                    denoiseSmoothing: tune.smoothing,
                  });
                  useAsrStore.getState().setPreprocessParams({
                    preprocessTargetLufs: tune.targetLufs,
                    preprocessHighpassHz: tune.highpassHz,
                    preprocessLowpassHz: tune.lowpassHz,
                    preprocessLimiterThresholdDb: tune.limiterThresholdDb,
                    preprocessLimiterSoftness: tune.limiterSoftness,
                    preprocessVadThresholdDb: tune.vadThresholdDb,
                    preprocessOverlapBlockSec: tune.overlapBlockSec,
                    preprocessOverlapSec: tune.overlapSec,
                  });
                  useAsrStore.getState().setLastAutoTuneParams({
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
                  logger.info("[preprocess][autotune] full applied", {
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
                  });
                  telemetry.logEvent("PREPROCESS_AUTOTUNE", {
                    source: "auto",
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
                }
              }
            }
          } catch (err) {
            logger.warn("Calibration failed", err);
            telemetry.recordAlert("PREPROCESS_CALIBRATION_FAILED", { message: (err as Error).message });
          }

          // For full preprocessing mode, apply the heavy spectral gate now
          useAsrStore.getState().setPreprocessingStatus("processing");
          useAsrStore.getState().setPreprocessingProgress(0);
          const processed = await preprocessDecodedAudio(decoded, preprocessConfig, telemetry);
          decoded = {
            metadata: decoded.metadata,
            pcm: processed.pcm,
            sampleRate: processed.sampleRate,
          };
          useAsrStore.getState().setPreprocessingProgress(1);
          useAsrStore.getState().setPreprocessingStatus("done");
        }
      }
      useAsrStore.getState().registerAudioSource(source, decoded.metadata);

      const chunkPlan = buildChunks(
        {
          strategy: state.chunkStrategy,
          chunkDurationSec: state.chunkDurationSec,
          overlapSec: state.overlapSec,
          durationSec: decoded.metadata.durationSec,
          silence: {
            silenceThresholdDb: state.silenceThresholdDb,
            minSilenceMs: state.minSilenceMs,
            minChunkMs: state.minChunkMs,
            maxChunkMs: state.maxChunkMs,
            sampleRate: decoded.sampleRate,
          },
        },
        decoded.pcm,
        decoded.sampleRate
      );

      logger.info("[chunk-plan] full", {
        chunks: chunkPlan.length,
        strategy: state.chunkStrategy,
        chunkDurationSec: state.chunkDurationSec,
        overlapSec: state.overlapSec,
        silence: {
          silenceThresholdDb: state.silenceThresholdDb,
          minSilenceMs: state.minSilenceMs,
          minChunkMs: state.minChunkMs,
          maxChunkMs: state.maxChunkMs,
        },
      });
      telemetry.logEvent("CHUNK_PLAN", {
        mode: "full",
        chunks: chunkPlan.length,
        strategy: state.chunkStrategy,
        chunkDurationSec: state.chunkDurationSec,
        overlapSec: state.overlapSec,
        silenceThresholdDb: state.silenceThresholdDb,
        minSilenceMs: state.minSilenceMs,
        minChunkMs: state.minChunkMs,
        maxChunkMs: state.maxChunkMs,
      });

      state.setChunkPlan(chunkPlan);

      let nextIndex = state.segments.length;
      let lastSegment = state.segments.at(-1);
      const totalChunks = chunkPlan.length || 1;

      for (const definition of chunkPlan) {
        if (shouldStopAfterChunk(runId)) {
          break;
        }
        const chunkPcm = extractChunkPcm(decoded.pcm, decoded.sampleRate, definition);
        const result = await transcribeChunk({
          pipeline,
          chunk: definition,
          pcm: chunkPcm,
          sampleRate: decoded.sampleRate,
          telemetry,
          enableWordTimestamps: state.enableWordTimestamps,
          showSegmentConfidence: state.showSegmentConfidence,
        });
        logger.info("[decode] full decode start", { chunk: definition });

        if (shouldStopAfterChunk(runId)) {
          break;
        }

        const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment, {
          enableWordTimestamps: state.enableWordTimestamps,
          dedupeMode: state.dedupeMode,
        });
        if (segments.length) {
          nextIndex += segments.length;
          lastSegment = segments[segments.length - 1];
          state.appendSegments(segments);

          // Recompute overall confidence immediately after appending segments (full pipeline mode)
          const fallbackDuration = Math.max(0.001, (definition.end ?? definition.start) - (definition.start ?? 0));
          updateOverallConfidence(segments, telemetry, definition.index, result?.text, fallbackDuration);
        }

        const metric = {
          id: definition.id,
          index: definition.index,
          startSec: definition.start,
          endSec: definition.end,
          transcriptionMs: result.processingMs,
          realtimeFactor: result.realtimeFactor,
          text: result.text,
        };
        telemetry.pushChunkMetric(metric);
        state.pushChunkMetric(metric);
        setProgressThrottled((definition.index + 1) / totalChunks);

        // Memory snapshot for this chunk (useful to track per-chunk heap usage)
        try {
          const bytes = (chunkPcm as Float32Array).byteLength ?? 0;
          telemetry.snapshotMemory(`CHUNK_AFTER_PROCESS_${definition.index}`);
          telemetry.logEvent("RAM_USAGE", { context: "chunk", index: definition.index, bytes, mb: Number((bytes / (1024 * 1024)).toFixed(3)) });
        } catch (err) {
          void err;
        }
      }
    },
    [updateOverallConfidence]
  );

  const handleProgressivePipeline = useCallback(
    async ({
      file,
      telemetry,
      pipeline,
      source,
      preprocessConfig,
      runId,
    }: {
      file: File;
      telemetry: TelemetryCollector;
      pipeline: AutomaticSpeechRecognitionPipeline;
      source: { id: string; label: string; type: "file" };
      preprocessConfig?: SpectralGateParams | null;
      runId: number;
    }) => {
      const state = useAsrStore.getState();
      teleportStateToReady();

      const duration = state.audioMetadata?.durationSec ?? 0;
      useAsrStore.getState().registerAudioSource(source, state.audioMetadata);
      const segmentDurationSec = Math.max(60, state.progressiveSegmentDurationSec);
      const segmentOverlapSec = 5;
      const segmentPlan = buildFixedSegments({
        durationSec: duration,
        segmentDurationSec,
        overlapSec: segmentOverlapSec,
      });
      const segmentSessionId = crypto.randomUUID();

      logger.info("[progressive-segment] plan", {
        segments: segmentPlan.length,
        segmentDurationSec,
        overlapSec: segmentOverlapSec,
        durationSec: duration,
      });
      telemetry.logEvent("PROGRESSIVE_SEGMENT_PLAN", {
        segments: segmentPlan.length,
        segmentDurationSec,
        overlapSec: segmentOverlapSec,
        durationSec: duration,
      });

      state.setChunkPlan([]);
      let nextIndex = state.segments.length;
      let lastSegment = state.segments.at(-1);
      let globalChunkIndex = 0;

      const abortController = new AbortController();
      sharedAbortRef.current = abortController;

      const effectivePreprocessConfig = preprocessConfig ?? {
        noiseFloorDb: state.denoiseNoiseFloorDb,
        reductionDb: state.denoiseReductionDb,
        smoothing: state.denoiseSmoothing,
        calibrationSeconds: state.denoiseCalibrationSeconds,
        noiseProfile: undefined as Float32Array | undefined,
        preprocessEnableFilters: state.preprocessEnableFilters,
        preprocessHighpassHz: state.preprocessHighpassHz,
        preprocessLowpassHz: state.preprocessLowpassHz,
        preprocessEnableLufs: state.preprocessEnableLufs,
        preprocessTargetLufs: state.preprocessTargetLufs,
        preprocessLimiterEnabled: state.preprocessLimiterEnabled,
        preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
        preprocessLimiterSoftness: state.preprocessLimiterSoftness,
        preprocessVadEnabled: state.preprocessVadEnabled,
        preprocessVadThresholdDb: state.preprocessVadThresholdDb,
        preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
        preprocessOverlapAdd: state.preprocessOverlapAdd,
        preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
        preprocessOverlapSec: state.preprocessOverlapSec,
      };
      logger.info("[preprocess] progressive segment mode", {
        enabled: Boolean(effectivePreprocessConfig),
        segmentDurationSec,
      });

      let preprocessingStopped = false;
      if (effectivePreprocessConfig) {
        useAsrStore.getState().setPreprocessingStatus("processing");
        setPreprocessingProgressThrottled(0, true);
      }

      try {
        if (segmentPlan.length) {
          state.setSegmentationStatus("segmenting");
              setSegmentationProgressThrottled(0, true);
          const segmenting = await createSegmentCache(file, {
            sessionId: segmentSessionId,
            segments: segmentPlan,
            telemetry,
            signal: abortController.signal,
            onProgress: (completed, total) => {
              const progress = total > 0 ? completed / total : 0;
              setSegmentationProgressThrottled(progress);
            },
          });
          if (segmenting.aborted) {
            state.setSegmentationStatus("stopped");
            logger.warn("[progressive-segment] segmentation stopped", {
              completed: segmenting.completed,
              total: segmenting.total,
            });
            if (effectivePreprocessConfig) {
              useAsrStore.getState().setPreprocessingStatus("idle");
            }
            return;
          }
          state.setSegmentationStatus("done");
        }

        for (const segment of segmentPlan) {
          if (shouldStopAfterChunk(runId)) {
            preprocessingStopped = true;
            break;
          }

          telemetry.logEvent("PROGRESSIVE_SEGMENT_START", {
            segmentIndex: segment.index,
            startSec: segment.start,
            endSec: segment.end,
          });
          logger.info("[progressive-segment] start", {
            segmentIndex: segment.index,
            startSec: segment.start,
            endSec: segment.end,
          });

          const cached = await getSegment(segmentSessionId, segment.index);
          if (!cached) {
            logger.warn("[progressive-segment] missing cached segment", { segmentIndex: segment.index });
            continue;
          }

          let decoded: Awaited<ReturnType<typeof decodeCompressedBlobToPcm>> | null = null;
          try {
            decoded = await decodeCompressedBlobToPcm(cached.blob, telemetry, 16000);
          } catch (error) {
            if ((error as DOMException)?.name === "AbortError") {
              break;
            }
            throw error;
          } finally {
            await deleteSegment(segmentSessionId, segment.index);
          }

          if (!decoded || !decoded.pcm.length) {
            logger.warn("[progressive-segment] empty pcm", { segmentIndex: segment.index });
            continue;
          }

          let segmentPcm = decoded.pcm;
          let segmentSampleRate = decoded.sampleRate;
          const segmentDuration = segmentPcm.length / segmentSampleRate;

          if (effectivePreprocessConfig) {
            useAsrStore.getState().setPreprocessingStatus("calibrating");
            setPreprocessingProgressThrottled(segment.index / Math.max(1, segmentPlan.length));
            try {
              const { profile, frames, vadUsed, silenceRanges } = estimateNoiseProfileWithVad(
                segmentPcm,
                segmentSampleRate,
                effectivePreprocessConfig.calibrationSeconds ?? state.denoiseCalibrationSeconds,
                effectivePreprocessConfig.preprocessVadThresholdDb ?? state.preprocessVadThresholdDb,
                effectivePreprocessConfig.preprocessVadMinSilenceMs ?? state.preprocessVadMinSilenceMs
              );
              telemetry.logEvent("PREPROCESS_NOISE_PROFILE", {
                frames,
                source: "segment",
                segmentIndex: segment.index,
                vadUsed,
                silenceRanges,
              });
              if (state.autoTunePreprocess) {
                const calibrationSeconds = effectivePreprocessConfig.calibrationSeconds ?? state.denoiseCalibrationSeconds;
                const tune = computePreprocessParams(
                  profile,
                  segmentPcm.subarray(0, Math.floor(calibrationSeconds * segmentSampleRate))
                );
                effectivePreprocessConfig.noiseFloorDb = tune.noiseFloorDb;
                effectivePreprocessConfig.reductionDb = tune.reductionDb;
                effectivePreprocessConfig.smoothing = tune.smoothing;
                effectivePreprocessConfig.preprocessTargetLufs = tune.targetLufs;
                effectivePreprocessConfig.preprocessHighpassHz = tune.highpassHz;
                effectivePreprocessConfig.preprocessLowpassHz = tune.lowpassHz;
                effectivePreprocessConfig.preprocessLimiterThresholdDb = tune.limiterThresholdDb;
                effectivePreprocessConfig.preprocessLimiterSoftness = tune.limiterSoftness;
                effectivePreprocessConfig.preprocessVadThresholdDb = tune.vadThresholdDb;
                effectivePreprocessConfig.preprocessOverlapBlockSec = tune.overlapBlockSec;
                effectivePreprocessConfig.preprocessOverlapSec = tune.overlapSec;
                useAsrStore.getState().setDenoiseParams({
                  denoiseNoiseFloorDb: tune.noiseFloorDb,
                  denoiseReductionDb: tune.reductionDb,
                  denoiseSmoothing: tune.smoothing,
                });
                useAsrStore.getState().setPreprocessParams({
                  preprocessTargetLufs: tune.targetLufs,
                  preprocessHighpassHz: tune.highpassHz,
                  preprocessLowpassHz: tune.lowpassHz,
                  preprocessLimiterThresholdDb: tune.limiterThresholdDb,
                  preprocessLimiterSoftness: tune.limiterSoftness,
                  preprocessVadThresholdDb: tune.vadThresholdDb,
                  preprocessOverlapBlockSec: tune.overlapBlockSec,
                  preprocessOverlapSec: tune.overlapSec,
                });
                useAsrStore.getState().setLastAutoTuneParams({
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
                logger.info("[preprocess][autotune] segment applied", {
                  segmentIndex: segment.index,
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
                });
                telemetry.logEvent("PREPROCESS_AUTOTUNE", {
                  source: "segment",
                  segmentIndex: segment.index,
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
              }

              useAsrStore.getState().setPreprocessingStatus("processing");
              const processed = await preprocessDecodedAudio(
                {
                  metadata: { durationSec: segmentDuration },
                  pcm: segmentPcm,
                  sampleRate: segmentSampleRate,
                },
                {
                  ...effectivePreprocessConfig,
                  noiseProfile: profile,
                },
                telemetry
              );
              segmentPcm = processed.pcm;
              segmentSampleRate = processed.sampleRate;
            } catch (err) {
              logger.warn("[preprocess] segment preprocess failed", err);
              telemetry.recordAlert("PREPROCESS_CALIBRATION_FAILED", { message: (err as Error).message });
            } finally {
              setPreprocessingProgressThrottled((segment.index + 1) / Math.max(1, segmentPlan.length));
              useAsrStore.getState().setPreprocessingStatus("processing");
            }
          }

          try {
            const bytes = segmentPcm.byteLength ?? 0;
            telemetry.snapshotMemory(`SEGMENT_READY_${segment.index}`);
            telemetry.logEvent("RAM_USAGE", {
              context: "segment",
              index: segment.index,
              bytes,
              mb: Number((bytes / (1024 * 1024)).toFixed(3)),
            });
          } catch (err) {
            void err;
          }

          const segmentChunkPlan = buildChunks(
            {
              strategy: state.chunkStrategy,
              chunkDurationSec: state.chunkDurationSec,
              overlapSec: state.overlapSec,
              durationSec: segmentPcm.length / segmentSampleRate,
              silence: {
                silenceThresholdDb: state.silenceThresholdDb,
                minSilenceMs: state.minSilenceMs,
                minChunkMs: state.minChunkMs,
                maxChunkMs: state.maxChunkMs,
                sampleRate: segmentSampleRate,
              },
            },
            segmentPcm,
            segmentSampleRate
          );
          logger.info("[chunk-plan] segment", {
            segmentIndex: segment.index,
            chunks: segmentChunkPlan.length,
            strategy: state.chunkStrategy,
            chunkDurationSec: state.chunkDurationSec,
            overlapSec: state.overlapSec,
            silence: {
              silenceThresholdDb: state.silenceThresholdDb,
              minSilenceMs: state.minSilenceMs,
              minChunkMs: state.minChunkMs,
              maxChunkMs: state.maxChunkMs,
            },
          });
          telemetry.logEvent("CHUNK_PLAN", {
            mode: "segment",
            segmentIndex: segment.index,
            chunks: segmentChunkPlan.length,
            strategy: state.chunkStrategy,
            chunkDurationSec: state.chunkDurationSec,
            overlapSec: state.overlapSec,
            silenceThresholdDb: state.silenceThresholdDb,
            minSilenceMs: state.minSilenceMs,
            minChunkMs: state.minChunkMs,
            maxChunkMs: state.maxChunkMs,
          });
          const segmentChunkPlanGlobal = offsetChunks(segmentChunkPlan, segment.start, globalChunkIndex);
          globalChunkIndex += segmentChunkPlanGlobal.length;
          state.setChunkPlan([...useAsrStore.getState().chunkPlan, ...segmentChunkPlanGlobal]);

          for (let i = 0; i < segmentChunkPlan.length; i += 1) {
            if (shouldStopAfterChunk(runId)) {
              preprocessingStopped = true;
              break;
            }
            const localChunk = segmentChunkPlan[i]!;
            const globalChunk = segmentChunkPlanGlobal[i]!;
            const chunkPcm = extractChunkPcm(segmentPcm, segmentSampleRate, localChunk);
            const result = await transcribeChunk({
              pipeline,
              chunk: globalChunk,
              pcm: chunkPcm,
              sampleRate: segmentSampleRate,
              telemetry,
              enableWordTimestamps: state.enableWordTimestamps,
              showSegmentConfidence: state.showSegmentConfidence,
            });

            if (shouldStopAfterChunk(runId)) {
              preprocessingStopped = true;
              break;
            }

            const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment, {
              enableWordTimestamps: state.enableWordTimestamps,
              dedupeMode: state.dedupeMode,
            });
            if (segments.length) {
              nextIndex += segments.length;
              lastSegment = segments[segments.length - 1];
              state.appendSegments(segments);
            }

            const metric = {
              id: globalChunk.id,
              index: globalChunk.index,
              startSec: globalChunk.start,
              endSec: globalChunk.end,
              transcriptionMs: result.processingMs,
              realtimeFactor: result.realtimeFactor,
              text: result.text,
            };
            telemetry.pushChunkMetric(metric);
            state.pushChunkMetric(metric);

            const progress = duration > 0 ? Math.min(1, Math.max(0, (globalChunk.end ?? segment.end) / duration)) : 0;
            setProgressThrottled(progress);

            const fallbackDuration = Math.max(0.001, (globalChunk.end ?? globalChunk.start) - (globalChunk.start ?? 0));
            updateOverallConfidence(segments, telemetry, globalChunk.index, result?.text, fallbackDuration);

            try {
              const bytes = (chunkPcm as Float32Array).byteLength ?? 0;
              telemetry.snapshotMemory(`CHUNK_AFTER_PROCESS_${globalChunk.index}`);
              telemetry.logEvent("RAM_USAGE", { context: "chunk", index: globalChunk.index, bytes, mb: Number((bytes / (1024 * 1024)).toFixed(3)) });
            } catch (err) {
              void err;
            }
          }

          telemetry.logEvent("PROGRESSIVE_SEGMENT_DONE", {
            segmentIndex: segment.index,
            startSec: segment.start,
            endSec: segment.end,
          });
          logger.info("[progressive-segment] done", { segmentIndex: segment.index });
          segmentPcm = new Float32Array(0);
          if (preprocessingStopped) {
            break;
          }
        }
        if (effectivePreprocessConfig) {
          if (preprocessingStopped || shouldStopAfterChunk(runId)) {
            useAsrStore.getState().setPreprocessingStatus("idle");
          } else {
            useAsrStore.getState().setPreprocessingStatus("done");
            useAsrStore.getState().setPreprocessingProgress(1);
          }
        }
      } catch (error) {
        if ((error as DOMException)?.name !== "AbortError") {
          state.setSegmentationStatus("error");
          throw error;
        }
        if (effectivePreprocessConfig) {
          useAsrStore.getState().setPreprocessingStatus("idle");
        }
      } finally {
        await deleteSessionSegments(segmentSessionId);
      }
    },
    [updateOverallConfidence]
  );

  const startUploadTranscription = useCallback(async (file: File) => {
    const state = useAsrStore.getState();
    if (state.isTranscribing) {
      toast("Une transcription est déjà en cours.");
      return;
    }
    clearErrorResetTimer();
    const runId = sharedRunIdRef.current + 1;
    sharedRunIdRef.current = runId;

    // Preserve the debug toggle explicitly so that any transient resets inside the
    // transcription flow do not change the UI state.
    const previousDebug = state.debugConfidence;

    // Prepare for a new transcription without resetting the entire app state.
    // This avoids clearing UI toggles like `debugConfidence` and other persisted settings.
    // If you need a full page reload on start, set Vite env var VITE_RELOAD_ON_START=1 at build time.
    const _env = (import.meta as unknown as { env?: { VITE_RELOAD_ON_START?: string } }).env;
    const reloadOnStart = _env?.VITE_RELOAD_ON_START === '1';
    if (reloadOnStart && typeof window !== 'undefined') {
      window.location.reload();
      return;
    }

    // Minimal cleanup: clear progress, segments, chunk plan and telemetry summary.
    state.resetStopRequest();
    state.setProgress(0);
    state.setSegments([]);
    state.setChunkPlan([]);
    state.setTelemetrySummary(null);
    state.setSegmentationStatus("idle");
    state.setSegmentationProgress(0);
    resetConfidenceAccumulator();
    progressThrottleRef.current = 0;
    segmentationThrottleRef.current = 0;
    preprocessThrottleRef.current = 0;

    const metadata = await probeAudioMetadata(file);
    const source = { id: crypto.randomUUID(), label: file.name, type: "file" as const };
    state.registerAudioSource(source, metadata);

    const autoProgressiveThresholdSec = 15 * 60;
    let effectiveMemoryMode = state.memoryMode;
    if (metadata.durationSec > autoProgressiveThresholdSec && state.memoryMode === "full") {
      effectiveMemoryMode = "progressive";
      state.setMemoryMode("progressive");
      toast("Audio > 15 min : passage automatique en mode progressif.");
      logger.info("[memory-mode] auto switched to progressive", {
        durationSec: metadata.durationSec,
        thresholdSec: autoProgressiveThresholdSec,
      });
    }

    const telemetry = new TelemetryCollector();
    state.registerTelemetry(telemetry);
    state.setStatus("downloading", "Chargement du pipeline");
    state.setIsTranscribing(true);

    const shouldPreprocess = state.preprocessingMode === "full" || effectiveMemoryMode === "progressive";
    const calibrationRequested = Boolean(state.noiseCalibrationRequestedAt);
    const preprocessConfig = shouldPreprocess
      ? {
          noiseFloorDb: state.denoiseNoiseFloorDb,
          reductionDb: state.denoiseReductionDb,
          smoothing: state.denoiseSmoothing,
          calibrationSeconds: state.denoiseCalibrationSeconds,
          noiseProfile: undefined as Float32Array | undefined,
          preprocessEnableFilters: state.preprocessEnableFilters,
          preprocessHighpassHz: state.preprocessHighpassHz,
          preprocessLowpassHz: state.preprocessLowpassHz,
          preprocessEnableLufs: state.preprocessEnableLufs,
          preprocessTargetLufs: state.preprocessTargetLufs,
          preprocessLimiterEnabled: state.preprocessLimiterEnabled,
          preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
          preprocessLimiterSoftness: state.preprocessLimiterSoftness,
          preprocessVadEnabled: state.preprocessVadEnabled,
          preprocessVadThresholdDb: state.preprocessVadThresholdDb,
          preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
          preprocessOverlapAdd: state.preprocessOverlapAdd,
          preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
          preprocessOverlapSec: state.preprocessOverlapSec,
        }
      : null;
    if (shouldPreprocess) {
      logger.info("[preprocess] active", { ...preprocessConfig, memoryMode: effectiveMemoryMode });
      state.clearNoiseCalibrationRequest();
      if (calibrationRequested) {
        logger.info("[preprocess] calibration requested (1s noise capture)");
        telemetry.logEvent("CALIBRATION_REQUESTED");
      }
    }

    let activePipeline: AutomaticSpeechRecognitionPipeline | null = null;
    let failed = false;
    try {
      // If we're in full-memory mode and preprocessing (quick or full) is requested, perform
      // decode + calibration (quick) or full preprocess **before** loading the model so that
      // heavy preprocess work does not compete with model initialization.
      let preDecoded: import("@/lib/audio").DecodedAudio | undefined;
      let preApplied = false;
      if (effectiveMemoryMode === "full" && (state.preprocessingMode === "full" || state.preprocessingMode === "quick")) {
        state.setPreprocessingStatus("calibrating");
        state.setPreprocessingProgress(0);
        // Full decode is required for both quick and full modes to derive a noise profile
        try {
          preDecoded = await decodeFileFully(file, telemetry);
          const pcmBytes = preDecoded.pcm.byteLength;
          const pcmMb = pcmBytes / (1024 * 1024);
          logger.info("[decode] pre-model full decode RAM footprint", {
            samples: preDecoded.pcm.length,
            sampleRate: preDecoded.sampleRate,
            pcmBytes,
            pcmMb: Number(pcmMb.toFixed(2)),
          });
          telemetry.logEvent("RAM_USAGE", {
            context: "pre_model_full_decode_pcm",
            bytes: pcmBytes,
            mb: Number(pcmMb.toFixed(3)),
            samples: preDecoded.pcm.length,
            sampleRate: preDecoded.sampleRate,
          });

          // Estimate noise profile (quick mode: only calibration; full mode: we will apply the full preprocessing)
          try {
            state.setPreprocessingStatus("calibrating");
            state.setPreprocessingProgress(0);
            const { profile, frames, vadUsed, silenceRanges } = estimateNoiseProfileWithVad(
              preDecoded.pcm,
              preDecoded.sampleRate,
              state.denoiseCalibrationSeconds,
              state.preprocessVadThresholdDb,
              state.preprocessVadMinSilenceMs
            );
            telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "pre-model", vadUsed, silenceRanges });

            // Auto-tune if enabled
            if (state.autoTunePreprocess) {
              const tune = computePreprocessParams(profile, preDecoded.pcm.subarray(0, Math.floor(state.denoiseCalibrationSeconds * preDecoded.sampleRate)));
              state.setDenoiseParams({
                denoiseNoiseFloorDb: tune.noiseFloorDb,
                denoiseReductionDb: tune.reductionDb,
                denoiseSmoothing: tune.smoothing,
                denoiseCalibrationSeconds: state.denoiseCalibrationSeconds,
              });
              state.setPreprocessParams({
                preprocessTargetLufs: tune.targetLufs,
                preprocessHighpassHz: tune.highpassHz,
                preprocessLowpassHz: tune.lowpassHz,
                preprocessLimiterThresholdDb: tune.limiterThresholdDb,
                preprocessLimiterSoftness: tune.limiterSoftness,
                preprocessVadThresholdDb: tune.vadThresholdDb,
                preprocessOverlapBlockSec: tune.overlapBlockSec,
                preprocessOverlapSec: tune.overlapSec,
              });
              state.setLastAutoTuneParams({
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
              logger.info("[preprocess][autotune] pre-model applied", {
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
              });
              telemetry.logEvent("PREPROCESS_AUTOTUNE", {
                source: "pre-model",
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
            }

            // Build preprocessConfig to pass into pipeline handlers. For full mode we will apply the heavy preprocessing now.
            if (state.preprocessingMode === "full") {
              state.setPreprocessingStatus("processing");
              state.setPreprocessingProgress(0);
              const processed = await preprocessDecodedAudio(preDecoded, {
                noiseFloorDb: state.denoiseNoiseFloorDb,
                reductionDb: state.denoiseReductionDb,
                smoothing: state.denoiseSmoothing,
                calibrationSeconds: state.denoiseCalibrationSeconds,
                noiseProfile: profile,
                preprocessEnableFilters: state.preprocessEnableFilters,
                preprocessHighpassHz: state.preprocessHighpassHz,
                preprocessLowpassHz: state.preprocessLowpassHz,
                preprocessEnableLufs: state.preprocessEnableLufs,
                preprocessTargetLufs: state.preprocessTargetLufs,
                preprocessLimiterEnabled: state.preprocessLimiterEnabled,
                preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
                preprocessLimiterSoftness: state.preprocessLimiterSoftness,
                preprocessVadEnabled: state.preprocessVadEnabled,
                preprocessVadThresholdDb: state.preprocessVadThresholdDb,
                preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
                preprocessOverlapAdd: state.preprocessOverlapAdd,
                preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
                preprocessOverlapSec: state.preprocessOverlapSec,
              }, telemetry);
              // Replace preDecoded with processed pcm so downstream chunking uses preprocessed audio
              preDecoded = {
                metadata: preDecoded.metadata,
                pcm: processed.pcm,
                sampleRate: processed.sampleRate,
              };
              state.setPreprocessingProgress(1);
              state.setPreprocessingStatus("done");
              preApplied = true;
            } else {
              // quick mode: expose noiseProfile but do not apply the heavy gate; mark calibration done
              state.setPreprocessingProgress(1);
              state.setPreprocessingStatus("done");
            }

            // Prepare a preprocessConfig object to pass down for per-chunk behavior and confidence tuning
            const preprocessConfigToPass = {
              noiseFloorDb: state.denoiseNoiseFloorDb,
              reductionDb: state.denoiseReductionDb,
              smoothing: state.denoiseSmoothing,
              calibrationSeconds: state.denoiseCalibrationSeconds,
              // include the estimated noise profile so downstream flows (or progressive) can reuse it
              noiseProfile: profile,
              preprocessEnableFilters: state.preprocessEnableFilters,
              preprocessHighpassHz: state.preprocessHighpassHz,
              preprocessLowpassHz: state.preprocessLowpassHz,
              preprocessEnableLufs: state.preprocessEnableLufs,
              preprocessTargetLufs: state.preprocessTargetLufs,
              preprocessLimiterEnabled: state.preprocessLimiterEnabled,
              preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
              preprocessLimiterSoftness: state.preprocessLimiterSoftness,
              preprocessVadEnabled: state.preprocessVadEnabled,
              preprocessVadThresholdDb: state.preprocessVadThresholdDb,
              preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
              preprocessOverlapAdd: state.preprocessOverlapAdd,
              preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
              preprocessOverlapSec: state.preprocessOverlapSec,
            } as const;
            // store on the local scope to pass later to handlers
            (telemetry as unknown as { __preprocessConfig?: unknown }).__preprocessConfig = preprocessConfigToPass;
          } catch (err) {
            logger.warn("Pre-model calibration failed", err);
            telemetry.recordAlert("PREPROCESS_CALIBRATION_FAILED", { message: (err as Error).message });
            state.setPreprocessingStatus("idle");
            state.setPreprocessingProgress(0);
          }
        } catch (err) {
          logger.warn("Pre-model full decode failed", err);
        }
      }

      const { pipeline, backend, modelId } = await createAsrPipeline({
        modelPreset: state.activePreset,
        customModelId: state.customModelId,
        backendPreference: state.backendPreference,
        forceSingleThread: state.forceSingleThread,
        telemetry,
        onStatus: (status, detail) => state.setStatus(status, detail),
      });
      activePipeline = pipeline;
      state.setActiveBackend(backend);
      telemetry.setRuntimeContext({ backend, modelId });

      if (effectiveMemoryMode === "full") {
        // If we precomputed decoded/preprocessed audio, pass it to avoid re-decoding and to ensure the preprocessed pcm is used
        const preProc = (telemetry as unknown as { __preprocessConfig?: unknown }).__preprocessConfig as SpectralGateParams | undefined;
        const preprocessConfigArg: SpectralGateParams | null = preprocessConfig ?? (preProc ?? null);
        await handleFullPipeline({ file, telemetry, pipeline, source, preprocessConfig: preprocessConfigArg, preDecoded, preprocessed: preApplied, runId });
      } else {
        await handleProgressivePipeline({ file, telemetry, pipeline, source, preprocessConfig, runId });
      }

      // Compute overall transcription confidence (duration-weighted average)
      try {
        const { computeOverallConfidence, computeOverallConfidenceSource } = await import("@/lib/confidence");
        const segments = useAsrStore.getState().segments;
        const overall = computeOverallConfidence(segments);
        const source = computeOverallConfidenceSource(segments);
        useAsrStore.getState().setTranscriptionConfidence(overall);
        useAsrStore.getState().setTranscriptionConfidenceSource(source);
        logger.info("Computed transcript confidence", { overall, source });
      } catch (err) {
        logger.warn("Failed to compute transcript confidence", err);
      }

      telemetry.logEvent("STOPPED");
      const summary = telemetry.exportSummary();
      state.setTelemetrySummary(summary);
      toast("Transcription terminée.");
      state.setStatus("ready", "Prêt");
    } catch (error) {
      failed = true;
      logger.error(error);
      const message = (error as Error)?.message ?? String(error ?? "Erreur inconnue");
      if (isModelTooLargeError(error)) {
        const fallbackPreset = resolveLighterPresetForMemoryFallback(state.activePreset, state.blockedPresets);
        if (fallbackPreset) {
          const previousPreset = state.activePreset;
          state.setPreset(fallbackPreset);
          logger.warn("[memory-fallback] switched upload preset after OOM", {
            from: previousPreset,
            to: fallbackPreset,
            message,
          });
          const fallbackLabel = MODEL_PRESETS[fallbackPreset].label;
          const friendly = `Erreur mémoire (modèle trop gros pour cette plateforme). Preset basculé automatiquement vers "${fallbackLabel}". Relancez la transcription.`;
          state.setStatus("error", friendly);
          toast(friendly);
        } else {
          const friendly =
            "Erreur : modèle trop gros pour cette plateforme (mémoire insuffisante). Aucun preset plus léger n'est disponible, activez le mode single-thread ou utilisez un modèle custom plus petit.";
          state.setStatus("error", friendly);
          toast(friendly);
        }
      } else {
        state.setStatus("error", message);
        toast(`Échec de la transcription : ${message}`);
      }
    } finally {
      if (activePipeline) {
        await disposePipeline(activePipeline);
      }
      if (failed) {
        state.setIsTranscribing(false);
        state.resetStopRequest();
        state.registerTelemetry(null);
        scheduleErrorReset(runId);
      } else {
        state.setIsTranscribing(false);
        state.resetStopRequest();
        state.registerTelemetry(null);
      }
      // Restore debug toggle to previous value in case any flow changed it
      state.setDebugConfidence(previousDebug);
      sharedAbortRef.current = null;
    }
  }, [clearErrorResetTimer, handleFullPipeline, handleProgressivePipeline, scheduleErrorReset]);

  const stopTranscription = useCallback(() => {
    const state = useAsrStore.getState();
    if (!state.isTranscribing) return;
    state.requestStop();
    state.setStatus("stopping", "Arrêt après le chunk courant");
  }, []);

  // Immediately abort any in-progress transcription (used for reset/cleanup)
  const abortTranscription = useCallback(() => {
    sharedRunIdRef.current += 1;
    clearErrorResetTimer();
    const state = useAsrStore.getState();
    if (!state.isTranscribing) {
      return;
    }
    state.setStatus("stopping", "Arrêt forcé");
    // also mark stop requested to help existing flows terminate
    state.requestStop();
    if (sharedAbortRef.current) {
      sharedAbortRef.current.abort();
    }
    const start = Date.now();
    const timeoutMs = 15000;
    return new Promise<void>((resolve) => {
      const tick = () => {
        const snapshot = useAsrStore.getState();
        if (!snapshot.isTranscribing) {
          resolve();
          return;
        }
        if (!sharedAbortRef.current) {
          resolve();
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          resolve();
          return;
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }, [clearErrorResetTimer]);

  return {
    startUploadTranscription,
    stopTranscription,
    abortTranscription,
    isTranscribing,
  };


  function shouldStopAfterChunk(runId?: number) {
    const snapshot = useAsrStore.getState();
    if (typeof runId === "number" && runId !== sharedRunIdRef.current) {
      return true;
    }
    return snapshot.stopRequested;
  }

  function teleportStateToReady() {
    const state = useAsrStore.getState();
    state.setStatus("transcribing", "Transcription en cours");
  }
}

export function normaliseSegments(
  result: Awaited<ReturnType<typeof transcribeChunk>>,
  segmentationMode: "chunks" | "silence",
  startIndex: number,
  previous?: TranscriptionSegment,
  options?: { enableWordTimestamps?: boolean; dedupeMode?: DedupeMode }
): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  const dedupeMode = options?.dedupeMode ?? useAsrStore.getState().dedupeMode;
  if (segmentationMode === "chunks") {
    const trimmed = trimChunkOverlap(previous?.text, result.text, dedupeMode);
    const text = trimmed.text.trim();
    if (trimmed.overlapWords > 0) {
      logger.info("Trimmed chunk overlap", { overlapWords: trimmed.overlapWords, chunkId: result.chunk.id });
      try {
        const telemetry = useAsrStore.getState().telemetryCollector;
        telemetry?.logEvent("SEGMENT_DEDUP", { overlapWords: trimmed.overlapWords, mode: "chunks", dedupeMode });
      } catch (err) {
        void err;
      }
    }
    if (text.length) {
      const enableWordTimestamps =
        typeof options?.enableWordTimestamps === "boolean"
          ? options.enableWordTimestamps
          : useAsrStore.getState().enableWordTimestamps;
      // If the pipeline returned fine-grained segments inside this chunk, use them for words and for computing confidence
      const words: WordSegment[] | undefined = enableWordTimestamps && Array.isArray(result.segments)
        ? result.segments.map((s) => ({
            word: s.text.trim(),
            start: s.start,
            end: s.end,
            confidence: s.confidence,
          }))
        : undefined;

      if (words && words.length) {
        logger.info("Attaching word timestamps to chunk segment", { chunkId: result.chunk.id, wordCount: words.length });
      }

      // Compute aggregated confidence for this chunk segment from child segments' confidences when available
      let aggregateConf: number | undefined;
      let usedModelConf = false;
      if (Array.isArray(result.segments) && result.segments.length) {
        const items = result.segments
          .map((s) => ({ conf: s.confidence, dur: Math.max(0.001, (s.end ?? s.start) - (s.start ?? 0)) }))
          .filter((x) => typeof x.conf === "number" && !Number.isNaN(x.conf));
        if (items.length) {
          const totalDur = items.reduce((acc, it) => acc + it.dur, 0);
          const weighted = items.reduce((acc, it) => acc + (it.conf ?? 0) * it.dur, 0) / totalDur;
          aggregateConf = Math.max(0, Math.min(1, weighted));
          usedModelConf = true;
        }
      }

      // If we couldn't get a numeric aggregate confidence from child segments, estimate from text
      if (typeof aggregateConf !== "number" || Number.isNaN(aggregateConf)) {
        try {
          const dur = Math.max(0.001, (result.chunk.end ?? result.chunk.start) - (result.chunk.start ?? 0));
          aggregateConf = estimateConfidenceFromText(text, dur);
          logger.info("Computed chunk confidence from text", { chunkId: result.chunk.id, aggregateConf });
        } catch (err) {
          void err;
        }
      }

      logger.info("Chunk aggregate confidence", { chunkId: result.chunk.id, aggregateConf });

      segments.push({
        index: startIndex,
        start: result.chunk.start,
        end: result.chunk.end,
        text,
        chunkId: result.chunk.id,
        strategy: "chunks",
        confidence: typeof aggregateConf === "number" ? aggregateConf : undefined,
        confidenceSource: usedModelConf ? 'model' : 'estimated',
        words,
      });

      // Optional detailed debug for chunk-level estimate
      try {
        if (useAsrStore.getState().debugConfidence && typeof aggregateConf === 'number') {
          const details = scoreDetails(text, Math.max(0.001, (result.chunk.end ?? result.chunk.start) - (result.chunk.start ?? 0)));
          logger.info("Chunk confidence details", { chunkId: result.chunk.id, source: usedModelConf ? 'model' : 'estimated', ...details });
        }
      } catch (err) {
        void err;
      }
    }
    return segments;
  }

  let idx = startIndex;
  let last = previous;
  for (const segment of result.segments) {
    let text = segment.text.trim();
    if (!text.length) continue;
    let start = segment.start;
    const end = segment.end;
    let segmentWords = (segment as unknown as Record<string, unknown>).words as WordSegment[] | undefined;
    const gap = last ? start - last.end : Number.POSITIVE_INFINITY;
    if (last && gap < 1) {
      if (text === last.text) {
        continue;
      }
      const trimmed = trimChunkOverlap(last.text, text, dedupeMode);
      if (trimmed.overlapWords > 0) {
        try {
          const telemetry = useAsrStore.getState().telemetryCollector;
          telemetry?.logEvent("SEGMENT_DEDUP", { overlapWords: trimmed.overlapWords, mode: "silence", dedupeMode });
        } catch (err) {
          void err;
        }
        text = trimmed.text.trim();
        if (!text.length) {
          continue;
        }
        if (Array.isArray(segmentWords) && segmentWords.length) {
          const cutCount = Math.min(segmentWords.length, Math.max(trimmed.removedTokens, trimmed.overlapWords));
          segmentWords = segmentWords.slice(cutCount);
          if (segmentWords.length) {
            start = segmentWords[0]!.start;
          }
        }
      }
    }
    if (last && gap < 1) {
      const debris = trimDebrisPrefix(last.text, text);
      if (debris.removedTokens > 0) {
        text = debris.text.trim();
        if (!text.length) {
          continue;
        }
        if (Array.isArray(segmentWords) && segmentWords.length) {
          const cutCount = Math.min(segmentWords.length, debris.removedTokens);
          segmentWords = segmentWords.slice(cutCount);
          if (segmentWords.length) {
            start = segmentWords[0]!.start;
          }
        }
      }
    }

    const item: TranscriptionSegment = {
      index: idx,
      start,
      end,
      text,
      chunkId: result.chunk.id,
      strategy: "silence",
      confidence: segment.confidence,
      confidenceSource: typeof segment.confidence === 'number' ? 'model' : undefined,
      words: segmentWords,
    };

    // If confidence is missing, compute it from per-word confidences when available
    if (typeof item.confidence !== "number" && Array.isArray(item.words) && item.words!.length) {
      const wordItems = (item.words as WordSegment[])
        .map((w) => ({ conf: w.confidence, dur: Math.max(0.001, w.end - w.start) }))
        .filter((x) => typeof x.conf === "number" && !Number.isNaN(x.conf));
      if (wordItems.length) {
        const tot = wordItems.reduce((a, b) => a + b.dur, 0);
        const weighted = wordItems.reduce((a, b) => a + (b.conf ?? 0) * b.dur, 0) / tot;
        item.confidence = Math.max(0, Math.min(1, weighted));
        item.confidenceSource = 'model';
        logger.info("Computed segment confidence from words", { index: item.index, confidence: item.confidence });
      }
    } else if (typeof item.confidence === 'number') {
      // segment had a numeric confidence supplied by the pipeline
      item.confidenceSource = 'model';
      logger.info("Segment confidence present", { index: item.index, confidence: item.confidence });    }
    if (typeof item.confidence !== "number" || Number.isNaN(item.confidence)) {
      try {
        const dur = Math.max(0.001, item.end - item.start);
        item.confidence = estimateConfidenceFromText(item.text, dur);
        item.confidenceSource = 'estimated';
        logger.info("Computed segment confidence from text", { index: item.index, confidence: item.confidence });
        // Detailed debug when requested
        try {
          if (useAsrStore.getState().debugConfidence) {
            const details = scoreDetails(item.text, dur);
            logger.info("Segment confidence details", { index: item.index, source: item.confidenceSource, ...details });
          }
        } catch (err) {
          void err;
        }
      } catch (err) {
        void err;
      }
    }

    segments.push(item);
    last = item;
    idx += 1;
  }
  return segments;
}

function trimChunkOverlap(
  previousText: string | undefined,
  currentText: string,
  mode: DedupeMode
): { text: string; overlapWords: number; removedTokens: number } {
  if (mode === "fuzzy") {
    return trimChunkOverlapFuzzy(previousText, currentText);
  }
  return trimChunkOverlapExact(previousText, currentText);
}

const MAX_OVERLAP_TOKENS = 30;
const MIN_OVERLAP_TOKENS = 2;
const MAX_PREFIX_OFFSET = 2;
const FUZZY_TOKEN_THRESHOLD = 0.75;
const FUZZY_CHAR_THRESHOLD = 0.78;
const MAX_DEBRIS_PREFIX_TOKENS = 3;
const MIN_DEBRIS_REMAINING_TOKENS = 2;
const CONTINUATION_TOKENS = new Set([
  "de",
  "du",
  "des",
  "d",
  "l",
  "la",
  "le",
  "les",
  "que",
  "qui",
  "pour",
  "avec",
  "dans",
  "sur",
  "en",
  "au",
  "aux",
]);
const VERB_LIKE_TOKENS = new Set([
  "est",
  "sont",
  "ete",
  "etaient",
  "etait",
  "a",
  "ont",
  "avait",
  "avaient",
  "sera",
  "seront",
  "etre",
  "avoir",
  "fait",
  "font",
  "faisait",
  "faisaient",
  "dit",
  "disent",
  "peut",
  "peuvent",
  "doit",
  "doivent",
  "va",
  "vont",
  "allait",
  "allaient",
]);

function trimChunkOverlapExact(previousText: string | undefined, currentText: string): { text: string; overlapWords: number; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length) {
    return { text: "", overlapWords: 0, removedTokens: 0 };
  }
  if (!previousText) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }

  const prevTrimmed = previousText.trim();
  if (!prevTrimmed.length) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }
  if (candidate === prevTrimmed) {
    const count = candidate.split(/\s+/).length;
    return { text: "", overlapWords: count, removedTokens: count };
  }

  const prevRawTokens = prevTrimmed.split(/\s+/);
  const currentRawTokens = candidate.split(/\s+/);
  const prevTokens = prevRawTokens.map((token) => normalizeToken(token));
  const currentTokens = currentRawTokens.map((token) => normalizeToken(token));
  const prevFiltered = prevTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const currentFiltered = currentTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const overlap = findOverlap(prevFiltered, currentFiltered, "exact");
  if (overlap) {
    return {
      text: currentRawTokens.slice(overlap.lastOverlapIndex + 1).join(" "),
      overlapWords: overlap.overlapWords,
      removedTokens: overlap.removedTokens,
    };
  }

  return { text: candidate, overlapWords: 0, removedTokens: 0 };
}

function trimChunkOverlapFuzzy(previousText: string | undefined, currentText: string): { text: string; overlapWords: number; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length) {
    return { text: "", overlapWords: 0, removedTokens: 0 };
  }
  if (!previousText) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }

  const prevTrimmed = previousText.trim();
  if (!prevTrimmed.length) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }
  if (candidate === prevTrimmed) {
    const count = candidate.split(/\s+/).length;
    return { text: "", overlapWords: count, removedTokens: count };
  }

  const prevRawTokens = prevTrimmed.split(/\s+/);
  const currentRawTokens = candidate.split(/\s+/);
  const prevTokens = prevRawTokens.map((token) => normalizeToken(token));
  const currentTokens = currentRawTokens.map((token) => normalizeToken(token));
  const prevFiltered = prevTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const currentFiltered = currentTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const overlap = findOverlap(prevFiltered, currentFiltered, "fuzzy");
  if (overlap) {
    return {
      text: currentRawTokens.slice(overlap.lastOverlapIndex + 1).join(" "),
      overlapWords: overlap.overlapWords,
      removedTokens: overlap.removedTokens,
    };
  }

  return { text: candidate, overlapWords: 0, removedTokens: 0 };
}

type FilteredToken = { token: string; index: number };

function findOverlap(prevFiltered: FilteredToken[], currentFiltered: FilteredToken[], mode: "exact" | "fuzzy") {
  const maxOverlap = Math.min(prevFiltered.length, currentFiltered.length, MAX_OVERLAP_TOKENS);
  for (let size = maxOverlap; size >= MIN_OVERLAP_TOKENS; size -= 1) {
    const prevSlice = prevFiltered.slice(prevFiltered.length - size);
    const maxOffset = Math.min(MAX_PREFIX_OFFSET, currentFiltered.length - size);
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const currentSlice = currentFiltered.slice(offset, offset + size);
      if (!currentSlice.length) continue;
      if (!slicesMatch(prevSlice, currentSlice, mode)) continue;
      const lastOverlapIndex = currentSlice[size - 1]!.index;
      return {
        overlapWords: size,
        lastOverlapIndex,
        removedTokens: lastOverlapIndex + 1,
      };
    }
  }
  return null;
}

function slicesMatch(prevSlice: FilteredToken[], currentSlice: FilteredToken[], mode: "exact" | "fuzzy"): boolean {
  if (mode === "exact") {
    for (let i = 0; i < prevSlice.length; i += 1) {
      if (prevSlice[i]!.token !== currentSlice[i]!.token) {
        return false;
      }
    }
    return true;
  }

  let matches = 0;
  for (let i = 0; i < prevSlice.length; i += 1) {
    if (areTokensSimilar(prevSlice[i]!.token, currentSlice[i]!.token)) {
      matches += 1;
    }
  }
  const similarity = matches / prevSlice.length;
  if (similarity >= FUZZY_TOKEN_THRESHOLD) {
    return true;
  }

  const prevStr = prevSlice.map((item) => item.token).join(" ");
  const currentStr = currentSlice.map((item) => item.token).join(" ");
  return diceCoefficient(prevStr, currentStr) >= FUZZY_CHAR_THRESHOLD;
}

function normalizeToken(token: string): string {
  try {
    return token
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  } catch (err) {
    void err;
    return token.toLowerCase().replace(/[^a-z0-9]+/gi, "");
  }
}

function trimDebrisPrefix(previousText: string | undefined, currentText: string): { text: string; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length || !previousText) {
    return { text: candidate, removedTokens: 0 };
  }
  if (endsWithTerminalPunctuation(previousText)) {
    return { text: candidate, removedTokens: 0 };
  }
  if (!endsWithContinuation(previousText)) {
    return { text: candidate, removedTokens: 0 };
  }

  const rawTokens = candidate.split(/\s+/);
  if (rawTokens.length <= MAX_DEBRIS_PREFIX_TOKENS) {
    return { text: candidate, removedTokens: 0 };
  }

  const firstToken = rawTokens[0] ?? "";
  if (startsWithUppercase(firstToken)) {
    return { text: candidate, removedTokens: 0 };
  }

  const prefixTokens = rawTokens.slice(0, MAX_DEBRIS_PREFIX_TOKENS);
  const normalizedPrefix = prefixTokens.map((token) => normalizeToken(token)).filter((token) => token.length);
  if (normalizedPrefix.some((token) => isVerbLike(token))) {
    return { text: candidate, removedTokens: 0 };
  }

  if (rawTokens.length - prefixTokens.length < MIN_DEBRIS_REMAINING_TOKENS) {
    return { text: candidate, removedTokens: 0 };
  }

  return { text: rawTokens.slice(prefixTokens.length).join(" "), removedTokens: prefixTokens.length };
}

function endsWithTerminalPunctuation(text: string): boolean {
  return /[.!?…]$/.test(text.trim());
}

function endsWithContinuation(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  if (/(?:d|l|qu|s)['’]$/.test(trimmed)) {
    return true;
  }
  const lastRaw = trimmed.split(/\s+/).pop() ?? "";
  const normalized = normalizeToken(lastRaw);
  return CONTINUATION_TOKENS.has(normalized);
}

function startsWithUppercase(token: string): boolean {
  return /^[A-ZÀ-ÖØ-Ý]/.test(token);
}

function isVerbLike(token: string): boolean {
  if (!token) return false;
  if (VERB_LIKE_TOKENS.has(token)) return true;
  return token.endsWith("er") || token.endsWith("ir") || token.endsWith("re");
}

function areTokensSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length <= 3 || b.length <= 3) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return diceCoefficient(a, b) >= 0.72;
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const aBigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    aBigrams.set(gram, (aBigrams.get(gram) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = aBigrams.get(gram);
    if (count) {
      intersection += 1;
      if (count === 1) {
        aBigrams.delete(gram);
      } else {
        aBigrams.set(gram, count - 1);
      }
    }
  }
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}
