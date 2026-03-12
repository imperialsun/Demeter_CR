import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsrStore } from "@/store/asr-store";
import { TelemetryCollector, type TelemetrySummary } from "@/lib/telemetry";
import { encodeWavBuffer, probeAudioMetadata, type AudioMetadata } from "@/lib/audio";
import { buildFixedSegments } from "@/lib/chunking";
import { preprocessCloudAudio, type CloudPreprocessSettings } from "@/lib/cloud/preprocessCloudAudio";
import logger from "@/lib/logger";
import { toast } from "@/components/ui/use-toast";
import type { TranscriptionSegment } from "@/lib/export";
import { summarizeSegments } from "@/lib/cloud/segmentSummary";
import { extractSegmentBlob } from "@/lib/cloud/segmentExtraction";
import { getWhisperClient } from "@/lib/cloud/whisperClient";
import { buildWhisperParameters } from "@/lib/cloud/whisperParams";
import { parseWhisperOutput } from "@/lib/cloud/whisperSegments";
import { MISTRAL_MAX_UPLOAD_BYTES, transcribeWithMistral } from "@/lib/cloud/mistralClient";
import { resolveMistralSegmentDurationSec } from "@/lib/cloud/mistralParams";
import { parseMistralOutput } from "@/lib/cloud/mistralSegments";
import { transcribeWithDemeterSante } from "@/lib/cloud/demeterClient";
import {
  formatBackendErrorMessage,
  handleBackendUnauthorized,
  isBackendForbiddenError,
  isBackendUnauthorizedError,
} from "@/lib/backend-api";
import { resolveChunkingConfig } from "@/hooks/useCloudTranscription.steps";
import { createSessionTranscriptMemoryEntry } from "@/lib/sessionTranscriptMemory";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";

type CloudStatus = "idle" | "preprocessing" | "uploading" | "transcribing" | "stopping" | "done" | "error";

type PreparedUploadInfo = {
  provider: "whisper" | "mistral" | "demeter_sante";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkIndex: number;
  totalChunks: number;
};

type CloudSegmentWindow = {
  start: number;
  end: number;
};

type MistralChunkingConfig = {
  requestedDurationSec: number;
  effectiveDurationSec: number;
  effectiveOverlapSec: number;
  modelMaxDurationSec: number;
  durationWasCapped: boolean;
};

function makeSafeFilename(value: string) {
  const ascii = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned : "audio";
}

export function useCloudTranscription(provider: "whisper" | "mistral" | "demeter_sante") {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [audioMetadata, setAudioMetadata] = useState<AudioMetadata | null>(null);
  const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetrySummary | null>(null);
  const [status, setStatus] = useState<CloudStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [preparedUpload, setPreparedUpload] = useState<PreparedUploadInfo | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);

  const runIdRef = useRef(0);
  const isTranscribingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const telemetryRef = useRef<TelemetryCollector | null>(null);

  const hfApiToken = useAsrStore((s) => s.hfApiToken);
  const cloudMistralApiUrl = useAsrStore((s) => s.cloudMistralApiUrl);
  const mistralApiKey = useAsrStore((s) => s.mistralApiKey);
  const cloudMistralModel = useAsrStore((s) => s.cloudMistralModel);
  const cloudMistralDiarizationEnabled = useAsrStore((s) => s.cloudMistralDiarizationEnabled);
  const cloudDemeterModel = useAsrStore((s) => s.cloudDemeterModel);
  const cloudDemeterDiarizationEnabled = useAsrStore((s) => s.cloudDemeterDiarizationEnabled);
  const cloudMaxTokens = useAsrStore((s) => s.cloudMaxTokens);
  const cloudTemperature = useAsrStore((s) => s.cloudTemperature);
  const cloudTopP = useAsrStore((s) => s.cloudTopP);
  const cloudDoSample = useAsrStore((s) => s.cloudDoSample);
  const registerTelemetry = useAsrStore((s) => s.registerTelemetry);
  const setGlobalTelemetrySummary = useAsrStore((s) => s.setTelemetrySummary);
  const setSessionTranscriptMemory = useAsrStore((s) => s.setSessionTranscriptMemory);
  const clearSessionTranscriptMemory = useAsrStore((s) => s.clearSessionTranscriptMemory);
  const resolvedSettings = useMemo(() => {
    return {
      maxTokens: cloudMaxTokens,
      temperature: cloudTemperature,
      topP: cloudTopP,
      doSample: cloudDoSample,
      sources: {
        maxTokens: "settings" as const,
        temperature: "settings" as const,
        topP: "settings" as const,
        doSample: "settings" as const,
      },
    };
  }, [
    cloudMaxTokens,
    cloudTemperature,
    cloudTopP,
    cloudDoSample,
  ]);

  useEffect(() => {
    stopRequestedRef.current = stopRequested;
  }, [stopRequested]);

  useEffect(() => {
    isTranscribingRef.current = isTranscribing;
  }, [isTranscribing]);

  useEffect(() => {
    useAsrStore.getState().setCloudStatus(status, statusDetail ?? undefined);
  }, [status, statusDetail]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        try {
          URL.revokeObjectURL(previewUrl);
        } catch (err) {
          void err;
        }
      }
    };
  }, [previewUrl]);

  const clearCloudSessionState = useCallback(
    (detail = "Session réinitialisée") => {
      if (previewUrl) {
        try {
          URL.revokeObjectURL(previewUrl);
        } catch (err) {
          void err;
        }
      }
      stopRequestedRef.current = false;
      telemetryRef.current = null;
      setSelectedFile(null);
      setPreviewFile(null);
      setPreviewUrl(null);
      setAudioMetadata(null);
      setSegments([]);
      clearSessionTranscriptMemory("cloud");
      setTelemetrySummary(null);
      setPreparedUpload(null);
      setGlobalTelemetrySummary(null);
      registerTelemetry(null);
      setStatus("idle");
      setStatusDetail(detail);
      setProgress(0);
      setIsTranscribing(false);
      setStopRequested(false);
    },
    [clearSessionTranscriptMemory, previewUrl, registerTelemetry, setGlobalTelemetrySummary]
  );

  const publishCloudTranscriptMemory = useCallback(
    (
      providerName: "whisper" | "mistral" | "demeter_sante",
      nextSegments: TranscriptionSegment[],
      metadata: AudioMetadata
    ) => {
      setSessionTranscriptMemory(
        "cloud",
        createSessionTranscriptMemoryEntry({
          mode: "cloud",
          provider: providerName,
          segments: nextSegments,
          audioSource: selectedFile
            ? { id: `${providerName}:${selectedFile.name}:${selectedFile.size}`, label: selectedFile.name, type: "file" }
            : null,
          audioMetadata: metadata,
        })
      );
    },
    [selectedFile, setSessionTranscriptMemory]
  );

  const abortCloudRunAndWait = useCallback(async () => {
    runIdRef.current += 1;
    stopRequestedRef.current = true;
    const wasRunning = isTranscribingRef.current;
    if (!wasRunning) {
      return;
    }

    setStopRequested(true);
    setStatus("stopping");
    setStatusDetail("Arrêt forcé");

    const start = Date.now();
    const timeoutMs = 15000;
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (!isTranscribingRef.current) {
          resolve();
          return;
        }
        if (Date.now() - start >= timeoutMs) {
          logger.warn("[cloud] reset timeout while waiting for active run to stop", { timeoutMs });
          resolve();
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
  }, []);

  const resetTranscriptionSession = useCallback(async () => {
    if (isResettingSession) {
      return;
    }
    setIsResettingSession(true);
    try {
      await abortCloudRunAndWait();
    } finally {
      clearCloudSessionState();
      setIsResettingSession(false);
    }
  }, [abortCloudRunAndWait, clearCloudSessionState, isResettingSession]);

  const handleFileSelected = useCallback(async (file: File) => {
    logger.info("[cloud] file selected", { name: file.name, size: file.size, type: file.type });
    setSelectedFile(file);
    setSegments([]);
    telemetryRef.current = null;
    setTelemetrySummary(null);
    setPreparedUpload(null);
    setGlobalTelemetrySummary(null);
    registerTelemetry(null);
    setStatus("idle");
    setStatusDetail("Fichier chargé, prêt à lancer");
    setProgress(0);
    setStopRequested(false);
    if (previewUrl) {
      try {
        URL.revokeObjectURL(previewUrl);
      } catch (err) {
        void err;
      }
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    setPreviewFile(file);
    try {
      const metadata = await probeAudioMetadata(file);
      setAudioMetadata(metadata);
    } catch (err) {
      logger.warn("[cloud] metadata probe failed", err);
      setStatus("error");
      setStatusDetail("Impossible de lire les métadonnées audio");
    }
  }, [previewUrl, registerTelemetry, setGlobalTelemetrySummary]);

  const stopTranscription = useCallback(async () => {
    if (!isTranscribing) return;
    setStopRequested(true);
    setStatus("stopping");
    setStatusDetail("Arrêt demandé");
    const telemetry = telemetryRef.current;
    telemetry?.logEvent("STOP_REQUESTED", { context: "cloud" });
    logger.info("[cloud] stop requested", { provider });
    if (provider === "whisper") {
      telemetry?.logEvent("CLOUD_WHISPER_STOP_REQUESTED", { provider });
    } else if (provider === "mistral" || provider === "demeter_sante") {
      telemetry?.logEvent("CLOUD_MISTRAL_STOP_REQUESTED", { provider });
    }
  }, [isTranscribing, provider]);

  const runWhisperTranscription = useCallback(async (args: {
    runId: number;
    settings: ReturnType<typeof useAsrStore.getState>;
    metadata: AudioMetadata;
    telemetry: TelemetryCollector;
    preprocessSettings: CloudPreprocessSettings;
  }) => {
    const { runId, settings, metadata, telemetry, preprocessSettings } = args;
    const token = hfApiToken.trim();
    if (!token) {
      const message = "Token Hugging Face manquant";
      telemetry.recordAlert("CLOUD_WHISPER_TOKEN_MISSING", { message });
      throw new Error(message);
    }

    const sourceFile = selectedFile;
    if (!sourceFile) {
      throw new Error("Fichier audio manquant");
    }

    const { duration: segmentDurationSec, overlap: overlapSec } = resolveChunkingConfig(
      settings.cloudWhisperChunkDurationSec,
      settings.cloudWhisperOverlapSec
    );
    const plan = buildFixedSegments({
      durationSec: metadata.durationSec,
      segmentDurationSec,
      overlapSec,
    });
    const totalSegments = Math.max(1, plan.length);
    logger.debug("[cloud][whisper] plan", {
      segments: totalSegments,
      durationSec: metadata.durationSec,
      segmentDurationSec,
      overlapSec,
    });
    telemetry.logEvent("CLOUD_WHISPER_PLAN", {
      segments: totalSegments,
      durationSec: metadata.durationSec,
      segmentDurationSec,
      overlapSec,
    });

    const client = await getWhisperClient(token, telemetry);
    const allSegments: TranscriptionSegment[] = [];
    let nextIndex = 0;

    for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex += 1) {
      const segment = plan[segmentIndex];
      if (!segment) continue;

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info("[cloud][whisper] run aborted before segment", { runId, segmentIndex });
        return;
      }

      const labelSuffix = ` · ${segmentIndex + 1}/${totalSegments}`;
      setStatus("preprocessing");
      setStatusDetail(`Prétraitement local${labelSuffix}`);
      setProgress(Math.max(0, Math.min(1, segmentIndex / totalSegments)));

      let segmentFile = sourceFile;
      if (totalSegments > 1) {
        const extracted = await extractSegmentBlob(
          sourceFile,
          { index: segmentIndex, startSec: segment.start, endSec: segment.end },
          telemetry
        );
        segmentFile = new File([extracted.blob], extracted.name, {
          type: extracted.mimeType,
          lastModified: Date.now(),
        });
      }

      telemetry.startTimer("cloud_preprocess");
      const preprocessResult = await preprocessCloudAudio(segmentFile, preprocessSettings, telemetry);
      telemetry.stopTimer("cloud_preprocess");

      if (settings.cloudAutoTunePreprocess && preprocessResult.tune && segmentIndex === 0) {
        settings.setCloudDenoiseParams({
          denoiseNoiseFloorDb: preprocessResult.tune.noiseFloorDb,
          denoiseReductionDb: preprocessResult.tune.reductionDb,
          denoiseSmoothing: preprocessResult.tune.smoothing,
          denoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds,
        });
        settings.setCloudPreprocessParams({
          preprocessTargetLufs: preprocessResult.tune.targetLufs,
          preprocessHighpassHz: preprocessResult.tune.highpassHz,
          preprocessLowpassHz: preprocessResult.tune.lowpassHz,
          preprocessLimiterThresholdDb: preprocessResult.tune.limiterThresholdDb,
          preprocessLimiterSoftness: preprocessResult.tune.limiterSoftness,
          preprocessVadThresholdDb: preprocessResult.tune.vadThresholdDb,
          preprocessOverlapBlockSec: preprocessResult.tune.overlapBlockSec,
          preprocessOverlapSec: preprocessResult.tune.overlapSec,
        });
      }

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info("[cloud][whisper] run aborted after preprocess", { runId, segmentIndex });
        return;
      }

      const wavBuffer = encodeWavBuffer(preprocessResult.processed.pcm, preprocessResult.processed.sampleRate);
      const baseName = segmentFile.name.replace(/\.[^/.]+$/, "");
      const safeBaseName = makeSafeFilename(baseName || "audio");
      const processedFile = new File([wavBuffer], `${safeBaseName}-whisper.wav`, {
        type: "audio/wav",
        lastModified: Date.now(),
      });
      setPreparedUpload({
        provider: "whisper",
        fileName: processedFile.name,
        mimeType: processedFile.type,
        sizeBytes: processedFile.size,
        chunkIndex: segmentIndex + 1,
        totalChunks: totalSegments,
      });

      setStatus("transcribing");
      setStatusDetail(`Transcription Whisper${labelSuffix}`);
      setProgress(Math.max(0, Math.min(1, (segmentIndex + 0.4) / totalSegments)));
      telemetry.startTimer("cloud_transcribe");
      telemetry.logEvent("CLOUD_WHISPER_CHUNK_START", {
        segmentIndex,
        totalSegments,
        startSec: segment.start,
        endSec: segment.end,
      });

      const parameters = buildWhisperParameters({
        maxTokens: resolvedSettings.maxTokens,
        temperature: resolvedSettings.temperature,
        topP: resolvedSettings.topP,
        doSample: resolvedSettings.doSample,
        returnTimestamps: settings.cloudEnableWordTimestamps,
      });

      const output = await client.automaticSpeechRecognition({
        inputs: processedFile,
        model: "openai/whisper-large-v3-turbo",
        provider: "hf-inference",
        parameters,
      });

      telemetry.stopTimer("cloud_transcribe");

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info("[cloud][whisper] run aborted after inference", { runId, segmentIndex });
        return;
      }

      const chunkId = `whisper-${segmentIndex + 1}`;
      const parsedSegments = parseWhisperOutput(output, {
        offsetSec: segment.start,
        startIndex: nextIndex,
        chunkId,
        fallbackDurationSec: Math.max(0, segment.end - segment.start),
      });
      nextIndex += parsedSegments.length;
      allSegments.push(...parsedSegments);
      setSegments([...allSegments]);
      publishCloudTranscriptMemory("whisper", allSegments, metadata);

      const summary = summarizeSegments(parsedSegments);
      logger.debug("[cloud][whisper] segments ready", { ...summary, segmentIndex, totalSegments });
      telemetry.logEvent("CLOUD_WHISPER_CHUNK_DONE", {
        segmentIndex,
        totalSegments,
        count: summary.count,
        totalDurationSec: summary.totalDurationSec,
        textChars: summary.textChars,
        tokenCount: summary.tokenCount,
      });

      setProgress(Math.max(0, Math.min(1, (segmentIndex + 1) / totalSegments)));
    }

    const summary = summarizeSegments(allSegments);
    logger.info("[cloud][whisper] all segments ready", summary);
    telemetry.logEvent("CLOUD_WHISPER_DONE", { segments: allSegments.length });
    setProgress(1);
    setStatus("done");
    setStatusDetail("Transcription terminée");
  }, [hfApiToken, publishCloudTranscriptMemory, resolvedSettings, selectedFile]);

  const runMistralTranscription = useCallback(async (args: {
    runId: number;
    settings: ReturnType<typeof useAsrStore.getState>;
    metadata: AudioMetadata;
    telemetry: TelemetryCollector;
    preprocessSettings: CloudPreprocessSettings;
  }) => {
    const { runId, settings, metadata, telemetry, preprocessSettings } = args;
    const isDemeter = provider === "demeter_sante";
    const providerLogKey = isDemeter ? "demeter" : "mistral";
    const providerLabel = isDemeter ? "Demeter Santé" : "Mistral";
    const apiKey = mistralApiKey.trim();
    const apiUrl = cloudMistralApiUrl.trim();
    const model = (isDemeter ? cloudDemeterModel : cloudMistralModel).trim() || "voxtral-mini-latest";
    const diarizationEnabled = isDemeter ? cloudDemeterDiarizationEnabled : cloudMistralDiarizationEnabled;

    if (!isDemeter && !apiKey) {
      const message = "Token API Mistral manquant";
      telemetry.recordAlert("CLOUD_MISTRAL_TOKEN_MISSING", { message });
      throw new Error(message);
    }

    const sourceFile = selectedFile;
    if (!sourceFile) {
      throw new Error("Fichier audio manquant");
    }

    const sourceDurationSec = Number.isFinite(metadata.durationSec) ? Math.max(0, metadata.durationSec) : 0;
    const mistralChunking = resolveEffectiveMistralChunking(
      model,
      settings.cloudMistralChunkDurationSec,
      settings.cloudMistralOverlapSec
    );
    const segmentQueue = buildInitialMistralSegmentQueue(sourceDurationSec, mistralChunking);

    logger.info(`[cloud][${providerLogKey}] duration-first plan`, {
      segments: segmentQueue.length,
      durationSec: sourceDurationSec,
      chunkDurationSec: mistralChunking.effectiveDurationSec,
      overlapSec: mistralChunking.effectiveOverlapSec,
      requestedChunkDurationSec: mistralChunking.requestedDurationSec,
      modelMaxDurationSec: mistralChunking.modelMaxDurationSec,
      durationWasCapped: mistralChunking.durationWasCapped,
      maxChunkBytes: MISTRAL_MAX_UPLOAD_BYTES,
      model,
    });
    telemetry.logEvent("CLOUD_MISTRAL_PLAN", {
      provider,
      model,
      segmentMode: "duration_first_with_fallback_split",
      maxChunkBytes: MISTRAL_MAX_UPLOAD_BYTES,
      segments: segmentQueue.length,
      durationSec: sourceDurationSec,
      chunkDurationSec: mistralChunking.effectiveDurationSec,
      overlapSec: mistralChunking.effectiveOverlapSec,
      requestedChunkDurationSec: mistralChunking.requestedDurationSec,
      modelMaxDurationSec: mistralChunking.modelMaxDurationSec,
      durationWasCapped: mistralChunking.durationWasCapped,
    });

    const allSegments: TranscriptionSegment[] = [];
    let nextIndex = 0;
    let mistralDiarizationEffective = diarizationEnabled;
    let mistralDiarizationFallbackChunks = 0;
    let segmentAttemptIndex = 0;
    let sentChunkCount = 0;
    let autoTuneApplied = false;

    while (segmentQueue.length > 0) {
      const segment = segmentQueue.shift();
      if (!segment) continue;
      segmentAttemptIndex += 1;
      const estimatedTotalBeforeRun = Math.max(1, sentChunkCount + segmentQueue.length + 1);

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info(`[cloud][${providerLogKey}] run aborted before segment`, { runId, segmentAttemptIndex });
        return;
      }

      const labelSuffix = ` · ${Math.min(sentChunkCount + 1, estimatedTotalBeforeRun)}/${estimatedTotalBeforeRun}`;
      setStatus("preprocessing");
      setStatusDetail(`Prétraitement local${labelSuffix}`);
      setProgress(Math.max(0, Math.min(1, sentChunkCount / estimatedTotalBeforeRun)));

      let segmentFile = sourceFile;
      const isWholeFileSegment = segment.start <= 0 && segment.end >= sourceDurationSec;
      if (!isWholeFileSegment) {
        const extracted = await extractSegmentBlob(
          sourceFile,
          { index: segmentAttemptIndex - 1, startSec: segment.start, endSec: segment.end },
          telemetry
        );
        segmentFile = new File([extracted.blob], extracted.name, {
          type: extracted.mimeType,
          lastModified: Date.now(),
        });
      }

      telemetry.startTimer("cloud_preprocess");
      const preprocessResult = await preprocessCloudAudio(segmentFile, preprocessSettings, telemetry);
      telemetry.stopTimer("cloud_preprocess");

      if (settings.cloudAutoTunePreprocess && preprocessResult.tune && !autoTuneApplied) {
        settings.setCloudDenoiseParams({
          denoiseNoiseFloorDb: preprocessResult.tune.noiseFloorDb,
          denoiseReductionDb: preprocessResult.tune.reductionDb,
          denoiseSmoothing: preprocessResult.tune.smoothing,
          denoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds,
        });
        settings.setCloudPreprocessParams({
          preprocessTargetLufs: preprocessResult.tune.targetLufs,
          preprocessHighpassHz: preprocessResult.tune.highpassHz,
          preprocessLowpassHz: preprocessResult.tune.lowpassHz,
          preprocessLimiterThresholdDb: preprocessResult.tune.limiterThresholdDb,
          preprocessLimiterSoftness: preprocessResult.tune.limiterSoftness,
          preprocessVadThresholdDb: preprocessResult.tune.vadThresholdDb,
          preprocessOverlapBlockSec: preprocessResult.tune.overlapBlockSec,
          preprocessOverlapSec: preprocessResult.tune.overlapSec,
        });
        autoTuneApplied = true;
      }

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info(`[cloud][${providerLogKey}] run aborted after preprocess`, { runId, segmentAttemptIndex });
        return;
      }

      const wavBuffer = encodeWavBuffer(preprocessResult.processed.pcm, preprocessResult.processed.sampleRate);
      const baseName = segmentFile.name.replace(/\.[^/.]+$/, "");
      const safeBaseName = makeSafeFilename(baseName || "audio");
      const processedFile = new File([wavBuffer], `${safeBaseName}-${providerLogKey}.wav`, {
        type: "audio/wav",
        lastModified: Date.now(),
      });
      const chunkDurationSec = Math.max(0, segment.end - segment.start);
      setPreparedUpload({
        provider: isDemeter ? "demeter_sante" : "mistral",
        fileName: processedFile.name,
        mimeType: processedFile.type,
        sizeBytes: processedFile.size,
        chunkIndex: sentChunkCount + 1,
        totalChunks: estimatedTotalBeforeRun,
      });

      if (processedFile.size > MISTRAL_MAX_UPLOAD_BYTES) {
        const splitSegments = splitSegmentInHalf(segment);
        if (!splitSegments) {
          const message = `Chunk ${providerLabel} trop volumineux (${processedFile.size} bytes) et impossible de découper davantage.`;
          telemetry.recordAlert("CLOUD_MISTRAL_FILE_TOO_LARGE", {
            provider,
            model,
            chunkDurationSec,
            sizeBytes: processedFile.size,
            maxChunkBytes: MISTRAL_MAX_UPLOAD_BYTES,
          });
          throw new Error(message);
        }

        segmentQueue.unshift(splitSegments[1]);
        segmentQueue.unshift(splitSegments[0]);

        logger.warn(`[cloud][${providerLogKey}] chunk exceeds size limit, splitting progressively`, {
          model,
          provider,
          segmentAttemptIndex,
          startSec: segment.start,
          endSec: segment.end,
          chunkDurationSec,
          sizeBytes: processedFile.size,
          maxChunkBytes: MISTRAL_MAX_UPLOAD_BYTES,
          pendingSegments: segmentQueue.length,
        });
        telemetry.logEvent("LOG_WARN", {
          context: "cloud_mistral_chunk_split_size",
          provider,
          model,
          segmentAttemptIndex,
          startSec: segment.start,
          endSec: segment.end,
          chunkDurationSec,
          sizeBytes: processedFile.size,
          maxChunkBytes: MISTRAL_MAX_UPLOAD_BYTES,
          pendingSegments: segmentQueue.length,
        });
        continue;
      }

      setStatus("transcribing");
      setStatusDetail(`Transcription ${providerLabel}${labelSuffix}`);
      setProgress(Math.max(0, Math.min(1, (sentChunkCount + 0.4) / estimatedTotalBeforeRun)));
      telemetry.startTimer("cloud_transcribe");
      logger.debug(`[cloud][${providerLogKey}] chunk start`, {
        segmentAttemptIndex,
        sentChunkCount,
        estimatedTotalBeforeRun,
        provider,
        model,
        sizeBytes: processedFile.size,
        chunkDurationSec,
      });

      const onDiarizationResolved = ({
        requestedDiarize,
        effectiveDiarize,
        fallbackApplied,
      }: {
        requestedDiarize: boolean;
        effectiveDiarize: boolean;
        fallbackApplied: boolean;
      }) => {
        if (fallbackApplied) {
          mistralDiarizationFallbackChunks += 1;
        }
        if (!effectiveDiarize) {
          mistralDiarizationEffective = false;
        }
        const currentHeader = useAsrStore.getState().runExportHeaders.cloud;
        if (!currentHeader || currentHeader.mode !== "cloud") return;
        settings.setRunExportHeader("cloud", {
          ...currentHeader,
          settings: {
            ...currentHeader.settings,
            cloud: {
              ...currentHeader.settings.cloud,
              mistralDiarizationRequested: requestedDiarize,
              mistralDiarizationEffective: mistralDiarizationEffective,
              mistralDiarizationFallbackChunks,
            },
          },
        });
      };

      let output: Awaited<ReturnType<typeof transcribeWithDemeterSante>> | Awaited<ReturnType<typeof transcribeWithMistral>>;
      try {
        output = isDemeter
          ? await transcribeWithDemeterSante(
              {
                model,
                file: processedFile,
                diarize: diarizationEnabled,
                onDiarizationResolved,
              },
              telemetry
            )
          : await transcribeWithMistral(
              {
                apiUrl,
                apiKey,
                model,
                file: processedFile,
                diarize: diarizationEnabled,
                onDiarizationResolved,
              },
              telemetry
            );
      } catch (error) {
        telemetry.stopTimer("cloud_transcribe");

        const splitSegments = splitSegmentInHalf(segment);
        if (splitSegments && shouldRetryMistralChunkBySplitting(error)) {
          segmentQueue.unshift(splitSegments[1]);
          segmentQueue.unshift(splitSegments[0]);

          logger.warn(`[cloud][${providerLogKey}] chunk timed out upstream, splitting and retrying`, {
            provider,
            model,
            segmentAttemptIndex,
            startSec: segment.start,
            endSec: segment.end,
            chunkDurationSec,
            sizeBytes: processedFile.size,
            pendingSegments: segmentQueue.length,
            message: describeRetryableCloudError(error),
          });
          telemetry.logEvent("LOG_WARN", {
            context: "cloud_mistral_chunk_split_timeout",
            provider,
            model,
            segmentAttemptIndex,
            startSec: segment.start,
            endSec: segment.end,
            chunkDurationSec,
            sizeBytes: processedFile.size,
            pendingSegments: segmentQueue.length,
            message: describeRetryableCloudError(error),
          });
          continue;
        }

        throw error;
      }

      telemetry.stopTimer("cloud_transcribe");

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info(`[cloud][${providerLogKey}] run aborted after inference`, { runId, segmentAttemptIndex });
        return;
      }

      const chunkNumber = sentChunkCount + 1;
      const chunkId = `${providerLogKey}-${chunkNumber}`;
      const parsedSegments = parseMistralOutput(output, {
        offsetSec: segment.start,
        startIndex: nextIndex,
        chunkId,
        fallbackDurationSec: chunkDurationSec,
        includeWordTimestamps: settings.cloudEnableWordTimestamps,
      });
      nextIndex += parsedSegments.length;
      allSegments.push(...parsedSegments);
      setSegments([...allSegments]);
      publishCloudTranscriptMemory(provider, allSegments, metadata);
      sentChunkCount = chunkNumber;

      const summary = summarizeSegments(parsedSegments);
      const estimatedTotalAfterSend = Math.max(sentChunkCount, sentChunkCount + segmentQueue.length);
      logger.debug(`[cloud][${providerLogKey}] segments ready`, {
        ...summary,
        provider,
        segmentAttemptIndex,
        segmentIndex: sentChunkCount - 1,
        totalSegments: estimatedTotalAfterSend,
      });
      telemetry.logEvent("CLOUD_SEGMENTS_READY", {
        provider,
        segmentIndex: sentChunkCount - 1,
        totalSegments: estimatedTotalAfterSend,
        count: summary.count,
        totalDurationSec: summary.totalDurationSec,
        textChars: summary.textChars,
        tokenCount: summary.tokenCount,
      });

      setProgress(Math.max(0, Math.min(1, sentChunkCount / Math.max(1, sentChunkCount + segmentQueue.length))));
    }

    const summary = summarizeSegments(allSegments);
    logger.info(`[cloud][${providerLogKey}] all segments ready`, { ...summary, provider });
    telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { provider, segments: allSegments.length });
    setProgress(1);
    setStatus("done");
    setStatusDetail("Transcription terminée");
  }, [
    provider,
    mistralApiKey,
    cloudMistralDiarizationEnabled,
    cloudDemeterDiarizationEnabled,
    cloudMistralApiUrl,
    cloudMistralModel,
    cloudDemeterModel,
    publishCloudTranscriptMemory,
    selectedFile,
  ]);

  const startTranscription = useCallback(async () => {
    const settings = useAsrStore.getState();
    const isWhisper = provider === "whisper";
    const isMistral = provider === "mistral";
    const isDemeter = provider === "demeter_sante";
    if (isResettingSession) {
      return;
    }
    if (!selectedFile) {
      toast("Sélectionnez un fichier audio avant de lancer.");
      return;
    }
    if (isTranscribing) {
      toast("Une transcription cloud est déjà en cours.");
      return;
    }
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    settings.clearSpeakerAssignments("cloud");
    clearSessionTranscriptMemory("cloud");
    setSegments([]);
    setProgress(0);
    setStatus("preprocessing");
    setStatusDetail("Prétraitement local");
    setIsTranscribing(true);
    setStopRequested(false);

    const telemetry = new TelemetryCollector();
    telemetryRef.current = telemetry;
    registerTelemetry(telemetry);
    setGlobalTelemetrySummary(null);
    telemetry.startTimer("cloud_total");

    try {
      const metadata = audioMetadata ?? await probeAudioMetadata(selectedFile);
      if (!audioMetadata) {
        setAudioMetadata(metadata);
      }
      logger.debug("[cloud] resolved session settings", {
        provider,
        maxTokensSource: resolvedSettings.sources.maxTokens,
        temperatureSource: resolvedSettings.sources.temperature,
        topPSource: resolvedSettings.sources.topP,
        doSampleSource: resolvedSettings.sources.doSample,
        maxTokens: resolvedSettings.maxTokens,
        temperature: resolvedSettings.temperature,
        topP: resolvedSettings.topP,
        doSample: resolvedSettings.doSample,
      });
      telemetry.logEvent("CLOUD_SESSION_RESOLVED", {
        provider,
        maxTokensSource: resolvedSettings.sources.maxTokens,
        temperatureSource: resolvedSettings.sources.temperature,
        topPSource: resolvedSettings.sources.topP,
        doSampleSource: resolvedSettings.sources.doSample,
      });

      const preprocessSettings = {
        preprocessingMode: settings.cloudPreprocessingMode,
        denoiseNoiseFloorDb: settings.cloudDenoiseNoiseFloorDb,
        denoiseReductionDb: settings.cloudDenoiseReductionDb,
        denoiseSmoothing: settings.cloudDenoiseSmoothing,
        denoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds,
        preprocessEnableFilters: settings.cloudPreprocessEnableFilters,
        preprocessHighpassHz: settings.cloudPreprocessHighpassHz,
        preprocessLowpassHz: settings.cloudPreprocessLowpassHz,
        preprocessEnableLufs: settings.cloudPreprocessEnableLufs,
        preprocessTargetLufs: settings.cloudPreprocessTargetLufs,
        preprocessLimiterEnabled: settings.cloudPreprocessLimiterEnabled,
        preprocessLimiterThresholdDb: settings.cloudPreprocessLimiterThresholdDb,
        preprocessLimiterSoftness: settings.cloudPreprocessLimiterSoftness,
        preprocessVadEnabled: settings.cloudPreprocessVadEnabled,
        preprocessVadThresholdDb: settings.cloudPreprocessVadThresholdDb,
        preprocessVadMinSilenceMs: settings.cloudPreprocessVadMinSilenceMs,
        preprocessOverlapAdd: settings.cloudPreprocessOverlapAdd,
        preprocessOverlapBlockSec: settings.cloudPreprocessOverlapBlockSec,
        preprocessOverlapSec: settings.cloudPreprocessOverlapSec,
        autoTunePreprocess: settings.cloudAutoTunePreprocess,
      };

      const commonCloudPreprocessSettings = {
        preprocessingMode: settings.cloudPreprocessingMode,
        autoTunePreprocess: settings.cloudAutoTunePreprocess,
        denoiseNoiseFloorDb: settings.cloudDenoiseNoiseFloorDb,
        denoiseReductionDb: settings.cloudDenoiseReductionDb,
        denoiseSmoothing: settings.cloudDenoiseSmoothing,
        denoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds,
        preprocessEnableFilters: settings.cloudPreprocessEnableFilters,
        preprocessHighpassHz: settings.cloudPreprocessHighpassHz,
        preprocessLowpassHz: settings.cloudPreprocessLowpassHz,
        preprocessEnableLufs: settings.cloudPreprocessEnableLufs,
        preprocessTargetLufs: settings.cloudPreprocessTargetLufs,
        preprocessLimiterEnabled: settings.cloudPreprocessLimiterEnabled,
        preprocessLimiterThresholdDb: settings.cloudPreprocessLimiterThresholdDb,
        preprocessLimiterSoftness: settings.cloudPreprocessLimiterSoftness,
        preprocessVadEnabled: settings.cloudPreprocessVadEnabled,
        preprocessVadThresholdDb: settings.cloudPreprocessVadThresholdDb,
        preprocessVadMinSilenceMs: settings.cloudPreprocessVadMinSilenceMs,
        preprocessOverlapAdd: settings.cloudPreprocessOverlapAdd,
        preprocessOverlapBlockSec: settings.cloudPreprocessOverlapBlockSec,
        preprocessOverlapSec: settings.cloudPreprocessOverlapSec,
      };

      const cloudSettingsForExport = isWhisper
        ? {
            provider: "whisper",
            model: "openai/whisper-large-v3-turbo",
            maxTokens: resolvedSettings.maxTokens,
            temperature: resolvedSettings.temperature,
            topP: resolvedSettings.topP,
            doSample: resolvedSettings.doSample,
            chunkDurationSec: settings.cloudWhisperChunkDurationSec,
            overlapSec: settings.cloudWhisperOverlapSec,
            includeWordTimestamps: settings.cloudEnableWordTimestamps,
            contextUsed: false,
            ...commonCloudPreprocessSettings,
          }
        : isMistral
          ? {
              provider: "mistral",
              apiUrl: settings.cloudMistralApiUrl,
              model: settings.cloudMistralModel,
              mistralDiarizationRequested: settings.cloudMistralDiarizationEnabled,
              mistralDiarizationEffective: settings.cloudMistralDiarizationEnabled,
              mistralDiarizationFallbackChunks: 0,
              chunkingMode: "duration-first-with-fallback-split",
              chunkDurationSec: resolveEffectiveMistralChunking(
                settings.cloudMistralModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).effectiveDurationSec,
              overlapSec: resolveEffectiveMistralChunking(
                settings.cloudMistralModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).effectiveOverlapSec,
              modelMaxChunkDurationSec: resolveEffectiveMistralChunking(
                settings.cloudMistralModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).modelMaxDurationSec,
              maxChunkSizeBytes: MISTRAL_MAX_UPLOAD_BYTES,
              includeWordTimestamps: settings.cloudEnableWordTimestamps,
              contextUsed: false,
              ...commonCloudPreprocessSettings,
            }
          : {
              provider: "demeter_sante",
              model: settings.cloudDemeterModel,
              mistralDiarizationRequested: settings.cloudDemeterDiarizationEnabled,
              mistralDiarizationEffective: settings.cloudDemeterDiarizationEnabled,
              mistralDiarizationFallbackChunks: 0,
              chunkingMode: "duration-first-with-fallback-split",
              chunkDurationSec: resolveEffectiveMistralChunking(
                settings.cloudDemeterModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).effectiveDurationSec,
              overlapSec: resolveEffectiveMistralChunking(
                settings.cloudDemeterModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).effectiveOverlapSec,
              modelMaxChunkDurationSec: resolveEffectiveMistralChunking(
                settings.cloudDemeterModel,
                settings.cloudMistralChunkDurationSec,
                settings.cloudMistralOverlapSec
              ).modelMaxDurationSec,
              maxChunkSizeBytes: MISTRAL_MAX_UPLOAD_BYTES,
              includeWordTimestamps: settings.cloudEnableWordTimestamps,
              contextUsed: false,
              ...commonCloudPreprocessSettings,
            };

      settings.setRunExportHeader("cloud", {
        exportedAt: new Date().toISOString(),
        mode: "cloud",
        settings: {
          cloud: cloudSettingsForExport,
        },
        runtime: {
          runId,
          provider,
          fileName: selectedFile.name,
          fileType: selectedFile.type || "application/octet-stream",
          fileSizeBytes: selectedFile.size,
          durationSec: metadata.durationSec,
          sampleRate: metadata.sampleRate,
          settingSources: resolvedSettings.sources,
        },
      });

      if (isWhisper) {
        await runWhisperTranscription({
          runId,
          settings,
          metadata,
          telemetry,
          preprocessSettings,
        });
        trackBackendActivityEvent({
          eventKind: "transcription",
          sourceMode: resolveCloudActivitySourceMode(provider),
          provider,
          status: "success",
          meta: { source: "cloud", runId },
        });
        return;
      }

      if (isMistral || isDemeter) {
        await runMistralTranscription({
          runId,
          settings,
          metadata,
          telemetry,
          preprocessSettings,
        });
        trackBackendActivityEvent({
          eventKind: "transcription",
          sourceMode: resolveCloudActivitySourceMode(provider),
          provider,
          status: "success",
          meta: { source: "cloud", runId },
        });
        return;
      }
    } catch (err) {
      const unauthorized = isBackendUnauthorizedError(err);
      const forbidden = isBackendForbiddenError(err);
      if (unauthorized) {
        handleBackendUnauthorized(err);
      }
      const message = unauthorized || forbidden ? formatBackendErrorMessage(err) : (err as Error)?.message ?? "Erreur inconnue";
      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.info("[cloud] run aborted", { message });
        return;
      }
      logger.error("[cloud] transcription failed", err);
      telemetryRef.current?.logEvent("ERROR", { context: "cloud", message });
      telemetryRef.current?.recordAlert("CLOUD_TRANSCRIBE_FAILED", { message });
      trackBackendActivityEvent({
        eventKind: "transcription",
        sourceMode: resolveCloudActivitySourceMode(provider),
        provider,
        status: "error",
        meta: { source: "cloud", runId, message },
      });
      setStatus("error");
      setStatusDetail(message);
      toast(`Échec de la transcription cloud : ${message}`);
    } finally {
      telemetryRef.current?.stopTimer("cloud_total");
      const summary = telemetryRef.current?.exportSummary();
      setTelemetrySummary(summary ?? null);
      setGlobalTelemetrySummary(summary ?? null);
      registerTelemetry(null);
      if (stopRequestedRef.current && status !== "error") {
        setStatus("idle");
        setStatusDetail("Arrêté");
        setProgress(0);
      }
      setIsTranscribing(false);
      setStopRequested(false);
    }
  }, [
    audioMetadata,
    isTranscribing,
    isResettingSession,
    provider,
    registerTelemetry,
    runMistralTranscription,
    runWhisperTranscription,
    resolvedSettings,
    clearSessionTranscriptMemory,
    setGlobalTelemetrySummary,
    selectedFile,
    status,
  ]);

  return {
    selectedFile,
    previewFile,
    previewUrl,
    audioMetadata,
    segments,
    telemetrySummary,
    status,
    statusDetail,
    progress,
    preparedUpload,
    isTranscribing,
    isResettingSession,
    stopRequested,
    resolvedSettings,
    handleFileSelected,
    startTranscription,
    stopTranscription,
    resetTranscriptionSession,
  };
}

function resolveCloudActivitySourceMode(provider: "whisper" | "mistral" | "demeter_sante"): "cloud_direct" | "cloud_backend" {
  return provider === "demeter_sante" ? "cloud_backend" : "cloud_direct";
}

function resolveEffectiveMistralChunking(
  model: string,
  requestedDurationSec: number,
  requestedOverlapSec: number
): MistralChunkingConfig {
  const modelMaxDurationSec = resolveMistralSegmentDurationSec(model);
  const resolved = resolveChunkingConfig(requestedDurationSec || modelMaxDurationSec, requestedOverlapSec);
  const effectiveDurationSec = Math.min(resolved.duration, modelMaxDurationSec);
  return {
    requestedDurationSec: resolved.duration,
    effectiveDurationSec,
    effectiveOverlapSec: Math.min(resolved.overlap, Math.max(0, effectiveDurationSec - 1)),
    modelMaxDurationSec,
    durationWasCapped: effectiveDurationSec < resolved.duration,
  };
}

function buildInitialMistralSegmentQueue(
  sourceDurationSec: number,
  chunking: MistralChunkingConfig
): CloudSegmentWindow[] {
  if (!(sourceDurationSec > 0)) {
    return [{ start: 0, end: 0 }];
  }

  return buildFixedSegments({
    durationSec: sourceDurationSec,
    segmentDurationSec: chunking.effectiveDurationSec,
    overlapSec: chunking.effectiveOverlapSec,
  }).map((segment) => ({
    start: segment.start,
    end: segment.end,
  }));
}

function splitSegmentInHalf(segment: CloudSegmentWindow): [CloudSegmentWindow, CloudSegmentWindow] | null {
  const chunkDurationSec = Math.max(0, segment.end - segment.start);
  if (!(chunkDurationSec > 1)) {
    return null;
  }

  const splitAt = segment.start + chunkDurationSec / 2;
  return [
    { start: segment.start, end: splitAt },
    { start: splitAt, end: segment.end },
  ];
}

function shouldRetryMistralChunkBySplitting(error: unknown): boolean {
  const status = readErrorStatus(error);
  if (status === 504) {
    return true;
  }

  const message = describeRetryableCloudError(error).toLowerCase();
  return (
    message.includes("timing out") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("deadline exceeded")
  );
}

function describeRetryableCloudError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
