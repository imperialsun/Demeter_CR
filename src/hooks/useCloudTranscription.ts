import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsrStore } from "@/store/asr-store";
import { TelemetryCollector, type TelemetrySummary } from "@/lib/telemetry";
import { probeAudioMetadata, type AudioMetadata } from "@/lib/audio";
import { buildFixedSegments } from "@/lib/chunking";
import { type CloudAutoTuneResult, type CloudPreprocessSettings } from "@/lib/cloud/preprocessCloudAudio";
import logger from "@/lib/logger";
import { toast } from "@/components/ui/use-toast";
import type { TranscriptionSegment } from "@/lib/export";
import { summarizeSegments } from "@/lib/cloud/segmentSummary";
import { stageCloudSegments, type CloudStagedSegment } from "@/lib/cloud/cloudStaging";
import { splitCloudSegmentWindow } from "@/lib/cloud/segmentWindows";
import { deleteSegment, deleteSessionSegments, getSegment, type CachedSegment } from "@/lib/segment-cache";
import { getWhisperClient } from "@/lib/cloud/whisperClient";
import { buildWhisperParameters } from "@/lib/cloud/whisperParams";
import { parseWhisperOutput } from "@/lib/cloud/whisperSegments";
import { MISTRAL_MAX_UPLOAD_BYTES, transcribeWithMistral } from "@/lib/cloud/mistralClient";
import { resolveMistralSegmentDurationSec } from "@/lib/cloud/mistralParams";
import { parseMistralOutput } from "@/lib/cloud/mistralSegments";
import { transcribeWithDemeterSante, type DemeterBackendTranscriptionOperationResponse } from "@/lib/cloud/demeterClient";
import { backendRefresh } from "@/lib/backend-auth";
import {
  sendFrontendAudioErrorReport,
  shouldRetryRawAudioUpload,
  type AudioErrorReportFile,
} from "@/lib/cloud/audioErrorReport";
import {
  formatBackendErrorMessage,
  handleBackendUnauthorized,
  isBackendForbiddenError,
  isBackendUnauthorizedError,
} from "@/lib/backend-api";
import { isBackendAuthenticated } from "@/lib/backend-session";
import { resolveChunkingConfig } from "@/hooks/useCloudTranscription.steps";
import { createSessionTranscriptMemoryEntry, getSessionTranscriptText } from "@/lib/sessionTranscriptMemory";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";
import { releaseFfmpeg } from "@/lib/ffmpeg-loader";
import { groupCloudTranscriptionSegments } from "@/lib/cloud/transcriptionChunks";

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

const CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC = 2 * 60 * 60;

function buildAudioReportFile(file: File, source: string): AudioErrorReportFile {
  return {
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type || "application/octet-stream",
    source,
  };
}

function buildUploadFileFromCache(cached: CachedSegment, staged: CloudStagedSegment, useRawFile: boolean): File | null {
  if (useRawFile) {
    if (!cached.rawBlob || cached.rawBlob.size <= 0) {
      return null;
    }
    return new File([cached.rawBlob], cached.rawName ?? staged.fileName, {
      type: cached.rawMimeType || cached.rawBlob.type || staged.mimeType,
      lastModified: Date.now(),
    });
  }

  return new File([cached.blob], cached.name ?? staged.fileName, {
    type: cached.blob.type || staged.mimeType,
    lastModified: Date.now(),
  });
}

export function useCloudTranscription(provider: "whisper" | "mistral" | "demeter_sante") {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
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
  const cloudSessionIdRef = useRef<string | null>(null);
  const isTranscribingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const segmentsRef = useRef<TranscriptionSegment[]>([]);
  const cloudTranscriptTextRef = useRef("");
  const cloudTranscriptSegmentCountRef = useRef(0);
  const activeTranscriptProviderRef = useRef(provider);
  const telemetryRef = useRef<TelemetryCollector | null>(null);
  const runAbortControllerRef = useRef<AbortController | null>(null);
  const backendDirectLastSegmentCountRef = useRef(0);
  const chunkSummaries = useMemo(() => groupCloudTranscriptionSegments(segments), [segments]);

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
  const registerAudioSource = useAsrStore((s) => s.registerAudioSource);
  const setGlobalTelemetrySummary = useAsrStore((s) => s.setTelemetrySummary);
  const setRunExportHeader = useAsrStore((s) => s.setRunExportHeader);
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

  const resetCloudTranscriptBuffers = useCallback(() => {
    segmentsRef.current = [];
    cloudTranscriptTextRef.current = "";
    cloudTranscriptSegmentCountRef.current = 0;
    setSegments([]);
  }, []);

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
    segmentsRef.current = segments;
  }, [segments]);

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
      runAbortControllerRef.current = null;
      backendDirectLastSegmentCountRef.current = 0;
      telemetryRef.current = null;
      resetCloudTranscriptBuffers();
      cloudSessionIdRef.current = null;
      registerAudioSource(null);
      setRunExportHeader("cloud", null);
      setSelectedFile(null);
      setPreviewUrl(null);
      setAudioMetadata(null);
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
    [
      clearSessionTranscriptMemory,
      previewUrl,
      registerAudioSource,
      registerTelemetry,
      resetCloudTranscriptBuffers,
      setGlobalTelemetrySummary,
      setRunExportHeader,
    ]
  );

  const cleanupTransientSessionCache = useCallback(async () => {
    const sessionId = cloudSessionIdRef.current;
    if (!sessionId) {
      return;
    }

    cloudSessionIdRef.current = null;
    try {
      await deleteSessionSegments(sessionId);
    } catch (error) {
      logger.warn("[cloud] failed to clean transient session cache", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const persistCloudTune = useCallback(
    (
      settings: ReturnType<typeof useAsrStore.getState>,
      preprocessSettings: CloudPreprocessSettings,
      tune: CloudAutoTuneResult
    ) => {
      settings.setCloudDenoiseParams({
        denoiseNoiseFloorDb: tune.noiseFloorDb,
        denoiseReductionDb: tune.reductionDb,
        denoiseSmoothing: tune.smoothing,
        denoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds,
      });
      settings.setCloudPreprocessParams({
        preprocessTargetLufs: tune.targetLufs,
        preprocessHighpassHz: tune.highpassHz,
        preprocessLowpassHz: tune.lowpassHz,
        preprocessLimiterThresholdDb: tune.limiterThresholdDb,
        preprocessLimiterSoftness: tune.limiterSoftness,
        preprocessVadThresholdDb: tune.vadThresholdDb,
        preprocessOverlapBlockSec: tune.overlapBlockSec,
        preprocessOverlapSec: tune.overlapSec,
      });
      preprocessSettings.denoiseNoiseFloorDb = tune.noiseFloorDb;
      preprocessSettings.denoiseReductionDb = tune.reductionDb;
      preprocessSettings.denoiseSmoothing = tune.smoothing;
      preprocessSettings.preprocessTargetLufs = tune.targetLufs;
      preprocessSettings.preprocessHighpassHz = tune.highpassHz;
      preprocessSettings.preprocessLowpassHz = tune.lowpassHz;
      preprocessSettings.preprocessLimiterThresholdDb = tune.limiterThresholdDb;
      preprocessSettings.preprocessLimiterSoftness = tune.limiterSoftness;
      preprocessSettings.preprocessVadThresholdDb = tune.vadThresholdDb;
      preprocessSettings.preprocessOverlapBlockSec = tune.overlapBlockSec;
      preprocessSettings.preprocessOverlapSec = tune.overlapSec;
    },
    []
  );

  const publishCloudTranscriptMemory = useCallback(
    (providerName: "whisper" | "mistral" | "demeter_sante", metadata: AudioMetadata | null) => {
      const currentSegments = segmentsRef.current;
      const transcriptText =
        cloudTranscriptTextRef.current || getSessionTranscriptText(currentSegments);
      const segmentCount = cloudTranscriptSegmentCountRef.current || currentSegments.length;
      setSessionTranscriptMemory(
        "cloud",
        createSessionTranscriptMemoryEntry({
          mode: "cloud",
          provider: providerName,
          segments: [],
          transcriptText,
          segmentCount,
          audioSource: selectedFile
            ? { id: `${providerName}:${selectedFile.name}:${selectedFile.size}`, label: selectedFile.name, type: "file" }
            : null,
          audioMetadata: metadata,
        })
      );
    },
    [selectedFile, setSessionTranscriptMemory]
  );

  const appendCloudSegments = useCallback(
    (nextSegments: TranscriptionSegment[], providerName: "whisper" | "mistral" | "demeter_sante", metadata: AudioMetadata | null) => {
      if (!nextSegments.length) {
        return;
      }

      const currentSegments = segmentsRef.current;
      const nextAllSegments = [...currentSegments, ...nextSegments];
      segmentsRef.current = nextAllSegments;
      cloudTranscriptSegmentCountRef.current = nextAllSegments.length;

      const appendedText = getSessionTranscriptText(nextSegments);
      if (appendedText) {
        cloudTranscriptTextRef.current = cloudTranscriptTextRef.current
          ? `${cloudTranscriptTextRef.current}\n${appendedText}`
          : appendedText;
      }

      startTransition(() => {
        setSegments(nextAllSegments);
      });
      logger.debug("[cloud] transcript segments appended", {
        provider: providerName,
        appendedCount: nextSegments.length,
        totalSegments: nextAllSegments.length,
        transcriptChars: cloudTranscriptTextRef.current.length,
      });
      publishCloudTranscriptMemory(providerName, metadata);
    },
    [publishCloudTranscriptMemory]
  );

  const applyCloudSegmentUpdate = useCallback(
    (
      segmentIndex: number,
      updater: (segment: TranscriptionSegment) => TranscriptionSegment,
      options?: { refreshTranscriptMemory?: boolean }
    ) => {
      const currentSegments = segmentsRef.current;
      const targetSegment = currentSegments.find((segment) => segment.index === segmentIndex);
      if (!targetSegment) {
        logger.warn("[cloud] segment edit ignored, segment not found", { segmentIndex });
        return false;
      }

      const nextTargetSegment = updater(targetSegment);
      if (nextTargetSegment === targetSegment) {
        return false;
      }

      const nextSegments = currentSegments.map((segment) => (segment.index === segmentIndex ? nextTargetSegment : segment));
      segmentsRef.current = nextSegments;
      startTransition(() => {
        setSegments(nextSegments);
      });

      if (options?.refreshTranscriptMemory) {
        cloudTranscriptTextRef.current = getSessionTranscriptText(nextSegments);
        cloudTranscriptSegmentCountRef.current = nextSegments.length;
        publishCloudTranscriptMemory(activeTranscriptProviderRef.current, audioMetadata);
      }

      return true;
    },
    [audioMetadata, publishCloudTranscriptMemory]
  );

  const updateSegmentText = useCallback(
    (segmentIndex: number, nextText: string) => {
      const normalizedText = nextText.trim();
      const updated = applyCloudSegmentUpdate(
        segmentIndex,
        (segment) => (segment.text === normalizedText ? segment : { ...segment, text: normalizedText }),
        { refreshTranscriptMemory: true }
      );
      if (!updated) {
        return;
      }

      logger.info("[cloud] segment text updated", {
        provider: activeTranscriptProviderRef.current,
        segmentIndex,
        textLength: normalizedText.length,
      });
    },
    [applyCloudSegmentUpdate]
  );

  const updateSegmentSpeaker = useCallback(
    (segmentIndex: number, nextSpeaker: string) => {
      const normalizedSpeaker = nextSpeaker.trim();
      const updated = applyCloudSegmentUpdate(segmentIndex, (segment) => {
        const currentSpeaker = segment.speaker?.trim() ?? "";
        if (currentSpeaker === normalizedSpeaker) {
          return segment;
        }
        return {
          ...segment,
          speaker: normalizedSpeaker || undefined,
        };
      });

      if (!updated) {
        return;
      }

      logger.info("[cloud] segment speaker updated", {
        provider: activeTranscriptProviderRef.current,
        segmentIndex,
        speakerId: normalizedSpeaker || null,
      });
    },
    [applyCloudSegmentUpdate]
  );

  const abortCloudRunAndWait = useCallback(async () => {
    runIdRef.current += 1;
    stopRequestedRef.current = true;
    runAbortControllerRef.current?.abort();
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
      await cleanupTransientSessionCache();
    } finally {
      clearCloudSessionState();
      setIsResettingSession(false);
    }
  }, [abortCloudRunAndWait, clearCloudSessionState, cleanupTransientSessionCache, isResettingSession]);

  const handleFileSelected = useCallback(async (file: File) => {
    logger.info("[cloud] file selected", { provider, name: file.name, size: file.size, type: file.type });
    registerAudioSource(
      {
        id: `${provider}:${file.name}:${file.size}`,
        label: file.name,
        type: "file",
      },
      null
    );
    setRunExportHeader("cloud", null);
    setSelectedFile(file);
    resetCloudTranscriptBuffers();
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
    setPreviewUrl(null);
    try {
      const metadata = await probeAudioMetadata(file);
      setAudioMetadata(metadata);
      registerAudioSource(
        {
          id: `${provider}:${file.name}:${file.size}`,
          label: file.name,
          type: "file",
        },
        metadata
      );
      logger.info("[cloud] file metadata resolved", {
        provider,
        name: file.name,
        sizeBytes: file.size,
        mimeType: file.type || "application/octet-stream",
        durationSec: metadata.durationSec,
        sampleRate: metadata.sampleRate ?? null,
        channels: metadata.channels ?? null,
      });
    } catch (err) {
      logger.warn("[cloud] metadata probe failed", err);
      setStatus("error");
      setStatusDetail("Impossible de lire les métadonnées audio");
    }
  }, [
    previewUrl,
    provider,
    registerAudioSource,
    registerTelemetry,
    resetCloudTranscriptBuffers,
    setGlobalTelemetrySummary,
    setRunExportHeader,
  ]);

  const stopTranscription = useCallback(async () => {
    if (!isTranscribing) return;
    setStopRequested(true);
    setStatus("stopping");
    setStatusDetail("Arrêt demandé");
    runAbortControllerRef.current?.abort();
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
    const shouldAbort = () => stopRequestedRef.current || runIdRef.current !== runId;
    const sessionId = cloudSessionIdRef.current ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cloudSessionIdRef.current = sessionId;

    let allSegments: TranscriptionSegment[] = [];
    let nextIndex = 0;
    let stagedSegments: CloudStagedSegment[];

    telemetry.startTimer("cloud_preprocess");
    try {
      const stageResult = await stageCloudSegments({
        sessionId,
        sourceFile,
        provider: "whisper",
        segments: plan.map((segment) => ({ startSec: segment.start, endSec: segment.end })),
        preprocessSettings,
        telemetry,
        startIndex: 0,
        shouldAbort,
        onProgress: (completed, total) => {
          setStatus("preprocessing");
          setStatusDetail(`Préparation locale · ${completed}/${total}`);
          setProgress(Math.max(0, Math.min(0.5, total > 0 ? (completed / total) * 0.5 : 0)));
        },
      });
      telemetry.stopTimer("cloud_preprocess");
      if (stageResult.aborted || shouldAbort()) {
        logger.info("[cloud][whisper] run aborted during staging", { runId, staged: stageResult.stagedSegments.length });
        return;
      }
      stagedSegments = stageResult.stagedSegments;

      if (stageResult.tune) {
        persistCloudTune(settings, preprocessSettings, stageResult.tune);
      }

      setStatus("uploading");
      setStatusDetail(`Envoi des segments préparés · 0/${stagedSegments.length}`);
      setProgress(0.5);

      for (let stagedPosition = 0; stagedPosition < stagedSegments.length; stagedPosition += 1) {
        const staged = stagedSegments[stagedPosition];
        if (!staged) continue;

        if (shouldAbort()) {
          logger.info("[cloud][whisper] run aborted before upload", { runId, stagedPosition });
          return;
        }

        const cached = await getSegment(sessionId, staged.index);
        if (!cached) {
          logger.warn("[cloud][whisper] staged segment missing from cache", { sessionId, index: staged.index });
          continue;
        }
        const uploadFile = new File([cached.blob], cached.name ?? staged.fileName, {
          type: cached.blob.type || staged.mimeType,
          lastModified: Date.now(),
        });

        setPreparedUpload({
          provider: "whisper",
          fileName: uploadFile.name,
          mimeType: uploadFile.type,
          sizeBytes: uploadFile.size,
          chunkIndex: stagedPosition + 1,
          totalChunks: stagedSegments.length,
        });

        setStatus("transcribing");
        setStatusDetail(`Transcription Whisper · ${stagedPosition + 1}/${stagedSegments.length}`);
        setProgress(Math.max(0, Math.min(1, 0.5 + (stagedPosition / Math.max(1, stagedSegments.length)) * 0.5)));
        telemetry.startTimer("cloud_transcribe");
        telemetry.logEvent("CLOUD_WHISPER_CHUNK_START", {
          segmentIndex: staged.index,
          totalSegments: stagedSegments.length,
          startSec: staged.startSec,
          endSec: staged.endSec,
        });

        const parameters = buildWhisperParameters({
          maxTokens: resolvedSettings.maxTokens,
          temperature: resolvedSettings.temperature,
          topP: resolvedSettings.topP,
          doSample: resolvedSettings.doSample,
          returnTimestamps: settings.cloudEnableWordTimestamps,
        });

        const output: unknown = await client.automaticSpeechRecognition({
          inputs: uploadFile,
          model: "openai/whisper-large-v3-turbo",
          provider: "hf-inference",
          parameters,
        });

        telemetry.stopTimer("cloud_transcribe");

        if (shouldAbort()) {
          logger.info("[cloud][whisper] run aborted after inference", { runId, stagedPosition });
          return;
        }

        const chunkId = `whisper-${stagedPosition + 1}`;
        const parsedSegments = parseWhisperOutput(output, {
          offsetSec: staged.startSec,
          startIndex: nextIndex,
          chunkId,
          fallbackDurationSec: Math.max(0, staged.endSec - staged.startSec),
        });
        nextIndex += parsedSegments.length;
        appendCloudSegments(parsedSegments, "whisper", metadata);
        allSegments = segmentsRef.current;

        await deleteSegment(sessionId, staged.index);

        const summary = summarizeSegments(parsedSegments);
        logger.debug("[cloud][whisper] segments ready", {
          ...summary,
          segmentIndex: staged.index,
          totalSegments: stagedSegments.length,
        });
        telemetry.logEvent("CLOUD_WHISPER_CHUNK_DONE", {
          segmentIndex: staged.index,
          totalSegments: stagedSegments.length,
          count: summary.count,
          totalDurationSec: summary.totalDurationSec,
          textChars: summary.textChars,
          tokenCount: summary.tokenCount,
        });

        setProgress(Math.max(0, Math.min(1, 0.5 + ((stagedPosition + 1) / Math.max(1, stagedSegments.length)) * 0.5)));
      }

      await deleteSessionSegments(sessionId);
      cloudSessionIdRef.current = null;

      const summary = summarizeSegments(allSegments);
      logger.info("[cloud][whisper] all segments ready", summary);
      telemetry.logEvent("CLOUD_WHISPER_DONE", { segments: allSegments.length });
      setProgress(1);
      setStatus("done");
      setStatusDetail("Transcription terminée");
    } catch (error) {
      telemetry.stopTimer("cloud_preprocess");
      throw error;
    }
  }, [appendCloudSegments, hfApiToken, persistCloudTune, resolvedSettings, selectedFile]);

  const runDemeterBackendDirectTranscription = useCallback(async (args: {
    runId: number;
    settings: ReturnType<typeof useAsrStore.getState>;
    metadata: AudioMetadata;
    telemetry: TelemetryCollector;
  }) => {
    const { runId, settings, metadata, telemetry } = args;
    const sourceFile = selectedFile;
    if (!sourceFile) {
      throw new Error("Fichier audio manquant");
    }

    const demeterModel = cloudDemeterModel.trim() || "voxtral-mini-latest";
    const diarizationEnabled = cloudDemeterDiarizationEnabled;
    const sourceDurationSec = Number.isFinite(metadata.durationSec) ? Math.max(0, metadata.durationSec) : 0;
    const shouldAbort = () => stopRequestedRef.current || runIdRef.current !== runId;
    let backendDiarizationEffective = diarizationEnabled;
    let backendDiarizationFallbackChunks = 0;
    const backendOperationParseOptions = {
      offsetSec: 0,
      startIndex: 0,
      chunkId: "demeter-backend-direct",
      fallbackDurationSec: sourceDurationSec,
      includeWordTimestamps: settings.cloudEnableWordTimestamps,
    };
    const backendRunAbortController = new AbortController();
    runAbortControllerRef.current = backendRunAbortController;
    backendDirectLastSegmentCountRef.current = 0;

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
        backendDiarizationFallbackChunks += 1;
      }
      if (!effectiveDiarize) {
        backendDiarizationEffective = false;
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
            mistralDiarizationEffective: backendDiarizationEffective,
            mistralDiarizationFallbackChunks: backendDiarizationFallbackChunks,
          },
        },
      });
    };

    const consumeBackendOperationSnapshot = (snapshot: DemeterBackendTranscriptionOperationResponse) => {
      if (shouldAbort()) {
        return;
      }
      const chunkIndex = Math.max(0, snapshot.chunkIndex ?? 0);
      const chunkCount = Math.max(0, snapshot.chunkCount ?? 0);
      const backendProgress = typeof snapshot.progress === "number"
        ? Math.max(0, Math.min(1, snapshot.progress))
        : chunkCount > 0
          ? Math.max(0, Math.min(1, chunkIndex / chunkCount))
          : 0;
      setPreparedUpload({
        provider: "demeter_sante",
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        chunkIndex,
        totalChunks: chunkCount,
      });
      setStatus("transcribing");
      setStatusDetail(`Chunk ${chunkIndex}/${chunkCount}`);
      setProgress(Math.max(0.5, 0.5 + backendProgress * 0.5));
      if (!snapshot.response) {
        return;
      }

      const parsedSegments = parseMistralOutput(snapshot.response, backendOperationParseOptions);
      if (parsedSegments.length <= backendDirectLastSegmentCountRef.current) {
        return;
      }

      const nextSegments = parsedSegments.slice(backendDirectLastSegmentCountRef.current);
      backendDirectLastSegmentCountRef.current = parsedSegments.length;
      appendCloudSegments(nextSegments, "demeter_sante", metadata);
      logger.debug("[cloud][demeter] backend chunk appended", {
        operationId: snapshot.operationId,
        status: snapshot.status,
        stage: snapshot.stage,
        chunkIndex,
        chunkCount,
        appendedCount: nextSegments.length,
        totalSegments: parsedSegments.length,
      });
    };

    try {
      logger.info("[cloud][demeter] long audio routed to backend", {
        runId,
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        durationSec: sourceDurationSec,
        thresholdSec: CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC,
      });
      telemetry.logEvent("LOG_INFO", {
        context: "cloud_demeter_long_audio_backend_direct",
        provider: "demeter_sante",
        runId,
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        durationSec: sourceDurationSec,
        thresholdSec: CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC,
      });

      setStatus("uploading");
      setStatusDetail("Audio long, traitement backend");
      setProgress(0.5);
      setPreparedUpload({
        provider: "demeter_sante",
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        chunkIndex: 0,
        totalChunks: 0,
      });

      telemetry.startTimer("cloud_transcribe");
      const output = await transcribeWithDemeterSante(
        {
          file: sourceFile,
          diarize: diarizationEnabled,
          model: demeterModel,
          durationSec: sourceDurationSec,
          backendDirect: true,
          signal: backendRunAbortController.signal,
          onBackendOperationProgress: consumeBackendOperationSnapshot,
          onDiarizationResolved,
        },
        telemetry
      );

      telemetry.stopTimer("cloud_transcribe");

      if (shouldAbort()) {
        logger.info("[cloud][demeter] run aborted after backend direct inference", { runId });
        return;
      }

      const parsedSegments = parseMistralOutput(output, backendOperationParseOptions);
      if (parsedSegments.length > backendDirectLastSegmentCountRef.current) {
        const nextSegments = parsedSegments.slice(backendDirectLastSegmentCountRef.current);
        backendDirectLastSegmentCountRef.current = parsedSegments.length;
        appendCloudSegments(nextSegments, "demeter_sante", metadata);
      }

      const parsedChunkSummaries = groupCloudTranscriptionSegments(parsedSegments);
      const parsedSegmentsByChunkId = new Map<string, TranscriptionSegment[]>();
      for (const segment of parsedSegments) {
        const chunkId = segment.chunkId?.trim() || `__chunk-${segment.index}`;
        const bucket = parsedSegmentsByChunkId.get(chunkId);
        if (bucket) {
          bucket.push(segment);
        } else {
          parsedSegmentsByChunkId.set(chunkId, [segment]);
        }
      }
      for (const group of parsedChunkSummaries) {
        const chunkSegments = parsedSegmentsByChunkId.get(group.chunkId) ?? [];
        const summary = summarizeSegments(chunkSegments);
        telemetry.logEvent("CLOUD_SEGMENTS_READY", {
          provider: "demeter_sante",
          routeMode: "backend_direct",
          segmentIndex: group.chunkIndex,
          totalSegments: parsedChunkSummaries.length,
          count: summary.count,
          totalDurationSec: summary.totalDurationSec,
          textChars: summary.textChars,
          tokenCount: summary.tokenCount,
        });
      }

      const summary = summarizeSegments(parsedSegments);
      logger.debug("[cloud][demeter] backend direct segments ready", {
        ...summary,
        provider: "demeter_sante",
        routeMode: "backend_direct",
      });

      setProgress(1);
      setStatus("done");
      setStatusDetail("Transcription terminée");
      logger.info("[cloud][demeter] backend direct transcription done", {
        ...summary,
        provider: "demeter_sante",
        routeMode: "backend_direct",
      });
    } catch (error) {
      telemetry.stopTimer("cloud_transcribe");
      if (
        stopRequestedRef.current ||
        runIdRef.current !== runId ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      const reportTraceId =
        error && typeof error === "object" && "traceId" in error && typeof (error as { traceId?: unknown }).traceId === "string"
          ? ((error as { traceId?: string }).traceId ?? "").trim()
          : undefined;
      await sendFrontendAudioErrorReport({
        provider: "demeter_sante",
        backendError: error,
        originalFile: buildAudioReportFile(sourceFile, "source"),
        processedFile: buildAudioReportFile(sourceFile, "backend_direct"),
        rawFile: null,
        retry: {
          attempted: false,
          succeeded: false,
          usedRawFile: false,
        },
        telemetry,
        traceId: reportTraceId,
      });
      throw error;
    } finally {
      runAbortControllerRef.current = null;
      backendDirectLastSegmentCountRef.current = 0;
    }
  }, [appendCloudSegments, cloudDemeterDiarizationEnabled, cloudDemeterModel, selectedFile]);

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

    let allSegments: TranscriptionSegment[] = [];
    let nextIndex = 0;
    let sentChunkCount = 0;
    let mistralDiarizationEffective = diarizationEnabled;
    let mistralDiarizationFallbackChunks = 0;
    const shouldAbort = () => stopRequestedRef.current || runIdRef.current !== runId;
    const sessionId = cloudSessionIdRef.current ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    cloudSessionIdRef.current = sessionId;
    let stagedSegments: CloudStagedSegment[];
    let nextStagedIndex: number;

    telemetry.startTimer("cloud_preprocess");
    try {
      const stageResult = await stageCloudSegments({
        sessionId,
        sourceFile,
        provider: isDemeter ? "demeter_sante" : "mistral",
        segments: segmentQueue.map((segment) => ({ startSec: segment.start, endSec: segment.end })),
        preprocessSettings,
        telemetry,
        maxUploadBytes: MISTRAL_MAX_UPLOAD_BYTES,
        startIndex: 0,
        shouldAbort,
        onProgress: (completed, total) => {
          setStatus("preprocessing");
          setStatusDetail(`Préparation locale · ${completed}/${total}`);
          setProgress(Math.max(0, Math.min(0.5, total > 0 ? (completed / total) * 0.5 : 0)));
        },
      });
      telemetry.stopTimer("cloud_preprocess");
      if (stageResult.aborted || shouldAbort()) {
        logger.info(`[cloud][${providerLogKey}] run aborted during staging`, {
          runId,
          staged: stageResult.stagedSegments.length,
        });
        return;
      }

      stagedSegments = stageResult.stagedSegments;
      nextStagedIndex = stageResult.nextIndex;

      if (stageResult.tune) {
        persistCloudTune(settings, preprocessSettings, stageResult.tune);
      }

      setStatus("uploading");
      setStatusDetail(`Envoi des segments préparés · 0/${stagedSegments.length}`);
      setProgress(0.5);

      for (let stagedPosition = 0; stagedPosition < stagedSegments.length; stagedPosition += 1) {
        const staged = stagedSegments[stagedPosition];
        if (!staged) continue;

        if (shouldAbort()) {
          logger.info(`[cloud][${providerLogKey}] run aborted before upload`, { runId, stagedPosition });
          return;
        }

        const cached = await getSegment(sessionId, staged.index);
        if (!cached) {
          logger.warn(`[cloud][${providerLogKey}] staged segment missing from cache`, {
            sessionId,
            index: staged.index,
          });
          continue;
        }
	        const uploadFile = new File([cached.blob], cached.name ?? staged.fileName, {
	          type: cached.blob.type || staged.mimeType,
	          lastModified: Date.now(),
	        });
	        const rawUploadFile = buildUploadFileFromCache(cached, staged, true);
	        const chunkDurationSec = Math.max(0, staged.endSec - staged.startSec);

        setPreparedUpload({
          provider: isDemeter ? "demeter_sante" : "mistral",
          fileName: uploadFile.name,
          mimeType: uploadFile.type,
          sizeBytes: uploadFile.size,
          chunkIndex: sentChunkCount + 1,
          totalChunks: stagedSegments.length,
        });

        setStatus("transcribing");
        setStatusDetail(`Transcription ${providerLabel} · ${sentChunkCount + 1}/${stagedSegments.length}`);
        setProgress(Math.max(0, Math.min(1, 0.5 + (sentChunkCount / Math.max(1, stagedSegments.length)) * 0.5)));
        telemetry.startTimer("cloud_transcribe");
        logger.debug(`[cloud][${providerLogKey}] chunk start`, {
          segmentIndex: staged.index,
          sentChunkCount,
          totalSegments: stagedSegments.length,
          provider,
          model,
          sizeBytes: uploadFile.size,
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

        let output: unknown;
	        try {
          output = isDemeter
            ? await transcribeWithDemeterSante(
                {
                  file: uploadFile,
                  diarize: diarizationEnabled,
                  model,
                  durationSec: chunkDurationSec,
                  onDiarizationResolved,
                },
                telemetry
              )
            : await transcribeWithMistral(
                {
                  apiUrl,
                  apiKey,
                  model,
                  file: uploadFile,
                  diarize: diarizationEnabled,
                  onDiarizationResolved,
                },
	                telemetry
	              );
	        } catch (error) {
	          const splitSegments = splitCloudSegmentWindow(staged);
	          const rawRetryRequested = shouldRetryRawAudioUpload(error);
	          const reportTraceId =
	            error && typeof error === "object" && "traceId" in error && typeof (error as { traceId?: unknown }).traceId === "string"
	              ? ((error as { traceId?: string }).traceId ?? "").trim()
	              : undefined;
	          const retrySummary = {
	            provider,
	            model,
	            segmentIndex: staged.index,
	            startSec: staged.startSec,
	            endSec: staged.endSec,
	            chunkDurationSec,
	            processedSizeBytes: uploadFile.size,
	            rawSizeBytes: rawUploadFile?.size ?? 0,
	            message: describeRetryableCloudError(error),
	          };
	          let rawRetryRecovered = false;

	          if (rawRetryRequested) {
	            const retryFile = rawUploadFile;
	            if (retryFile) {
	              logger.warn(`[cloud][${providerLogKey}] audio upload rejected, retrying with raw chunk`, retrySummary);
	              telemetry.logEvent("LOG_WARN", {
	                context: "cloud_audio_raw_retry",
	                ...retrySummary,
	                retryAttempted: true,
	              });
	              setPreparedUpload({
	                provider: isDemeter ? "demeter_sante" : "mistral",
	                fileName: retryFile.name,
	                mimeType: retryFile.type,
	                sizeBytes: retryFile.size,
	                chunkIndex: sentChunkCount + 1,
	                totalChunks: stagedSegments.length,
	              });

	              let rawRetrySucceeded = false;
	              let rawRetryError: unknown = error;
	              try {
                output = isDemeter
                  ? await transcribeWithDemeterSante(
                      {
                        file: retryFile,
                        diarize: diarizationEnabled,
                        model,
                        durationSec: chunkDurationSec,
                        onDiarizationResolved,
                      },
                      telemetry
                    )
	                  : await transcribeWithMistral(
	                      {
	                        apiUrl,
	                        apiKey,
	                        model,
	                        file: retryFile,
	                        diarize: diarizationEnabled,
	                        onDiarizationResolved,
	                      },
	                      telemetry
	                    );
	                rawRetrySucceeded = true;
	              } catch (retryError) {
	                rawRetryError = retryError;
	              }

	              await sendFrontendAudioErrorReport({
	                provider,
	                backendError: error,
	                originalFile: buildAudioReportFile(sourceFile, "source"),
	                processedFile: buildAudioReportFile(uploadFile, "processed"),
	                rawFile: buildAudioReportFile(retryFile, "raw"),
	                retry: {
	                  attempted: true,
	                  succeeded: rawRetrySucceeded,
	                  usedRawFile: true,
	                },
	                telemetry,
	                traceId: reportTraceId,
	              });

	              if (rawRetrySucceeded) {
	                logger.info(`[cloud][${providerLogKey}] raw chunk retry succeeded`, {
	                  provider,
	                  model,
	                  segmentIndex: staged.index,
	                  chunkDurationSec,
	                  processedSizeBytes: uploadFile.size,
	                  rawSizeBytes: retryFile.size,
	                });
	                rawRetryRecovered = true;
	              } else {
	                telemetry.stopTimer("cloud_transcribe");
	                throw rawRetryError;
	              }
	            } else {
	              logger.warn(`[cloud][${providerLogKey}] audio retry requested but raw chunk is unavailable`, {
	                provider,
	                model,
	                segmentIndex: staged.index,
	                chunkDurationSec,
	                processedSizeBytes: uploadFile.size,
	                message: describeRetryableCloudError(error),
	              });
	              telemetry.logEvent("LOG_WARN", {
	                context: "cloud_audio_raw_retry_unavailable",
	                ...retrySummary,
	                retryAttempted: false,
	              });
	              await sendFrontendAudioErrorReport({
	                provider,
	                backendError: error,
	                originalFile: buildAudioReportFile(sourceFile, "source"),
	                processedFile: buildAudioReportFile(uploadFile, "processed"),
	                rawFile: null,
	                retry: {
	                  attempted: false,
	                  succeeded: false,
	                  usedRawFile: false,
	                },
	                telemetry,
	                traceId: reportTraceId,
	              });
	            }
	          }

	          if (!rawRetryRecovered) {
	            if (splitSegments && shouldRetryMistralChunkBySplitting(error)) {
	              logger.warn(`[cloud][${providerLogKey}] chunk timed out upstream, splitting and restaging`, {
	                provider,
	                model,
	                segmentIndex: staged.index,
	                startSec: staged.startSec,
	                endSec: staged.endSec,
	                chunkDurationSec,
	                sizeBytes: uploadFile.size,
	                pendingSegments: stagedSegments.length,
	                message: describeRetryableCloudError(error),
	              });
	              telemetry.logEvent("LOG_WARN", {
	                context: "cloud_mistral_chunk_split_timeout",
	                provider,
	                model,
	                segmentIndex: staged.index,
	                startSec: staged.startSec,
	                endSec: staged.endSec,
	                chunkDurationSec,
	                sizeBytes: uploadFile.size,
	                pendingSegments: stagedSegments.length,
	                message: describeRetryableCloudError(error),
	              });
	              telemetry.stopTimer("cloud_transcribe");
	              await deleteSegment(sessionId, staged.index);
	              const restageResult = await stageCloudSegments({
	                sessionId,
	                sourceFile,
	                provider: isDemeter ? "demeter_sante" : "mistral",
	                segments: splitSegments,
	                preprocessSettings,
	                telemetry,
	                maxUploadBytes: MISTRAL_MAX_UPLOAD_BYTES,
	                startIndex: nextStagedIndex,
	                shouldAbort,
	              });
	              nextStagedIndex = restageResult.nextIndex;
	              if (restageResult.aborted || shouldAbort()) {
	                logger.info(`[cloud][${providerLogKey}] run aborted during split restaging`, { runId });
	                return;
	              }
	              stagedSegments.splice(stagedPosition + 1, 0, ...restageResult.stagedSegments);
	              continue;
	            }

	            telemetry.stopTimer("cloud_transcribe");
	            throw error;
	          }
	        }

        telemetry.stopTimer("cloud_transcribe");

        if (shouldAbort()) {
          logger.info(`[cloud][${providerLogKey}] run aborted after inference`, { runId, stagedPosition });
          return;
        }

        const chunkNumber = sentChunkCount + 1;
        const chunkId = `${providerLogKey}-${chunkNumber}`;
        const parsedSegments = parseMistralOutput(output, {
          offsetSec: staged.startSec,
          startIndex: nextIndex,
          chunkId,
          fallbackDurationSec: chunkDurationSec,
          includeWordTimestamps: settings.cloudEnableWordTimestamps,
        });
        nextIndex += parsedSegments.length;
        appendCloudSegments(parsedSegments, provider, metadata);
        allSegments = segmentsRef.current;
        sentChunkCount = chunkNumber;

        await deleteSegment(sessionId, staged.index);

        const summary = summarizeSegments(parsedSegments);
        logger.debug(`[cloud][${providerLogKey}] segments ready`, {
          ...summary,
          provider,
          segmentIndex: sentChunkCount - 1,
          totalSegments: stagedSegments.length,
        });
        telemetry.logEvent("CLOUD_SEGMENTS_READY", {
          provider,
          segmentIndex: sentChunkCount - 1,
          totalSegments: stagedSegments.length,
          count: summary.count,
          totalDurationSec: summary.totalDurationSec,
          textChars: summary.textChars,
          tokenCount: summary.tokenCount,
        });

        setProgress(Math.max(0, Math.min(1, 0.5 + (sentChunkCount / Math.max(1, stagedSegments.length)) * 0.5)));
      }

      await deleteSessionSegments(sessionId);
      cloudSessionIdRef.current = null;

      const summary = summarizeSegments(allSegments);
      logger.info(`[cloud][${providerLogKey}] all segments ready`, { ...summary, provider });
      telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { provider, segments: allSegments.length });
      setProgress(1);
      setStatus("done");
      setStatusDetail("Transcription terminée");
    } catch (error) {
      telemetry.stopTimer("cloud_preprocess");
      throw error;
    }
  }, [
    appendCloudSegments,
    provider,
    mistralApiKey,
    cloudMistralDiarizationEnabled,
    cloudDemeterDiarizationEnabled,
    cloudMistralApiUrl,
    cloudMistralModel,
    cloudDemeterModel,
    persistCloudTune,
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
    const currentFile = selectedFile;
    const telemetry = new TelemetryCollector();
    telemetryRef.current = telemetry;
    registerTelemetry(telemetry);
    setGlobalTelemetrySummary(null);
    telemetry.startTimer("cloud_total");
    logger.info("[cloud] transcription run requested", {
      provider,
      fileName: currentFile.name,
      sizeBytes: currentFile.size,
      mimeType: currentFile.type || "application/octet-stream",
    });
    settings.clearSpeakerAssignments("cloud");
    clearSessionTranscriptMemory("cloud");
    resetCloudTranscriptBuffers();
    setProgress(0);
    setStopRequested(false);

    if (currentFile.size === 0) {
      const emptyAudioMessage = "Fichier audio vide";
      logger.warn("[cloud] empty audio source file", {
        provider,
        fileName: currentFile.name,
        mimeType: currentFile.type || "application/octet-stream",
        sizeBytes: currentFile.size,
      });
      telemetry.recordAlert("CLOUD_AUDIO_FILE_EMPTY", {
        provider,
        fileName: currentFile.name,
        mimeType: currentFile.type || "application/octet-stream",
        sizeBytes: currentFile.size,
      });
      setStatus("error");
      setStatusDetail(emptyAudioMessage);
      await sendFrontendAudioErrorReport({
        provider,
        backendError: {
          status: 400,
          code: "empty_audio_file",
          message: emptyAudioMessage,
          path: isDemeter ? "/providers/demeter-sante/audio/transcriptions" : "/v1/audio/transcriptions",
          method: "POST",
        },
        originalFile: buildAudioReportFile(currentFile, "source"),
        processedFile: buildAudioReportFile(currentFile, "processed"),
        rawFile: null,
        retry: {
          attempted: false,
          succeeded: false,
          usedRawFile: false,
        },
        telemetry,
      });
      return;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    activeTranscriptProviderRef.current = provider;
    setIsTranscribing(true);

    try {
      const metadata = audioMetadata ?? await probeAudioMetadata(currentFile);
      if (!audioMetadata) {
        setAudioMetadata(metadata);
      }
      logger.info("[cloud] transcription run started", {
        provider,
        fileName: currentFile.name,
        sizeBytes: currentFile.size,
        mimeType: currentFile.type || "application/octet-stream",
        durationSec: metadata.durationSec,
        sampleRate: metadata.sampleRate ?? null,
        channels: metadata.channels ?? null,
        preprocessingMode: settings.cloudPreprocessingMode,
        showSegments: settings.cloudShowSegments,
        enableWordTimestamps: settings.cloudEnableWordTimestamps,
        showSegmentConfidence: settings.cloudShowSegmentConfidence,
      });
      telemetry.logEvent("CLOUD_TRANSCRIBE_START", {
        provider,
        fileName: currentFile.name,
        sizeBytes: currentFile.size,
        mimeType: currentFile.type || "application/octet-stream",
        durationSec: metadata.durationSec,
        sampleRate: metadata.sampleRate ?? null,
        channels: metadata.channels ?? null,
        preprocessingMode: settings.cloudPreprocessingMode,
        showSegments: settings.cloudShowSegments,
        enableWordTimestamps: settings.cloudEnableWordTimestamps,
        showSegmentConfidence: settings.cloudShowSegmentConfidence,
      });
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

      const backendDirectRoute =
        isDemeter && Number.isFinite(metadata.durationSec) && metadata.durationSec > CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC;

      const backendDemeterChunking = resolveEffectiveMistralChunking(
        settings.cloudDemeterModel,
        settings.cloudMistralChunkDurationSec,
        settings.cloudMistralOverlapSec
      );

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
              chunkingMode: backendDirectRoute ? "backend_direct" : "duration-first-with-fallback-split",
              backendDirectAudioThresholdSec: CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC,
              backendDirectAudioUsed: backendDirectRoute,
              chunkDurationSec: backendDemeterChunking.effectiveDurationSec,
              overlapSec: backendDemeterChunking.effectiveOverlapSec,
              modelMaxChunkDurationSec: backendDemeterChunking.modelMaxDurationSec,
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

      if (backendDirectRoute) {
        setStatus("uploading");
        setStatusDetail("Audio long, traitement backend");
        setPreparedUpload(null);
        await runDemeterBackendDirectTranscription({
          runId,
          settings,
          metadata,
          telemetry,
        });
        trackBackendActivityEvent({
          eventKind: "transcription",
          sourceMode: resolveCloudActivitySourceMode(provider),
          provider,
          status: "success",
          meta: { source: "cloud", runId, routeMode: "backend_direct" },
        });
        return;
      }

      if (isMistral || isDemeter) {
        setStatus("preprocessing");
        setStatusDetail("Préparation des segments");
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
        logger.warn("[cloud] unauthorized, attempting refresh before final error handling");
        try {
          const refreshed = await backendRefresh();
          if (!refreshed && !isBackendAuthenticated()) {
            handleBackendUnauthorized(err);
          }
        } catch (refreshError) {
          logger.warn("[cloud] refresh request failed", {
            message: refreshError instanceof Error ? refreshError.message : String(refreshError),
          });
        }
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
      telemetryRef.current = null;
      cloudTranscriptTextRef.current = "";
      cloudTranscriptSegmentCountRef.current = 0;
      await releaseFfmpeg();
      await cleanupTransientSessionCache();
      setPreparedUpload(null);
      setPreviewUrl(null);
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
    runDemeterBackendDirectTranscription,
    runMistralTranscription,
    runWhisperTranscription,
    resolvedSettings,
    clearSessionTranscriptMemory,
    cleanupTransientSessionCache,
    resetCloudTranscriptBuffers,
    setGlobalTelemetrySummary,
    selectedFile,
    status,
  ]);

  return {
    selectedFile,
    previewUrl,
    audioMetadata,
    segments,
    chunkSummaries,
    chunkGroups: chunkSummaries,
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
    updateSegmentText,
    updateSegmentSpeaker,
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
