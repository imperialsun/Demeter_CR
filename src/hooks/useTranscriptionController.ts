import { useCallback, useRef } from "react";
import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

import { toast } from "@/components/ui/use-toast";
import { createAsrPipeline, disposePipeline, transcribeChunk } from "@/lib/asr";
import { buildChunks } from "@/lib/chunking";
import {
  decodeFileFully,
  decodeFileProgressively,
  extractChunkPcm,
  probeAudioMetadata,
  type ProgressiveChunkResult,
} from "@/lib/audio";
import { preprocessDecodedAudio, preprocessPcmChunk } from "@/lib/preprocessing";
import { TelemetryCollector } from "@/lib/telemetry";
import type { TranscriptionSegment } from "@/lib/export";
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
        const processed = await preprocessDecodedAudio(decoded, preprocessConfig, telemetry);
        decoded = {
          metadata: decoded.metadata,
          pcm: processed.pcm,
          sampleRate: processed.sampleRate,
        };
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
      let sharedNoiseProfile = preprocessConfig?.noiseProfile;

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
            const processed = preprocessConfig
              ? await preprocessPcmChunk(
                  chunk.pcm,
                  chunk.sampleRate,
                  {
                    ...preprocessConfig,
                    noiseProfile: sharedNoiseProfile,
                  },
                  telemetry
                )
              : null;
            if (processed) {
              sharedNoiseProfile = processed.noiseProfile;
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

            const denominator = chunkPlan.length || chunk.index + 1;
            state.setProgress((chunk.index + 1) / denominator);

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

      telemetry.logEvent("STOPPED");
      const summary = telemetry.exportSummary();
      state.setTelemetrySummary(summary);
      toast("Transcription terminée.");
      state.setStatus("ready", "Prêt");
    } catch (error) {
      console.error(error);
      const message = (error as Error).message ?? "Erreur inconnue";
      state.setStatus("error", message);
      toast(`Échec de la transcription : ${message}`);
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
      segments.push({
        index: startIndex,
        start: result.chunk.start,
        end: result.chunk.end,
        text,
        chunkId: result.chunk.id,
        strategy: "chunks",
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
    const item: TranscriptionSegment = {
      index: idx,
      start: segment.start,
      end: segment.end,
      text,
      chunkId: result.chunk.id,
      strategy: "silence",
      confidence: segment.confidence,
    };
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
