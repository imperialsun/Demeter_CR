import { useCallback, useRef } from "react";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import { toast } from "@/components/ui/use-toast";
import { createAsrPipeline, disposePipeline, transcribeChunk, isModelTooLargeError } from "@/lib/asr";
import { buildChunks } from "@/lib/chunking";
import {
  decodeFileFully,
  decodeFileProgressively,
  extractChunkPcm,
  probeAudioMetadata,
  type ProgressiveChunkResult,
} from "@/lib/audio";
import { preprocessDecodedAudio, preprocessPcmChunk, estimateNoiseProfile, computePreprocessParams } from "@/lib/preprocessing";
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

      console.info("[decode] full decode start", {
        fileName: file.name,
        mode: preprocessConfig ? "complete-preprocess" : "full-memory",
      });
      telemetry.logEvent("START_DECODE", {
        strategy: "full",
        reason: preprocessConfig ? "full_mode_with_preprocess" : "full_mode_no_preprocess",
      });
      let decoded = await decodeFileFully(file, telemetry);
      const pcmBytes = decoded.pcm.byteLength;
      const pcmMb = pcmBytes / (1024 * 1024);
      console.info("[decode] full decode RAM footprint", {
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
        console.info("[preprocess] applying full pipeline on decoded audio", preprocessConfig);
        // Derive a noise profile from the decoded audio (auto-calibration in full-preprocess mode).
        try {
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
            console.info("[preprocess][autotune] full applied", { noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing, snrDb: tune.snrDb });
            telemetry.logEvent("PREPROCESS_AUTOTUNE", { source: "auto", snrDb: tune.snrDb, noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
          }
        } catch (err) {
          console.warn("Calibration failed", err);
          telemetry.recordAlert("PREPROCESS_CALIBRATION_FAILED", { message: (err as Error).message });
        }
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

        const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment);
        if (segments.length) {
          nextIndex += segments.length;
          lastSegment = segments[segments.length - 1];
          state.appendSegments(segments);
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

      if (preprocessConfig) {
        console.info("[preprocess] progressive pipeline will preprocess chunks", preprocessConfig);
      }

      const duration = state.audioMetadata?.durationSec ?? 0;
      useAsrStore.getState().registerAudioSource(source, state.audioMetadata);
      const chunkPlan = buildChunks(
        {
          strategy: state.chunkStrategy,
          chunkDurationSec: state.chunkDurationSec,
          overlapSec: state.overlapSec,
          durationSec: duration,
          silence: {
            silenceThresholdDb: state.silenceThresholdDb,
            minSilenceMs: state.minSilenceMs,
            minChunkMs: state.minChunkMs,
            maxChunkMs: state.maxChunkMs,
            sampleRate: undefined,
          },
        },
        undefined,
        undefined
      );

      state.setChunkPlan(chunkPlan);
      let nextIndex = state.segments.length;
      let lastSegment = state.segments.at(-1);

      const abortController = new AbortController();
      abortRef.current = abortController;
      // We'll perform a per-chunk calibration (estimate a noise profile) and then a processing pass for each chunk.
      // We'll also smooth profiles across chunks to avoid abrupt changes (ASR-friendly).
      let sharedNoiseProfile: Float32Array | null = preprocessConfig?.noiseProfile ?? null;

      try {
        await decodeFileProgressively(file, {
          chunkPlan,
          targetSampleRate: 16000,
          telemetry,
          signal: abortController.signal,
          onChunk: async (chunk) => {
            const definition = chunkPlan.length
              ? chunkPlan[Math.min(chunk.index, chunkPlan.length - 1)]
              : undefined;

            const denominator = chunkPlan.length || chunk.index + 1;

            let processed = null as Awaited<ReturnType<typeof preprocessPcmChunk>> | null;

            if (preprocessConfig) {
              useAsrStore.getState().setPreprocessingStatus("calibrating");
              useAsrStore.getState().setPreprocessingProgress(chunk.index / denominator);

              try {
                const { profile, frames } = estimateNoiseProfile(
                  chunk.pcm,
                  chunk.sampleRate,
                  preprocessConfig.calibrationSeconds
                );
                telemetry.logEvent("PREPROCESS_NOISE_PROFILE", { frames, source: "chunk" });

                // Smooth the profile across chunks (exponential smoothing)
                if (sharedNoiseProfile) {
                  const alpha = 0.4;
                  for (let i = 0; i < profile.length; i++) {
                    sharedNoiseProfile[i] = alpha * profile[i] + (1 - alpha) * sharedNoiseProfile[i];
                  }
                } else {
                  sharedNoiseProfile = profile;
                }

                // Auto-tune per-chunk params if enabled
                if (state.autoTunePreprocess) {
                  const tune = computePreprocessParams(sharedNoiseProfile, chunk.pcm.subarray(0, Math.floor(preprocessConfig.calibrationSeconds * chunk.sampleRate)));
                  preprocessConfig.noiseFloorDb = tune.noiseFloorDb;
                  preprocessConfig.reductionDb = tune.reductionDb;
                  preprocessConfig.smoothing = tune.smoothing;
                  // apply autotuned params to global settings so sliders reflect current autotune
                  useAsrStore.getState().setDenoiseParams({ denoiseNoiseFloorDb: tune.noiseFloorDb, denoiseReductionDb: tune.reductionDb, denoiseSmoothing: tune.smoothing });
                  useAsrStore.getState().setLastAutoTuneParams({ noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
                  console.info("[preprocess][autotune] chunk applied", { chunkIndex: chunk.index, noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing, snrDb: tune.snrDb });
                  telemetry.logEvent("PREPROCESS_AUTOTUNE", { source: "chunk", chunkIndex: chunk.index, snrDb: tune.snrDb, noiseFloorDb: tune.noiseFloorDb, reductionDb: tune.reductionDb, smoothing: tune.smoothing });
                }

                useAsrStore.getState().setPreprocessingStatus("processing");

                processed = await preprocessPcmChunk(
                  chunk.pcm,
                  chunk.sampleRate,
                  {
                    ...preprocessConfig,
                    noiseProfile: sharedNoiseProfile ?? undefined,
                  },
                  telemetry
                );
              } catch (err) {
                console.warn("Chunk calibration or processing failed, falling back to single-pass preprocess", err);
                telemetry.recordAlert("PREPROCESS_CALIBRATION_FAILED", { message: (err as Error).message });
                // Fallback: let preprocessPcmChunk compute/estimate a noise profile itself
                processed = await preprocessPcmChunk(
                  chunk.pcm,
                  chunk.sampleRate,
                  {
                    ...preprocessConfig,
                    noiseProfile: undefined,
                  },
                  telemetry
                );
                useAsrStore.getState().setPreprocessingStatus("processing");
              }

              // update preprocessing progress (based on chunk index if we have a chunk plan)
              useAsrStore.getState().setPreprocessingProgress((chunk.index + 1) / denominator);
            }

            const pcmToUse = processed?.pcm ?? chunk.pcm;
            const sampleRateToUse = processed?.sampleRate ?? chunk.sampleRate;


            const result = await transcribeChunk({
              pipeline,
              chunk: definition ?? {
                ...createFallbackChunk(chunk),
                index: chunk.index,
              },
              pcm: pcmToUse,
              sampleRate: sampleRateToUse,
              telemetry,
            });

            const segments = normaliseSegments(result, state.segmentationMode, nextIndex, lastSegment);
            if (segments.length) {
              nextIndex += segments.length;
              lastSegment = segments[segments.length - 1];
              state.appendSegments(segments);
            }

            const metric = {
              id: definition?.id ?? crypto.randomUUID(),
              index: chunk.index,
              startSec: chunk.startSec,
              endSec: chunk.endSec,
              transcriptionMs: result.processingMs,
              realtimeFactor: result.realtimeFactor,
              text: result.text,
            };
            telemetry.pushChunkMetric(metric);
            state.pushChunkMetric(metric);

            state.setProgress((chunk.index + 1) / denominator);

            // Memory snapshot for this chunk
            try {
              const bytes = (pcmToUse as Float32Array).byteLength ?? 0;
              telemetry.snapshotMemory(`CHUNK_AFTER_PROCESS_${chunk.index}`);
              telemetry.logEvent("RAM_USAGE", { context: "chunk", index: chunk.index, bytes, mb: Number((bytes / (1024 * 1024)).toFixed(3)) });
            } catch (err) {
              void err;
            }

            if (shouldStopAfterChunk()) {
              abortController.abort();
            }
          },
        });
      } catch (error) {
        if ((error as DOMException)?.name !== "AbortError") {
          throw error;
        }
      }
      // mark preprocessing done for progressive mode
      if (preprocessConfig) {
        useAsrStore.getState().setPreprocessingProgress(1);
        useAsrStore.getState().setPreprocessingStatus("done");
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

    state.resetSession();
    state.resetStopRequest();
    state.setProgress(0);
    state.setSegments([]);
    state.setChunkPlan([]);
    state.setTelemetrySummary(null);

    const metadata = await probeAudioMetadata(file);
    const source = { id: crypto.randomUUID(), label: file.name, type: "file" as const };
    state.registerAudioSource(source, metadata);

    const telemetry = new TelemetryCollector();
    state.registerTelemetry(telemetry);
    state.setStatus("downloading", "Chargement du pipeline");
    state.setIsTranscribing(true);

    const shouldPreprocess = state.preprocessingMode === "full";
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
      console.info("[preprocess] full mode active", preprocessConfig);
      state.clearNoiseCalibrationRequest();
      if (calibrationRequested) {
        console.info("[preprocess] calibration requested (1s noise capture)");
        telemetry.logEvent("CALIBRATION_REQUESTED");
      }
    }

    let activePipeline: AutomaticSpeechRecognitionPipeline | null = null;
    try {
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
        await handleFullPipeline({ file, telemetry, pipeline, source, preprocessConfig });
      } else {
        await handleProgressivePipeline({ file, telemetry, pipeline, source, preprocessConfig });
      }

      // Compute overall transcription confidence (duration-weighted average)
      try {
        const segments = useAsrStore.getState().segments;
        const computeTranscriptConfidence = (segs: TranscriptionSegment[]): number | null => {
          const items = segs
            .map((s) => ({ conf: s.confidence, dur: Math.max(0.001, s.end - s.start) }))
            .filter((x) => typeof x.conf === "number" && !Number.isNaN(x.conf));
          if (!items.length) return null;
          const totalDur = items.reduce((acc, it) => acc + it.dur, 0);
          if (totalDur <= 0) return items.reduce((acc, it) => acc + (it.conf ?? 0), 0) / items.length;
          const weighted = items.reduce((acc, it) => acc + (it.conf ?? 0) * it.dur, 0) / totalDur;
          // clamp
          return Math.max(0, Math.min(1, weighted));
        };
        const overall = computeTranscriptConfidence(segments);
        useAsrStore.getState().setTranscriptionConfidence(overall);
        console.info("Computed transcript confidence", { overall });
      } catch (err) {
        console.warn("Failed to compute transcript confidence", err);
      }

      telemetry.logEvent("STOPPED");
      const summary = telemetry.exportSummary();
      state.setTelemetrySummary(summary);
      toast("Transcription terminée.");
      state.setStatus("ready", "Prêt");
    } catch (error) {
      console.error(error);
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

function normaliseSegments(
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
        console.info("Attaching word timestamps to chunk segment", { chunkId: result.chunk.id, wordCount: words.length });
      }

      // Compute aggregated confidence for this chunk segment from child segments' confidences when available
      let aggregateConf: number | undefined;
      if (Array.isArray(result.segments) && result.segments.length) {
        const items = result.segments
          .map((s) => ({ conf: s.confidence, dur: Math.max(0.001, (s.end ?? s.start) - (s.start ?? 0)) }))
          .filter((x) => typeof x.conf === "number" && !Number.isNaN(x.conf));
        if (items.length) {
          const totalDur = items.reduce((acc, it) => acc + it.dur, 0);
          const weighted = items.reduce((acc, it) => acc + (it.conf ?? 0) * it.dur, 0) / totalDur;
          aggregateConf = Math.max(0, Math.min(1, weighted));
        }
      }

      console.info("Chunk aggregate confidence", { chunkId: result.chunk.id, aggregateConf });

      segments.push({
        index: startIndex,
        start: result.chunk.start,
        end: result.chunk.end,
        text,
        chunkId: result.chunk.id,
        strategy: "chunks",
        confidence: typeof aggregateConf === "number" ? aggregateConf : undefined,
        words,
      });
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
        console.info("Computed segment confidence from words", { index: item.index, confidence: item.confidence });
      }
    } else {
      console.info("Segment confidence present", { index: item.index, confidence: item.confidence });
    }

    segments.push(item);
    last = item;
    idx += 1;
  }
  return segments;
}

function createFallbackChunk(chunk: ProgressiveChunkResult) {
  return {
    id: crypto.randomUUID(),
    start: chunk.startSec,
    end: chunk.endSec,
    paddedStart: chunk.startSec,
    paddedEnd: chunk.endSec,
  } as const;
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
