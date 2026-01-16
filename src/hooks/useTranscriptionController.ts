import { useCallback, useRef } from "react";
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
import { preprocessDecodedAudio, estimateNoiseProfile, computePreprocessParams } from "@/lib/preprocessing";
import { createSegmentCache } from "@/lib/segmenter";
import { deleteSegment, deleteSessionSegments, getSegment } from "@/lib/segment-cache";
import { TelemetryCollector } from "@/lib/telemetry";
import type { TranscriptionSegment, WordSegment } from "@/lib/export";
import { useAsrStore } from "@/store/asr-store";

export function useTranscriptionController() {
  const abortRef = useRef<AbortController | null>(null);

  const isTranscribing = useAsrStore((state) => state.isTranscribing);

  const handleFullPipeline = useCallback(
    async ({
      file,
      telemetry,
      pipeline,
      source,
      preprocessConfig,
      preDecoded,
      preprocessed,
    }: {
      file: File;
      telemetry: TelemetryCollector;
      pipeline: AutomaticSpeechRecognitionPipeline;
      source: { id: string; label: string; type: "file" };
      preprocessConfig?: {
        noiseFloorDb: number;
        reductionDb: number;
        smoothing: number;
        calibrationSeconds: number;
        noiseProfile?: Float32Array;
      } | null;
      preDecoded?: import("@/lib/audio").DecodedAudio | null;
      preprocessed?: boolean | null;
    }) => {
      const state = useAsrStore.getState();
      teleportStateToReady();

      logger.info("[decode] full decode start", {
        fileName: file.name,
        mode: preprocessConfig ? "complete-preprocess" : "full-memory",
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
          const preModel = (telemetry as unknown as { __preprocessConfig?: unknown }).__preprocessConfig as { noiseProfile?: Float32Array } | undefined;
          try {
            if (!preprocessConfig.noiseProfile) {
              if (preModel && preModel.noiseProfile) {
                preprocessConfig.noiseProfile = preModel.noiseProfile;
                telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames: 0, source: "pre-model-reuse" });
              } else {
                useAsrStore.getState().setPreprocessingStatus("calibrating");
                useAsrStore.getState().setPreprocessingProgress(0);
                const { profile, frames } = estimateNoiseProfile(
                  decoded.pcm,
                  decoded.sampleRate,
                  preprocessConfig.calibrationSeconds
                );
                preprocessConfig.noiseProfile = profile;
                telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "auto" });

                // Auto-tune gate parameters if enabled
                if (state.autoTunePreprocess) {
                  const tune = computePreprocessParams(profile, decoded.pcm.subarray(0, Math.floor(preprocessConfig.calibrationSeconds * decoded.sampleRate)));
                  preprocessConfig.noiseFloorDb = tune.noiseFloorDb;
                  preprocessConfig.reductionDb = tune.reductionDb;
                  preprocessConfig.smoothing = tune.smoothing;
                  // apply autotuned params to global settings so sliders reflect current autotune
                  useAsrStore.getState().setDenoiseParams({ denoiseNoiseFloorDb: tune.noiseFloorDb, denoiseReductionDb: tune.reductionDb, denoiseSmoothing: tune.smoothing });
                  useAsrStore.getState().setLastAutoTuneParams({ noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
                  logger.info("[preprocess][autotune] full applied", { noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing, snrDb: tune.snrDb });
                  telemetry.logEvent("PREPROCESS_AUTOTUNE", { source: "auto", snrDb: tune.snrDb, noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
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

      state.setChunkPlan(chunkPlan);

      let nextIndex = state.segments.length;
      let lastSegment = state.segments.at(-1);
      const totalChunks = chunkPlan.length || 1;

      for (const definition of chunkPlan) {
        if (shouldStopAfterChunk()) {
          break;
        }
        const chunkPcm = extractChunkPcm(decoded.pcm, decoded.sampleRate, definition);
        const result = await transcribeChunk({
          pipeline,
          chunk: definition,
          pcm: chunkPcm,
          sampleRate: decoded.sampleRate,
          telemetry,
        });
        logger.info("[decode] full decode start", { chunk: definition });

        const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment);
        if (segments.length) {
          nextIndex += segments.length;
          lastSegment = segments[segments.length - 1];
          state.appendSegments(segments);

          // Recompute overall confidence immediately after appending segments (full pipeline mode)
          try {
            const segs = useAsrStore.getState().segments;
            const numericCount = segs.filter((s) => typeof s.confidence === "number").length;
            logger.info("Overall confidence debug", { totalSegments: segs.length, numericConfidences: numericCount });
            const { computeOverallConfidence, computeOverallConfidenceSource } = await import("@/lib/confidence");
            let overall = computeOverallConfidence(segs);
            // If no numeric segment confidences but the chunk has text, estimate from the chunk text
            let fallbackUsed = false;
            if (overall === null && typeof result?.text === "string" && result.text.trim().length) {
              try {
                const dur = Math.max(0.001, (definition.end ?? definition.start) - (definition.start ?? 0));
                const est = estimateConfidenceFromText(result.text, dur);
                overall = Math.max(0, Math.min(1, est));
                fallbackUsed = true;
                logger.info("Computed overall from chunk text (fallback)", { chunkIndex: definition.index, est, overall });
              } catch (err) {
                void err;
              }
            }
            const source = computeOverallConfidenceSource(segs) ?? (fallbackUsed ? 'estimated' : null);
            useAsrStore.getState().setTranscriptionConfidence(overall);
            useAsrStore.getState().setTranscriptionConfidenceSource(source);
            telemetry?.logEvent("PROGRESS_CONFIDENCE", { chunkIndex: definition.index, overall });
            logger.info("Progressive transcript confidence (full)", { chunkIndex: definition.index, overall, source });
          } catch (err) {
            logger.warn("Failed to compute progressive transcript confidence (full)", err);
          }
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
        state.setProgress((definition.index + 1) / totalChunks);

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
    []
  );

  const handleProgressivePipeline = useCallback(
    async ({
      file,
      telemetry,
      pipeline,
      source,
      preprocessConfig,
    }: {
      file: File;
      telemetry: TelemetryCollector;
      pipeline: AutomaticSpeechRecognitionPipeline;
      source: { id: string; label: string; type: "file" };
      preprocessConfig?: {
        noiseFloorDb: number;
        reductionDb: number;
        smoothing: number;
        calibrationSeconds: number;
        noiseProfile?: Float32Array;
      } | null;
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
      abortRef.current = abortController;

      const effectivePreprocessConfig = preprocessConfig ?? {
        noiseFloorDb: state.denoiseNoiseFloorDb,
        reductionDb: state.denoiseReductionDb,
        smoothing: state.denoiseSmoothing,
        calibrationSeconds: state.denoiseCalibrationSeconds,
        noiseProfile: undefined as Float32Array | undefined,
      };
      logger.info("[preprocess] progressive segment mode", {
        enabled: Boolean(effectivePreprocessConfig),
        segmentDurationSec,
      });

      try {
        if (segmentPlan.length) {
          state.setSegmentationStatus("segmenting");
          state.setSegmentationProgress(0);
          await createSegmentCache(file, {
            sessionId: segmentSessionId,
            segments: segmentPlan,
            telemetry,
            signal: abortController.signal,
            onProgress: (completed, total) => {
              const progress = total > 0 ? completed / total : 0;
              state.setSegmentationProgress(progress);
            },
          });
          state.setSegmentationStatus("done");
        }

        for (const segment of segmentPlan) {
          if (shouldStopAfterChunk()) break;

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
            useAsrStore.getState().setPreprocessingProgress(segment.index / Math.max(1, segmentPlan.length));
            try {
              const { profile, frames } = estimateNoiseProfile(
                segmentPcm,
                segmentSampleRate,
                effectivePreprocessConfig.calibrationSeconds
              );
              telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "segment", segmentIndex: segment.index });
              if (state.autoTunePreprocess) {
                const tune = computePreprocessParams(
                  profile,
                  segmentPcm.subarray(0, Math.floor(effectivePreprocessConfig.calibrationSeconds * segmentSampleRate))
                );
                effectivePreprocessConfig.noiseFloorDb = tune.noiseFloorDb;
                effectivePreprocessConfig.reductionDb = tune.reductionDb;
                effectivePreprocessConfig.smoothing = tune.smoothing;
                useAsrStore.getState().setDenoiseParams({
                  denoiseNoiseFloorDb: tune.noiseFloorDb,
                  denoiseReductionDb: tune.reductionDb,
                  denoiseSmoothing: tune.smoothing,
                });
                useAsrStore.getState().setLastAutoTuneParams({
                  noiseFloorDb: tune.noiseFloorDb,
                  reductionDb: tune.reductionDb,
                  smoothing: tune.smoothing,
                });
                logger.info("[preprocess][autotune] segment applied", {
                  segmentIndex: segment.index,
                  noiseFloorDb: tune.noiseFloorDb,
                  reductionDb: tune.reductionDb,
                  smoothing: tune.smoothing,
                  snrDb: tune.snrDb,
                });
                telemetry.logEvent("PREPROCESS_AUTOTUNE", {
                  source: "segment",
                  segmentIndex: segment.index,
                  snrDb: tune.snrDb,
                  noiseFloorDb: tune.noiseFloorDb,
                  reductionDb: tune.reductionDb,
                  smoothing: tune.smoothing,
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
              useAsrStore.getState().setPreprocessingProgress((segment.index + 1) / Math.max(1, segmentPlan.length));
              useAsrStore.getState().setPreprocessingStatus("done");
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
          const segmentChunkPlanGlobal = offsetChunks(segmentChunkPlan, segment.start, globalChunkIndex);
          globalChunkIndex += segmentChunkPlanGlobal.length;
          state.setChunkPlan([...useAsrStore.getState().chunkPlan, ...segmentChunkPlanGlobal]);

          for (let i = 0; i < segmentChunkPlan.length; i += 1) {
            if (shouldStopAfterChunk()) break;
            const localChunk = segmentChunkPlan[i]!;
            const globalChunk = segmentChunkPlanGlobal[i]!;
            const chunkPcm = extractChunkPcm(segmentPcm, segmentSampleRate, localChunk);
            const result = await transcribeChunk({
              pipeline,
              chunk: globalChunk,
              pcm: chunkPcm,
              sampleRate: segmentSampleRate,
              telemetry,
            });

            const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment);
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
            state.setProgress(progress);

            try {
              const { computeOverallConfidence, computeOverallConfidenceSource } = await import("@/lib/confidence");
              let overall = computeOverallConfidence(useAsrStore.getState().segments);
              let fallbackUsed = false;
              if (overall === null && typeof result?.text === "string" && result.text.trim().length) {
                try {
                  const dur = Math.max(0.001, (globalChunk.end ?? globalChunk.start) - (globalChunk.start ?? 0));
                  const est = estimateConfidenceFromText(result.text, dur);
                  overall = Math.max(0, Math.min(1, est));
                  fallbackUsed = true;
                  logger.info("Computed overall from chunk text (fallback)", { chunkIndex: globalChunk.index, est, overall });
                } catch (err) {
                  void err;
                }
              }
              const source = computeOverallConfidenceSource(useAsrStore.getState().segments) ?? (fallbackUsed ? 'estimated' : null);
              useAsrStore.getState().setTranscriptionConfidence(overall);
              useAsrStore.getState().setTranscriptionConfidenceSource(source);
              telemetry?.logEvent("PROGRESS_CONFIDENCE", { chunkIndex: globalChunk.index, overall });
              logger.info("Progressive transcript confidence", { chunkIndex: globalChunk.index, overall, source });
            } catch (err) {
              logger.warn("Failed to compute progressive transcript confidence", err);
            }

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
        }
      } catch (error) {
        if ((error as DOMException)?.name !== "AbortError") {
          state.setSegmentationStatus("error");
          throw error;
        }
      } finally {
        await deleteSessionSegments(segmentSessionId);
      }
    },
    []
  );

  const startUploadTranscription = useCallback(async (file: File) => {
    const state = useAsrStore.getState();
    if (state.isTranscribing) {
      toast("Une transcription est déjà en cours.");
      return;
    }

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

    const metadata = await probeAudioMetadata(file);
    const source = { id: crypto.randomUUID(), label: file.name, type: "file" as const };
    state.registerAudioSource(source, metadata);

    const telemetry = new TelemetryCollector();
    state.registerTelemetry(telemetry);
    state.setStatus("downloading", "Chargement du pipeline");
    state.setIsTranscribing(true);

    const shouldPreprocess = state.preprocessingMode === "full" || state.memoryMode === "progressive";
    const calibrationRequested = Boolean(state.noiseCalibrationRequestedAt);
    const preprocessConfig = shouldPreprocess
      ? {
          noiseFloorDb: state.denoiseNoiseFloorDb,
          reductionDb: state.denoiseReductionDb,
          smoothing: state.denoiseSmoothing,
          calibrationSeconds: state.denoiseCalibrationSeconds,
          noiseProfile: undefined as Float32Array | undefined,
        }
      : null;
    if (shouldPreprocess) {
      logger.info("[preprocess] active", { ...preprocessConfig, memoryMode: state.memoryMode });
      state.clearNoiseCalibrationRequest();
      if (calibrationRequested) {
        logger.info("[preprocess] calibration requested (1s noise capture)");
        telemetry.logEvent("CALIBRATION_REQUESTED");
      }
    }

    let activePipeline: AutomaticSpeechRecognitionPipeline | null = null;
    try {
      // If we're in full-memory mode and preprocessing (quick or full) is requested, perform
      // decode + calibration (quick) or full preprocess **before** loading the model so that
      // heavy preprocess work does not compete with model initialization.
      let preDecoded: import("@/lib/audio").DecodedAudio | undefined;
      let preApplied = false;
      if (state.memoryMode === "full" && (state.preprocessingMode === "full" || state.preprocessingMode === "quick")) {
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
            const { profile, frames } = estimateNoiseProfile(
              preDecoded.pcm,
              preDecoded.sampleRate,
              state.denoiseCalibrationSeconds
            );
            telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "pre-model" });

            // Auto-tune if enabled
            if (state.autoTunePreprocess) {
              const tune = computePreprocessParams(profile, preDecoded.pcm.subarray(0, Math.floor(state.denoiseCalibrationSeconds * preDecoded.sampleRate)));
              state.setDenoiseParams({ denoiseNoiseFloorDb: tune.noiseFloorDb, denoiseReductionDb: tune.reductionDb, denoiseSmoothing: tune.smoothing, denoiseCalibrationSeconds: state.denoiseCalibrationSeconds });
              state.setLastAutoTuneParams({ noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
              logger.info("[preprocess][autotune] pre-model applied", { noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing, snrDb: tune.snrDb });
              telemetry.logEvent("PREPROCESS_AUTOTUNE", { source: "pre-model", snrDb: tune.snrDb, noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
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
        telemetry,
        onStatus: (status, detail) => state.setStatus(status, detail),
      });
      activePipeline = pipeline;
      state.setActiveBackend(backend);
      telemetry.setRuntimeContext({ backend, modelId });

      if (state.memoryMode === "full") {
        // If we precomputed decoded/preprocessed audio, pass it to avoid re-decoding and to ensure the preprocessed pcm is used
        const preProc = (telemetry as unknown as { __preprocessConfig?: unknown }).__preprocessConfig as ({ noiseFloorDb: number; reductionDb: number; smoothing: number; calibrationSeconds: number; noiseProfile?: Float32Array } | undefined) | undefined;
        const preprocessConfigArg: ({ noiseFloorDb: number; reductionDb: number; smoothing: number; calibrationSeconds: number; noiseProfile?: Float32Array } | null) = preprocessConfig ?? (preProc ?? null);
        await handleFullPipeline({ file, telemetry, pipeline, source, preprocessConfig: preprocessConfigArg, preDecoded, preprocessed: preApplied });
      } else {
        await handleProgressivePipeline({ file, telemetry, pipeline, source, preprocessConfig });
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
      logger.error(error);
      const message = (error as Error)?.message ?? String(error ?? "Erreur inconnue");
      if (isModelTooLargeError(error)) {
        const friendly = "Erreur : modèle trop gros pour cette plateforme (mémoire insuffisante). Essayez un preset plus léger ou activez le mode single-thread.";
        state.setStatus("error", friendly);
        toast(friendly);
      } else {
        state.setStatus("error", message);
        toast(`Échec de la transcription : ${message}`);
      }
    } finally {
      if (activePipeline) {
        await disposePipeline(activePipeline);
      }
      // Restore debug toggle to previous value in case any flow changed it
      state.setDebugConfidence(previousDebug);
      state.setIsTranscribing(false);
      state.resetStopRequest();
      state.registerTelemetry(null);
      abortRef.current = null;
    }
  }, [handleFullPipeline, handleProgressivePipeline]);

  const stopTranscription = useCallback(() => {
    const state = useAsrStore.getState();
    if (!state.isTranscribing) return;
    state.requestStop();
    state.setStatus("stopping", "Arrêt après le chunk courant");
  }, []);

  // Immediately abort any in-progress transcription (used for reset/cleanup)
  const abortTranscription = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      const state = useAsrStore.getState();
      state.setStatus("stopping", "Arrêt forcé");
      // also mark stop requested to help existing flows terminate
      state.requestStop();
    }
  }, []);

  return {
    startUploadTranscription,
    stopTranscription,
    abortTranscription,
    isTranscribing,
  };


  function shouldStopAfterChunk() {
    const snapshot = useAsrStore.getState();
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
  previous?: TranscriptionSegment
): TranscriptionSegment[] {
  const segments: TranscriptionSegment[] = [];
  if (segmentationMode === "chunks") {
    const text = trimChunkOverlap(previous?.text, result.text).trim();
    if (text.length) {
      const enableWordTimestamps = useAsrStore.getState().enableWordTimestamps;
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
    const text = segment.text.trim();
    if (!text.length) continue;
    if (last && text === last.text && segment.start - last.end < 1) {
      continue;
    }
    const segmentWords = (segment as unknown as Record<string, unknown>).words as WordSegment[] | undefined;

    const item: TranscriptionSegment = {
      index: idx,
      start: segment.start,
      end: segment.end,
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

function trimChunkOverlap(previousText: string | undefined, currentText: string): string {
  const candidate = currentText.trim();
  if (!candidate.length) {
    return "";
  }
  if (!previousText) {
    return candidate;
  }
  if (candidate === previousText.trim()) {
    return "";
  }

  const prevTokens = previousText.split(/\s+/);
  const currentTokens = candidate.split(/\s+/);
  const maxOverlap = Math.min(prevTokens.length, currentTokens.length, 30);

  for (let size = maxOverlap; size >= 3; size -= 1) {
    const prevSlice = prevTokens.slice(prevTokens.length - size).join(" ");
    const currentSlice = currentTokens.slice(0, size).join(" ");
    if (prevSlice === currentSlice) {
      return currentTokens.slice(size).join(" ");
    }
  }

  return candidate;
}
