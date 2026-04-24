import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAsrStore } from "@/store/asr-store";
import { TelemetryCollector } from "@/lib/telemetry";
import { probeAudioMetadata, type AudioMetadata } from "@/lib/audio";
import { buildFixedSegments } from "@/lib/chunking";
import { type CloudAutoTuneResult, type CloudPreprocessSettings } from "@/lib/cloud/preprocessCloudAudio";
import logger from "@/lib/logger";
import { toast } from "@/components/ui/use-toast";
import type { TranscriptionSegment, WordSegment } from "@/lib/export";
import { summarizeSegments } from "@/lib/cloud/segmentSummary";
import { stageCloudSegments, type CloudStagedSegment } from "@/lib/cloud/cloudStaging";
import { splitCloudSegmentWindow } from "@/lib/cloud/segmentWindows";
import { deleteSegment, getSegment, type CachedSegment } from "@/lib/segment-cache";
import { getWhisperClient } from "@/lib/cloud/whisperClient";
import { buildWhisperParameters } from "@/lib/cloud/whisperParams";
import { parseWhisperOutput } from "@/lib/cloud/whisperSegments";
import { MISTRAL_MAX_UPLOAD_BYTES, transcribeWithMistral } from "@/lib/cloud/mistralClient";
import { resolveMistralSegmentDurationSec } from "@/lib/cloud/mistralParams";
import { parseMistralOutput } from "@/lib/cloud/mistralSegments";
import {
  transcribeWithDemeterSante,
  type DemeterBackendTranscriptionOperationResponse,
  type DemeterTranscriptionChunk,
  type DemeterTranscriptionChunkSegment,
  type DemeterTranscriptionResponse,
} from "@/lib/cloud/demeterClient";
import { clampDemeterChunkDurationSec, DEMETER_CHUNK_DURATION_MAX_SEC, DEMETER_CHUNK_DURATION_DEFAULT_SEC } from "@/lib/storage";
import { backendRefresh, isBackendSessionExpiredError } from "@/lib/backend-auth";
import {
  sendFrontendAudioErrorReport,
  shouldRetryAudioUpload,
  type AudioErrorReportFile,
} from "@/lib/cloud/audioErrorReport";
import {
  formatBackendErrorMessage,
  isBackendForbiddenError,
  isBackendUnauthorizedError,
} from "@/lib/backend-api";
import { resolveChunkingConfig } from "@/hooks/useCloudTranscription.steps";
import { createSessionTranscriptMemoryEntry } from "@/lib/sessionTranscriptMemory";
import {
  buildSpeakerAwareTranscriptText,
  decorateSegmentsWithSpeakerLabels,
  resolveSegmentSpeakerDisplay,
  type SpeakerAssignmentMap,
} from "@/lib/speakerAssignments";
import { createSecureId } from "@/lib/secure-id";
import { BACKGROUND_RESUME_MESSAGE } from "@/lib/transcriptionVisibility";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";
import { trackBackendPerformanceSummary } from "@/lib/backend-performance-sync";
import { releaseFfmpeg } from "@/lib/ffmpeg-loader";
import { type CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";
import { useDocumentVisibility } from "@/lib/documentVisibility";
import {
  appendCloudTranscriptChunkSegments,
  deleteCloudTranscriptSession,
  loadCloudTranscriptChunkSegments,
  loadCloudTranscriptSegmentsForExport,
  replaceCloudTranscriptChunkSegments,
  updateCloudTranscriptSegment,
} from "@/lib/cloud/cloudTranscriptCache";
import type { CloudTranscriptionStatus } from "@/store/asr-store";

type CloudTranscriptionOptions = {
  forceDemeterBackendDirect?: boolean;
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

const sharedCloudRunControl = {
  runId: 0,
  abortController: null as AbortController | null,
  sessionId: null as string | null,
  stopRequested: false,
};

function nextCloudRunId() {
  sharedCloudRunControl.runId += 1;
  return sharedCloudRunControl.runId;
}

function getCloudRunId() {
  return sharedCloudRunControl.runId;
}

function setCloudRunAbortController(controller: AbortController | null) {
  sharedCloudRunControl.abortController = controller;
}

function getCloudRunAbortController() {
  return sharedCloudRunControl.abortController;
}

function setCloudSessionId(sessionId: string | null) {
  sharedCloudRunControl.sessionId = sessionId;
}

function getCloudSessionId() {
  return sharedCloudRunControl.sessionId;
}

function setCloudStopRequested(value: boolean) {
  sharedCloudRunControl.stopRequested = value;
}

function getCloudStopRequested() {
  return sharedCloudRunControl.stopRequested;
}

function isAbortErrorLike(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === "AbortError");
}

function resolveDemeterBackendOperationStatus(snapshot: DemeterBackendTranscriptionOperationResponse): {
  status: CloudTranscriptionStatus;
  detail: string;
} {
  const backendStatus = String(snapshot.status ?? "").trim().toLowerCase();
  const backendStage = String(snapshot.stage ?? "").trim().toLowerCase();
  const chunkIndex = Math.max(0, snapshot.chunkIndex ?? 0);
  const chunkCount = Math.max(0, snapshot.chunkCount ?? 0);
  if (backendStatus === "pending" || backendStage === "queued") {
    return { status: "queued", detail: "Transcription en file d'attente" };
  }
  if (backendStatus === "running") {
    return {
      status: "transcribing",
      detail:
        chunkCount > 0
          ? `Transcription Demeter · ${chunkIndex}/${chunkCount}`
          : "Transcription Demeter en cours",
    };
  }
  if (backendStatus === "completed") {
    return { status: "done", detail: "Transcription terminée" };
  }
  if (backendStatus === "cancelled") {
    return { status: "stopping", detail: "Transcription annulée" };
  }
  if (backendStatus === "failed") {
    return {
      status: "error",
      detail: snapshot.lastError?.trim() || "La transcription a échoué",
    };
  }
  return {
    status: "transcribing",
    detail:
      chunkCount > 0 ? `Transcription Demeter · ${chunkIndex}/${chunkCount}` : "Transcription Demeter en cours",
  };
}

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

export function useCloudTranscription(
  provider: "whisper" | "mistral" | "demeter_sante",
  options: CloudTranscriptionOptions = {}
) {
  const forceDemeterBackendDirect = options.forceDemeterBackendDirect ?? false;
  const cloudSession = useAsrStore((s) => s.cloudTranscriptionSession);
  const cloudStatus = useAsrStore((s) => s.cloudStatus);
  const cloudStatusDetail = useAsrStore((s) => s.cloudStatusDetail);
  const visibilitySnapshot = useDocumentVisibility();

  const selectedFile = cloudSession.selectedFile;
  const previewUrl = cloudSession.previewUrl;
  const audioMetadata = cloudSession.audioMetadata;
  const preparedUpload = cloudSession.preparedUpload;
  const chunkSummaries = cloudSession.chunkSummaries;
  const progress = cloudSession.progress;
  const isTranscribing = cloudSession.isTranscribing;
  const isResettingSession = cloudSession.isResettingSession;
  const stopRequested = cloudSession.stopRequested;
  const telemetrySummary = useAsrStore((s) => s.telemetrySummary);

  const cloudTranscriptTextRef = useRef("");
  const cloudTranscriptSegmentCountRef = useRef(0);
  const runCompletedRef = useRef(false);
  const runExpiredRef = useRef(false);
  const activeTranscriptProviderRef = useRef(provider);
  const telemetryRef = useRef<TelemetryCollector | null>(null);
  const backendDirectSeenChunkIdsRef = useRef<Set<string>>(new Set());
  const backendDirectAppendQueueRef = useRef<Promise<void>>(Promise.resolve());
  const resumeAfterVisibilityRef = useRef(false);

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
  const setCloudTranscriptionSession = useAsrStore((s) => s.setCloudTranscriptionSession);
  const resetCloudTranscriptionSession = useAsrStore((s) => s.resetCloudTranscriptionSession);
  const setCloudStatus = useAsrStore((s) => s.setCloudStatus);
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

  const consumeDemeterBackendOperationSnapshot = useCallback(
    (
      snapshot: DemeterBackendTranscriptionOperationResponse,
      options: {
        sourceFile: File;
        shouldAbort: () => boolean;
        onResponse?: (response: DemeterTranscriptionResponse, snapshot: DemeterBackendTranscriptionOperationResponse) => void;
      }
    ) => {
      if (options.shouldAbort()) {
        return;
      }
      const chunkIndex = Math.max(0, snapshot.chunkIndex ?? 0);
      const chunkCount = Math.max(0, snapshot.chunkCount ?? 0);
      const backendProgress =
        typeof snapshot.progress === "number"
          ? Math.max(0, Math.min(1, snapshot.progress))
          : chunkCount > 0
            ? Math.max(0, Math.min(1, chunkIndex / chunkCount))
            : 0;
      const backendStatus = resolveDemeterBackendOperationStatus(snapshot);
      setCloudTranscriptionSession({
        preparedUpload: {
          provider: "demeter_sante",
          fileName: options.sourceFile.name,
          mimeType: options.sourceFile.type || "application/octet-stream",
          sizeBytes: options.sourceFile.size,
          chunkIndex,
          totalChunks: chunkCount,
        },
        progress: Math.max(0.5, 0.5 + backendProgress * 0.5),
      });
      setCloudStatus(backendStatus.status, backendStatus.detail);
      if (snapshot.status === "completed" && snapshot.response && options.onResponse) {
        options.onResponse(snapshot.response, snapshot);
      }
    },
    [setCloudStatus, setCloudTranscriptionSession]
  );

  const resetCloudTranscriptBuffers = useCallback(() => {
    cloudTranscriptTextRef.current = "";
    cloudTranscriptSegmentCountRef.current = 0;
    setCloudTranscriptionSession({
      chunkSummaries: [],
      sessionId: null,
    });
    setCloudSessionId(null);
  }, [setCloudTranscriptionSession]);

  const clearCloudSessionState = useCallback(
    (detail = "Session réinitialisée") => {
      const currentPreviewUrl = useAsrStore.getState().cloudTranscriptionSession.previewUrl;
      if (currentPreviewUrl) {
        try {
          URL.revokeObjectURL(currentPreviewUrl);
        } catch (err) {
          void err;
        }
      }
      setCloudRunAbortController(null);
      setCloudStopRequested(false);
      resumeAfterVisibilityRef.current = false;
      backendDirectSeenChunkIdsRef.current.clear();
      backendDirectAppendQueueRef.current = Promise.resolve();
      telemetryRef.current = null;
      resetCloudTranscriptBuffers();
      registerAudioSource(null);
      setRunExportHeader("cloud", null);
      resetCloudTranscriptionSession();
      clearSessionTranscriptMemory("cloud");
      setGlobalTelemetrySummary(null);
      registerTelemetry(null);
      setCloudStatus("idle", detail);
    },
    [
      clearSessionTranscriptMemory,
      registerAudioSource,
      registerTelemetry,
      resetCloudTranscriptBuffers,
      resetCloudTranscriptionSession,
      setGlobalTelemetrySummary,
      setRunExportHeader,
      setCloudStatus,
    ]
  );

  const discardCloudTranscriptCache = useCallback(async () => {
    const sessionId = getCloudSessionId();
    if (!sessionId) {
      return;
    }

    setCloudSessionId(null);
    setCloudTranscriptionSession({ sessionId: null });
    try {
      await deleteCloudTranscriptSession(sessionId);
    } catch (error) {
      logger.warn("[cloud] failed to clean transient session cache", {
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [setCloudTranscriptionSession]);

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
      const transcriptText = cloudTranscriptTextRef.current;
      const segmentCount = cloudTranscriptSegmentCountRef.current;
      const currentFile = useAsrStore.getState().cloudTranscriptionSession.selectedFile;
      setSessionTranscriptMemory(
        "cloud",
        createSessionTranscriptMemoryEntry({
          mode: "cloud",
          provider: providerName,
          segments: [],
          transcriptText,
          segmentCount,
          audioSource: currentFile
            ? { id: `${providerName}:${currentFile.name}:${currentFile.size}`, label: currentFile.name, type: "file" }
            : null,
          audioMetadata: metadata,
        })
      );
    },
    [setSessionTranscriptMemory]
  );

  const replaceCloudChunkSummaries = useCallback((nextSummaries: CloudTranscriptionChunkGroup[]) => {
    setCloudTranscriptionSession({ chunkSummaries: nextSummaries });
  }, [setCloudTranscriptionSession]);

  const upsertCloudChunkSummary = useCallback((nextSummary: CloudTranscriptionChunkGroup) => {
    const currentSummaries = useAsrStore.getState().cloudTranscriptionSession.chunkSummaries;
    replaceCloudChunkSummaries(upsertCloudChunkSummaries(currentSummaries, nextSummary));
  }, [replaceCloudChunkSummaries]);

  const appendCloudSegments = useCallback(
    async (
      nextSegments: TranscriptionSegment[],
      providerName: "whisper" | "mistral" | "demeter_sante",
      metadata: AudioMetadata | null
    ) => {
      if (!nextSegments.length) {
        return;
      }

      const sessionId = getCloudSessionId();
      if (!sessionId) {
        logger.warn("[cloud] missing transcript session while appending segments", {
          provider: providerName,
          segmentCount: nextSegments.length,
        });
        return;
      }

      const speakerAssignments = useAsrStore.getState().speakerAssignments.cloud;
      const decoratedSegments = decorateSegmentsWithSpeakerLabels(nextSegments, speakerAssignments, "cloud");
      const appendedText = buildSpeakerAwareTranscriptText(decoratedSegments, speakerAssignments, "cloud");
      if (appendedText) {
        cloudTranscriptTextRef.current = cloudTranscriptTextRef.current
          ? `${cloudTranscriptTextRef.current}\n${appendedText}`
          : appendedText;
      }

      cloudTranscriptSegmentCountRef.current += nextSegments.length;

      const groupedSegments = groupCloudSegmentsByChunkId(decoratedSegments);
      for (const group of groupedSegments) {
        const currentSummaries = useAsrStore.getState().cloudTranscriptionSession.chunkSummaries;
        const existingSummary = currentSummaries.find((chunk) => chunk.chunkId === group.chunkId);
        const chunkIndex = existingSummary?.chunkIndex ?? currentSummaries.length;

        const updateResult = await appendCloudTranscriptChunkSegments({
          sessionId,
          chunkId: group.chunkId,
          chunkIndex,
          segments: group.segments,
        });
        upsertCloudChunkSummary(updateResult.summary);
      }
      logger.debug("[cloud] transcript segments appended", {
        provider: providerName,
        appendedCount: decoratedSegments.length,
        totalSegments: cloudTranscriptSegmentCountRef.current,
        transcriptChars: cloudTranscriptTextRef.current.length,
      });
      publishCloudTranscriptMemory(providerName, metadata);
    },
    [publishCloudTranscriptMemory, upsertCloudChunkSummary]
  );

  const refreshCloudTranscriptMemoryFromCache = useCallback(
    async (providerName: "whisper" | "mistral" | "demeter_sante", metadata: AudioMetadata | null) => {
      const sessionId = getCloudSessionId();
      if (!sessionId) {
        return;
      }
      const allSegments = await loadCloudTranscriptSegmentsForExport(sessionId);
      const speakerAssignments = useAsrStore.getState().speakerAssignments.cloud;
      cloudTranscriptTextRef.current = buildSpeakerAwareTranscriptText(allSegments, speakerAssignments, "cloud");
      cloudTranscriptSegmentCountRef.current = allSegments.length;
      publishCloudTranscriptMemory(providerName, metadata);
    },
    [publishCloudTranscriptMemory]
  );

  const updateSegmentText = useCallback(
    async (chunkId: string, segmentIndex: number, nextText: string) => {
      const normalizedText = nextText.trim();
      const sessionId = getCloudSessionId();
      if (!sessionId) {
        logger.warn("[cloud] segment text update ignored, missing session", { chunkId, segmentIndex });
        return;
      }
      const result = await updateCloudTranscriptSegment(sessionId, chunkId, segmentIndex, (segment) =>
        segment.text === normalizedText ? segment : { ...segment, text: normalizedText }
      );
      if (!result) {
        return;
      }
      upsertCloudChunkSummary(result.summary);
      await refreshCloudTranscriptMemoryFromCache(activeTranscriptProviderRef.current, audioMetadata);

      logger.info("[cloud] segment text updated", {
        provider: activeTranscriptProviderRef.current,
        chunkId,
        segmentIndex,
        textLength: normalizedText.length,
      });
    },
    [audioMetadata, refreshCloudTranscriptMemoryFromCache, upsertCloudChunkSummary]
  );

  const updateSegmentSpeaker = useCallback(
    async (chunkId: string, segmentIndex: number, nextSpeaker: string) => {
      const normalizedSpeaker = nextSpeaker.trim();
      const sessionId = getCloudSessionId();
      if (!sessionId) {
        logger.warn("[cloud] segment speaker update ignored, missing session", { chunkId, segmentIndex });
        return;
      }
      const speakerAssignments = useAsrStore.getState().speakerAssignments.cloud;
      const result = await updateCloudTranscriptSegment(sessionId, chunkId, segmentIndex, (segment) => {
        const currentSpeaker = segment.speaker?.trim() ?? "";
        if (currentSpeaker === normalizedSpeaker) {
          return segment;
        }
        const nextSpeakerLabel =
          normalizedSpeaker.length > 0
            ? resolveSegmentSpeakerDisplay(
                {
                  ...segment,
                  speaker: normalizedSpeaker,
                  speakerLabel: undefined,
                },
                speakerAssignments,
                "cloud"
              ) ?? normalizedSpeaker
            : undefined;
        const nextSegment = {
          ...segment,
          speaker: normalizedSpeaker || undefined,
          speakerLabel: nextSpeakerLabel,
        };
        return nextSegment;
      });
      if (!result) {
        return;
      }
      upsertCloudChunkSummary(result.summary);
      await refreshCloudTranscriptMemoryFromCache(activeTranscriptProviderRef.current, audioMetadata);

      logger.info("[cloud] segment speaker updated", {
        provider: activeTranscriptProviderRef.current,
        chunkId,
        segmentIndex,
        speakerId: normalizedSpeaker || null,
      });
    },
    [audioMetadata, refreshCloudTranscriptMemoryFromCache, upsertCloudChunkSummary]
  );

  const applyChunkSpeakerAssignments = useCallback(
    async (chunkId: string, nextAssignments: SpeakerAssignmentMap) => {
      const sessionId = getCloudSessionId();
      if (!sessionId) {
        logger.warn("[cloud] chunk speaker assignments ignored, missing session", { chunkId });
        return;
      }
      const currentSegments = await loadCloudTranscriptChunkSegments(sessionId, chunkId);
      if (!currentSegments.length) {
        return;
      }
      const nextSegments = decorateSegmentsWithSpeakerLabels(currentSegments, nextAssignments, "cloud");
      const currentChunk = useAsrStore.getState().cloudTranscriptionSession.chunkSummaries.find(
        (chunk) => chunk.chunkId === chunkId
      );
      const result = await replaceCloudTranscriptChunkSegments({
        sessionId,
        chunkId,
        chunkIndex: currentChunk?.chunkIndex ?? 0,
        segments: nextSegments,
      });
      upsertCloudChunkSummary(result.summary);
      await refreshCloudTranscriptMemoryFromCache(activeTranscriptProviderRef.current, audioMetadata);

      logger.info("[cloud] chunk speaker assignments persisted", {
        provider: activeTranscriptProviderRef.current,
        chunkId,
        segmentCount: nextSegments.length,
      });
    },
    [audioMetadata, refreshCloudTranscriptMemoryFromCache, upsertCloudChunkSummary]
  );

  const loadChunkSegments = useCallback(async (chunkId: string) => {
    const sessionId = getCloudSessionId();
    if (!sessionId) {
      return [];
    }
    return loadCloudTranscriptChunkSegments(sessionId, chunkId);
  }, []);

  const loadAllSegmentsForExport = useCallback(async () => {
    const sessionId = getCloudSessionId();
    if (!sessionId) {
      return [];
    }
    return loadCloudTranscriptSegmentsForExport(sessionId);
  }, []);

  function upsertCloudChunkSummaries(
    current: CloudTranscriptionChunkGroup[],
    nextSummary: CloudTranscriptionChunkGroup
  ): CloudTranscriptionChunkGroup[] {
    const next = [...current];
    const existingIndex = next.findIndex((chunk) => chunk.chunkId === nextSummary.chunkId);
    if (existingIndex >= 0) {
      next[existingIndex] = nextSummary;
    } else {
      next.push(nextSummary);
    }
    return next.sort((left, right) => left.chunkIndex - right.chunkIndex || left.start - right.start);
  }

  const abortCloudRunAndWait = useCallback(async () => {
    nextCloudRunId();
    setCloudStopRequested(true);
    setCloudTranscriptionSession({ stopRequested: true });
    getCloudRunAbortController()?.abort();
    const wasRunning = useAsrStore.getState().cloudTranscriptionSession.isTranscribing;
    if (!wasRunning) {
      return;
    }

    setCloudStatus("stopping", "Arrêt forcé");

    const start = Date.now();
    const timeoutMs = 15000;
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (!useAsrStore.getState().cloudTranscriptionSession.isTranscribing) {
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
  }, [setCloudStatus, setCloudTranscriptionSession]);

  const resetTranscriptionSession = useCallback(async () => {
    if (isResettingSession) {
      return;
    }
    setCloudTranscriptionSession({ isResettingSession: true });
    try {
      await abortCloudRunAndWait();
      await discardCloudTranscriptCache();
    } finally {
      clearCloudSessionState();
    }
  }, [
    abortCloudRunAndWait,
    clearCloudSessionState,
    discardCloudTranscriptCache,
    isResettingSession,
    setCloudTranscriptionSession,
  ]);

  const handleFileSelected = useCallback(async (file: File) => {
    logger.info("[cloud] file selected", { provider, name: file.name, size: file.size, type: file.type });
    await discardCloudTranscriptCache();
    const currentPreviewUrl = useAsrStore.getState().cloudTranscriptionSession.previewUrl;
    if (currentPreviewUrl) {
      try {
        URL.revokeObjectURL(currentPreviewUrl);
      } catch (err) {
        void err;
      }
    }
    resetCloudTranscriptionSession();
    registerAudioSource(
      {
        id: `${provider}:${file.name}:${file.size}`,
        label: file.name,
        type: "file",
      },
      null
    );
    setRunExportHeader("cloud", null);
    resetCloudTranscriptBuffers();
    telemetryRef.current = null;
    setGlobalTelemetrySummary(null);
    registerTelemetry(null);
    setCloudStatus("idle", "Fichier chargé, prêt à lancer");
    setCloudTranscriptionSession({
      selectedFile: file,
      audioMetadata: null,
      preparedUpload: null,
      progress: 0,
      isTranscribing: false,
      isResettingSession: false,
      stopRequested: false,
    });
    setCloudSessionId(null);
    setCloudStopRequested(false);
    resumeAfterVisibilityRef.current = false;
    try {
      const metadata = await probeAudioMetadata(file);
      setCloudTranscriptionSession({ audioMetadata: metadata });
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
      setCloudStatus("error", "Impossible de lire les métadonnées audio");
    }
  }, [
    discardCloudTranscriptCache,
    provider,
    registerAudioSource,
    registerTelemetry,
    resetCloudTranscriptBuffers,
    resetCloudTranscriptionSession,
    setGlobalTelemetrySummary,
    setRunExportHeader,
    setCloudStatus,
    setCloudTranscriptionSession,
  ]);

  const stopTranscription = useCallback(async () => {
    if (!isTranscribing) return;
    setCloudStopRequested(true);
    setCloudTranscriptionSession({ stopRequested: true });
    setCloudStatus("stopping", "Arrêt demandé");
    getCloudRunAbortController()?.abort();
    resumeAfterVisibilityRef.current = false;
    const telemetry = telemetryRef.current;
    telemetry?.logEvent("STOP_REQUESTED", { context: "cloud" });
    logger.info("[cloud] stop requested", { provider });
    if (provider === "whisper") {
      telemetry?.logEvent("CLOUD_WHISPER_STOP_REQUESTED", { provider });
    } else if (provider === "mistral" || provider === "demeter_sante") {
      telemetry?.logEvent("CLOUD_MISTRAL_STOP_REQUESTED", { provider });
    }
  }, [isTranscribing, provider, setCloudStatus, setCloudTranscriptionSession]);

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
    const shouldAbort = () => getCloudStopRequested() || getCloudRunId() !== runId;
    const sessionId = getCloudSessionId() ?? createSecureId("cloud-");
    setCloudSessionId(sessionId);
    setCloudTranscriptionSession({ sessionId });

    const allSegments: TranscriptionSegment[] = [];
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
          setCloudStatus("preprocessing", `Préparation locale · ${completed}/${total}`);
          setCloudTranscriptionSession({
            progress: Math.max(0, Math.min(0.5, total > 0 ? (completed / total) * 0.5 : 0)),
          });
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

      setCloudStatus("uploading", `Envoi des segments préparés · 0/${stagedSegments.length}`);
      setCloudTranscriptionSession({ progress: 0.5 });

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

        setCloudTranscriptionSession({
          preparedUpload: {
            provider: "whisper",
            fileName: uploadFile.name,
            mimeType: uploadFile.type,
            sizeBytes: uploadFile.size,
            chunkIndex: stagedPosition + 1,
            totalChunks: stagedSegments.length,
          },
        });

        setCloudStatus("transcribing", `Transcription Whisper · ${stagedPosition + 1}/${stagedSegments.length}`);
        setCloudTranscriptionSession({
          progress: Math.max(0, Math.min(1, 0.5 + (stagedPosition / Math.max(1, stagedSegments.length)) * 0.5)),
        });
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
        await appendCloudSegments(parsedSegments, "whisper", metadata);
        allSegments.push(...parsedSegments);

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

        setCloudTranscriptionSession({
          progress: Math.max(0, Math.min(1, 0.5 + ((stagedPosition + 1) / Math.max(1, stagedSegments.length)) * 0.5)),
        });
      }

      const summary = summarizeSegments(allSegments);
      logger.info("[cloud][whisper] all segments ready", summary);
      telemetry.logEvent("CLOUD_WHISPER_DONE", { segments: allSegments.length });
      setCloudTranscriptionSession({ progress: 1 });
      setCloudStatus("done", "Transcription terminée");
      resumeAfterVisibilityRef.current = false;
      runCompletedRef.current = true;
    } catch (error) {
      telemetry.stopTimer("cloud_preprocess");
      throw error;
    }
  }, [
    appendCloudSegments,
    hfApiToken,
    persistCloudTune,
    resolvedSettings,
    selectedFile,
    setCloudStatus,
    setCloudTranscriptionSession,
  ]);

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
    const shouldAbort = () => getCloudStopRequested() || getCloudRunId() !== runId;
    let backendDiarizationEffective = diarizationEnabled;
    let backendDiarizationFallbackChunks = 0;
    const sessionId = getCloudSessionId() ?? createSecureId("cloud-");
    setCloudSessionId(sessionId);
    setCloudTranscriptionSession({ sessionId });
    const backendRunAbortController = new AbortController();
    setCloudRunAbortController(backendRunAbortController);
    backendDirectSeenChunkIdsRef.current.clear();
    backendDirectAppendQueueRef.current = Promise.resolve();
    let nextDemeterSegmentIndex = 0;

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
      consumeDemeterBackendOperationSnapshot(snapshot, {
        sourceFile,
        shouldAbort,
        onResponse: (response, responseSnapshot) => {
          const chunkBatch = buildDemeterBackendChunkBatch(response, {
            fallbackChunkId: "demeter-backend-direct",
            includeWordTimestamps: settings.cloudEnableWordTimestamps,
            startSegmentIndex: nextDemeterSegmentIndex,
          });
          nextDemeterSegmentIndex = chunkBatch.nextSegmentIndex;
          const nextChunkGroups = chunkBatch.groups.filter((group) => {
            const normalizedChunkId = normalizeChunkId(group.chunkId);
            if (!normalizedChunkId) {
              return false;
            }
            if (backendDirectSeenChunkIdsRef.current.has(normalizedChunkId)) {
              return false;
            }
            backendDirectSeenChunkIdsRef.current.add(normalizedChunkId);
            return true;
          });
          if (!nextChunkGroups.length) {
            return;
          }

          const chunkIndex = Math.max(0, responseSnapshot.chunkIndex ?? 0);
          const chunkCount = Math.max(0, responseSnapshot.chunkCount ?? 0);
          const appendedSegmentCount = nextChunkGroups.reduce((count, group) => count + group.segments.length, 0);
          backendDirectAppendQueueRef.current = backendDirectAppendQueueRef.current
            .catch(() => undefined)
            .then(async () => {
              if (shouldAbort()) {
                return;
              }
              for (const group of nextChunkGroups) {
                if (shouldAbort()) {
                  return;
                }
                await appendCloudSegments(group.segments, "demeter_sante", metadata);
              }
              logger.debug("[cloud][demeter] backend chunk appended", {
                operationId: responseSnapshot.operationId,
                status: responseSnapshot.status,
                stage: responseSnapshot.stage,
                chunkIndex,
                chunkCount,
                appendedChunkCount: nextChunkGroups.length,
                appendedSegmentCount,
                totalChunks: chunkBatch.groups.length,
              });
            });
        },
      });
    };

    try {
      logger.info("[cloud][demeter] backend direct route selected", {
        runId,
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        durationSec: sourceDurationSec,
        thresholdSec: CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC,
      });
      telemetry.logEvent("LOG_INFO", {
        context: "cloud_demeter_backend_direct",
        provider: "demeter_sante",
        runId,
        fileName: sourceFile.name,
        mimeType: sourceFile.type || "application/octet-stream",
        sizeBytes: sourceFile.size,
        durationSec: sourceDurationSec,
        thresholdSec: CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC,
      });

      setCloudStatus("uploading", "Envoi direct au backend Demeter");
      setCloudTranscriptionSession({
        progress: 0.5,
        preparedUpload: {
          provider: "demeter_sante",
          fileName: sourceFile.name,
          mimeType: sourceFile.type || "application/octet-stream",
          sizeBytes: sourceFile.size,
          chunkIndex: 0,
          totalChunks: 0,
        },
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

      await backendDirectAppendQueueRef.current;

      const chunkBatch = buildDemeterBackendChunkBatch(output as DemeterTranscriptionResponse, {
        fallbackChunkId: "demeter-backend-direct",
        includeWordTimestamps: settings.cloudEnableWordTimestamps,
        startSegmentIndex: nextDemeterSegmentIndex,
      });
      nextDemeterSegmentIndex = chunkBatch.nextSegmentIndex;
      const chunkGroups = chunkBatch.groups;
      const nextChunkGroups = chunkGroups.filter((group) => {
        const normalizedChunkId = normalizeChunkId(group.chunkId);
        if (!normalizedChunkId) {
          return false;
        }
        if (backendDirectSeenChunkIdsRef.current.has(normalizedChunkId)) {
          return false;
        }
        backendDirectSeenChunkIdsRef.current.add(normalizedChunkId);
        return true;
      });
      for (const group of nextChunkGroups) {
        await appendCloudSegments(group.segments, "demeter_sante", metadata);
      }

      for (const [groupIndex, group] of chunkGroups.entries()) {
        const summary = summarizeSegments(group.segments);
        telemetry.logEvent("CLOUD_SEGMENTS_READY", {
          provider: "demeter_sante",
          routeMode: "backend_direct",
          segmentIndex: groupIndex,
          totalSegments: chunkGroups.length,
          count: summary.count,
          totalDurationSec: summary.totalDurationSec,
          textChars: summary.textChars,
          tokenCount: summary.tokenCount,
        });
      }

      const summary = summarizeSegments(chunkGroups.flatMap((group) => group.segments));
      logger.debug("[cloud][demeter] backend direct segments ready", {
        ...summary,
        provider: "demeter_sante",
        routeMode: "backend_direct",
      });

      setCloudTranscriptionSession({ progress: 1 });
      setCloudStatus("done", "Transcription terminée");
      logger.info("[cloud][demeter] backend direct transcription done", {
        ...summary,
        provider: "demeter_sante",
        routeMode: "backend_direct",
      });
      resumeAfterVisibilityRef.current = false;
      runCompletedRef.current = true;
    } catch (error) {
      telemetry.stopTimer("cloud_transcribe");
      if (isBackendSessionExpiredError(error)) {
        throw error;
      }
      if (getCloudStopRequested() || getCloudRunId() !== runId || isAbortErrorLike(error)) {
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
      setCloudRunAbortController(null);
      backendDirectSeenChunkIdsRef.current.clear();
      backendDirectAppendQueueRef.current = Promise.resolve();
    }
  }, [
    appendCloudSegments,
    cloudDemeterDiarizationEnabled,
    cloudDemeterModel,
    consumeDemeterBackendOperationSnapshot,
    selectedFile,
    setCloudStatus,
    setCloudTranscriptionSession,
  ]);

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
    const mistralChunking = isDemeter
      ? resolveEffectiveDemeterChunking(settings.cloudDemeterChunkDurationSec, settings.cloudMistralOverlapSec)
      : resolveEffectiveMistralChunking(model, settings.cloudMistralChunkDurationSec, settings.cloudMistralOverlapSec);
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
    let sentChunkCount = 0;
    let mistralDiarizationEffective = diarizationEnabled;
    let mistralDiarizationFallbackChunks = 0;
    const shouldAbort = () => getCloudStopRequested() || getCloudRunId() !== runId;
    const sessionId = getCloudSessionId() ?? createSecureId("cloud-");
    setCloudSessionId(sessionId);
    setCloudTranscriptionSession({ sessionId });
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
          setCloudStatus("preprocessing", `Préparation locale · ${completed}/${total}`);
          setCloudTranscriptionSession({
            progress: Math.max(0, Math.min(0.5, total > 0 ? (completed / total) * 0.5 : 0)),
          });
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

      setCloudStatus("uploading", `Envoi des segments préparés · 0/${stagedSegments.length}`);
      setCloudTranscriptionSession({ progress: 0.5 });

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

        setCloudTranscriptionSession({
          preparedUpload: {
            provider: isDemeter ? "demeter_sante" : "mistral",
            fileName: uploadFile.name,
            mimeType: uploadFile.type,
            sizeBytes: uploadFile.size,
            chunkIndex: sentChunkCount + 1,
            totalChunks: stagedSegments.length,
          },
        });

        setCloudStatus("transcribing", `Transcription ${providerLabel} · ${sentChunkCount + 1}/${stagedSegments.length}`);
        setCloudTranscriptionSession({
          progress: Math.max(0, Math.min(1, 0.5 + (sentChunkCount / Math.max(1, stagedSegments.length)) * 0.5)),
        });
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
                  signal: getCloudRunAbortController()?.signal,
                  onBackendOperationProgress: (snapshot) => {
                    consumeDemeterBackendOperationSnapshot(snapshot, {
                      sourceFile: uploadFile,
                      shouldAbort,
                    });
                  },
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
                  signal: getCloudRunAbortController()?.signal,
                  onDiarizationResolved,
                },
	                telemetry
	              );
	        } catch (error) {
	          if (isBackendSessionExpiredError(error)) {
	            telemetry.stopTimer("cloud_transcribe");
	            throw error;
	          }
	          const splitSegments = splitCloudSegmentWindow(staged);
	          const rawRetryRequested = shouldRetryAudioUpload(error);
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
	              setCloudTranscriptionSession({
	                preparedUpload: {
	                  provider: isDemeter ? "demeter_sante" : "mistral",
	                  fileName: retryFile.name,
	                  mimeType: retryFile.type,
	                  sizeBytes: retryFile.size,
	                  chunkIndex: sentChunkCount + 1,
	                  totalChunks: stagedSegments.length,
	                },
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
                        signal: getCloudRunAbortController()?.signal,
                        onBackendOperationProgress: (snapshot) => {
                          consumeDemeterBackendOperationSnapshot(snapshot, {
                            sourceFile: retryFile,
                            shouldAbort,
                          });
                        },
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
	                        signal: getCloudRunAbortController()?.signal,
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
        if (isDemeter) {
          const chunkBatch = buildDemeterBackendChunkBatch(output as DemeterTranscriptionResponse, {
            fallbackChunkId: `${providerLogKey}-${chunkNumber}`,
            includeWordTimestamps: settings.cloudEnableWordTimestamps,
            startSegmentIndex: nextIndex,
          });
          nextIndex = chunkBatch.nextSegmentIndex;
          for (const group of chunkBatch.groups) {
            await appendCloudSegments(group.segments, "demeter_sante", metadata);
            allSegments.push(...group.segments);
          }
          sentChunkCount = chunkNumber;

          await deleteSegment(sessionId, staged.index);

          const summary = summarizeSegments(chunkBatch.groups.flatMap((group) => group.segments));
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
        } else {
          const chunkId = `${providerLogKey}-${chunkNumber}`;
          const parsedSegments = parseMistralOutput(output, {
            offsetSec: staged.startSec,
            startIndex: nextIndex,
            chunkId,
            fallbackDurationSec: chunkDurationSec,
            includeWordTimestamps: settings.cloudEnableWordTimestamps,
          });
          nextIndex += parsedSegments.length;
          await appendCloudSegments(parsedSegments, provider, metadata);
          allSegments.push(...parsedSegments);
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
        }

        setCloudTranscriptionSession({
          progress: Math.max(0, Math.min(1, 0.5 + (sentChunkCount / Math.max(1, stagedSegments.length)) * 0.5)),
        });
      }

      const summary = summarizeSegments(allSegments);
      logger.info(`[cloud][${providerLogKey}] all segments ready`, { ...summary, provider });
      telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { provider, segments: allSegments.length });
      setCloudTranscriptionSession({ progress: 1 });
      setCloudStatus("done", "Transcription terminée");
      resumeAfterVisibilityRef.current = false;
      runCompletedRef.current = true;
    } catch (error) {
      telemetry.stopTimer("cloud_preprocess");
      throw error;
    }
  }, [
    appendCloudSegments,
    consumeDemeterBackendOperationSnapshot,
    provider,
    mistralApiKey,
    cloudMistralDiarizationEnabled,
    cloudDemeterDiarizationEnabled,
    cloudMistralApiUrl,
    cloudMistralModel,
    cloudDemeterModel,
    persistCloudTune,
    selectedFile,
    setCloudStatus,
    setCloudTranscriptionSession,
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
    runCompletedRef.current = false;
    runExpiredRef.current = false;
    resumeAfterVisibilityRef.current = false;
    await discardCloudTranscriptCache();
    logger.info("[cloud] transcription run requested", {
      provider,
      fileName: currentFile.name,
      sizeBytes: currentFile.size,
      mimeType: currentFile.type || "application/octet-stream",
    });
    settings.clearSpeakerAssignments("cloud");
    clearSessionTranscriptMemory("cloud");
    resetCloudTranscriptBuffers();
    setCloudTranscriptionSession({
      progress: 0,
      stopRequested: false,
      preparedUpload: null,
      isTranscribing: false,
      isResettingSession: false,
    });
    setCloudStopRequested(false);
    backendDirectSeenChunkIdsRef.current.clear();
    backendDirectAppendQueueRef.current = Promise.resolve();

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
      setCloudStatus("error", emptyAudioMessage);
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

    const runId = nextCloudRunId();
    setCloudStopRequested(false);
    setCloudRunAbortController(new AbortController());
    activeTranscriptProviderRef.current = provider;
    setCloudTranscriptionSession({
      isTranscribing: true,
      isResettingSession: false,
      stopRequested: false,
      progress: 0,
      preparedUpload: null,
    });
    let backendDirectRoute = false;
    try {
      const metadata = audioMetadata ?? await probeAudioMetadata(currentFile);
      if (!audioMetadata) {
        setCloudTranscriptionSession({ audioMetadata: metadata });
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

      backendDirectRoute =
        isDemeter &&
        (forceDemeterBackendDirect ||
          (Number.isFinite(metadata.durationSec) && metadata.durationSec > CLOUD_LONG_AUDIO_BACKEND_THRESHOLD_SEC));

      const backendDemeterChunking = resolveEffectiveDemeterChunking(
        settings.cloudDemeterChunkDurationSec,
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
        setCloudStatus("uploading", "Envoi direct au backend Demeter");
        setCloudTranscriptionSession({ preparedUpload: null, progress: 0.5 });
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
        setCloudStatus("preprocessing", "Préparation des segments");
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
      if (isBackendSessionExpiredError(err)) {
        runExpiredRef.current = true;
        resumeAfterVisibilityRef.current = false;
        setCloudStatus("idle", "Session expirée");
        setCloudTranscriptionSession({ progress: 0 });
        return;
      }
      const unauthorized = isBackendUnauthorizedError(err);
      const forbidden = isBackendForbiddenError(err);
      if (unauthorized) {
        logger.info("[cloud] unauthorized, attempting refresh before final error handling");
        const refreshResult = await backendRefresh();
        if (refreshResult === "expired") {
          runExpiredRef.current = true;
          resumeAfterVisibilityRef.current = false;
          setCloudStatus("idle", "Session expirée");
          setCloudTranscriptionSession({ progress: 0 });
          return;
        }
        if (refreshResult === "failed") {
          logger.debug("[cloud] refresh request failed");
        }
      }
      const message = unauthorized || forbidden ? formatBackendErrorMessage(err) : (err as Error)?.message ?? "Erreur inconnue";
      if (getCloudStopRequested() || getCloudRunId() !== runId || isAbortErrorLike(err)) {
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
      setCloudStatus("error", message);
      toast(`Échec de la transcription cloud : ${message}`);
    } finally {
      telemetryRef.current?.stopTimer("cloud_total");
      const summary = telemetryRef.current?.exportSummary();
      // Preserve telemetry in the shared store so navigation does not drop it.
      setGlobalTelemetrySummary(summary ?? null);
      if (summary) {
        if (!runExpiredRef.current) {
          trackBackendPerformanceSummary(summary, {
            status: runCompletedRef.current ? "success" : "error",
            route: "/cloudupload",
            meta: {
              provider,
              runCompleted: runCompletedRef.current,
              stopRequested: getCloudStopRequested(),
              backendDirectRoute,
              durationSec: audioMetadata?.durationSec ?? null,
            },
          });
        }
      }
      registerTelemetry(null);
      telemetryRef.current = null;
      cloudTranscriptTextRef.current = "";
      cloudTranscriptSegmentCountRef.current = 0;
      await releaseFfmpeg();
      if (!runCompletedRef.current) {
        await discardCloudTranscriptCache();
        resetCloudTranscriptBuffers();
      }
      const wasStopRequested = getCloudStopRequested();
      const shouldResumeFromVisibility =
        resumeAfterVisibilityRef.current && !runCompletedRef.current && useAsrStore.getState().cloudStatus !== "error";
      const shouldResetAfterStop = wasStopRequested && useAsrStore.getState().cloudStatus !== "error";
      setCloudTranscriptionSession({
        preparedUpload: null,
        isTranscribing: false,
        stopRequested: false,
      });
      setCloudRunAbortController(null);
      setCloudStopRequested(false);
      if (shouldResumeFromVisibility) {
        setCloudStatus("idle", BACKGROUND_RESUME_MESSAGE);
        setCloudTranscriptionSession({ progress: 0 });
      } else if (shouldResetAfterStop) {
        setCloudStatus("idle", "Arrêté");
        setCloudTranscriptionSession({ progress: 0 });
      }
    }
  }, [
    audioMetadata,
    isResettingSession,
    forceDemeterBackendDirect,
    provider,
    registerTelemetry,
    runDemeterBackendDirectTranscription,
    runMistralTranscription,
    runWhisperTranscription,
    resolvedSettings,
    clearSessionTranscriptMemory,
    discardCloudTranscriptCache,
    resetCloudTranscriptBuffers,
    setGlobalTelemetrySummary,
    selectedFile,
    setCloudStatus,
    setCloudTranscriptionSession,
    isTranscribing,
  ]);

  useEffect(() => {
    if (visibilitySnapshot.hidden) {
      if (isTranscribing && !getCloudStopRequested() && !runCompletedRef.current) {
        resumeAfterVisibilityRef.current = true;
        setCloudStatus(useAsrStore.getState().cloudStatus, BACKGROUND_RESUME_MESSAGE);
      }
      return;
    }

    if (!resumeAfterVisibilityRef.current) {
      return;
    }

    if (isResettingSession || getCloudStopRequested() || runCompletedRef.current || !selectedFile) {
      resumeAfterVisibilityRef.current = false;
      return;
    }

    if (isTranscribing) {
      return;
    }

    resumeAfterVisibilityRef.current = false;
    void startTranscription();
  }, [
    isResettingSession,
    isTranscribing,
    selectedFile,
    startTranscription,
    visibilitySnapshot.hidden,
    setCloudStatus,
  ]);

  return {
    selectedFile,
    previewUrl,
    audioMetadata,
    chunkSummaries,
    chunkGroups: chunkSummaries,
    telemetrySummary,
    status: cloudStatus,
    statusDetail: cloudStatusDetail,
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
    loadChunkSegments,
    loadAllSegmentsForExport,
    updateSegmentText,
    updateSegmentSpeaker,
    applyChunkSpeakerAssignments,
  };
}

function resolveCloudActivitySourceMode(provider: "whisper" | "mistral" | "demeter_sante"): "cloud_direct" | "cloud_backend" {
  return provider === "demeter_sante" ? "cloud_backend" : "cloud_direct";
}

type DemeterBackendChunkGroup = {
  chunkId: string;
  segments: TranscriptionSegment[];
};

type DemeterBackendChunkBatch = {
  groups: DemeterBackendChunkGroup[];
  nextSegmentIndex: number;
};

function buildDemeterBackendFallbackChunkId(fallbackChunkId: string, chunkIndex: number): string {
  const normalizedFallback = normalizeChunkId(fallbackChunkId) ?? "demeter-backend-direct";
  return `${normalizedFallback}::chunk-${Math.max(0, Math.trunc(chunkIndex))}`;
}

function resolveDemeterBackendChunkDuration(
  chunk: DemeterTranscriptionChunk,
  response: DemeterTranscriptionResponse | null | undefined
): number {
  const explicitDuration = toFiniteNumber(chunk.durationSec ?? chunk.duration_sec);
  if (typeof explicitDuration === "number") {
    return Math.max(0, explicitDuration);
  }

  const startSec = toFiniteNumber(chunk.startSec ?? chunk.start_sec);
  const endSec = toFiniteNumber(chunk.endSec ?? chunk.end_sec);
  if (typeof startSec === "number" && typeof endSec === "number") {
    return Math.max(0, endSec - startSec);
  }

  const totalDuration = toFiniteNumber(response?.duration);
  return typeof totalDuration === "number" ? Math.max(0, totalDuration) : 0;
}

function buildDemeterBackendWordSegments(rawWords: unknown): WordSegment[] | undefined {
  if (!Array.isArray(rawWords)) {
    return undefined;
  }

  const words: WordSegment[] = [];
  for (const rawWord of rawWords) {
    if (!rawWord || typeof rawWord !== "object") {
      continue;
    }

    const text =
      normalizeChunkText((rawWord as { word?: unknown }).word) ??
      normalizeChunkText((rawWord as { text?: unknown }).text);
    if (!text) {
      continue;
    }

    const start = toFiniteNumber((rawWord as { start?: unknown }).start) ?? 0;
    const end = toFiniteNumber((rawWord as { end?: unknown }).end) ?? start;
    const confidence = toFiniteNumber((rawWord as { confidence?: unknown }).confidence) ?? undefined;

    words.push({
      word: text,
      start: Math.max(0, start),
      end: Math.max(0, Math.max(start, end)),
      confidence,
    });
  }

  return words.length ? words : undefined;
}

function buildDemeterBackendChunkSegments(
  chunk: DemeterTranscriptionChunk,
  response: DemeterTranscriptionResponse | null | undefined,
  options: {
    fallbackChunkId: string;
    includeWordTimestamps: boolean;
    startSegmentIndex: number;
    chunkIndex: number;
  }
): TranscriptionSegment[] {
  const rawSegments = Array.isArray(chunk.segments) ? chunk.segments : [];
  const chunkId =
    normalizeChunkId(chunk.chunkId ?? chunk.chunk_id) ?? buildDemeterBackendFallbackChunkId(options.fallbackChunkId, options.chunkIndex);
  const segments: TranscriptionSegment[] = [];
  let nextIndex = options.startSegmentIndex;

  for (const rawSegment of rawSegments) {
    if (!rawSegment || typeof rawSegment !== "object") {
      continue;
    }

    const segment = rawSegment as DemeterTranscriptionChunkSegment;
    const text = normalizeChunkText(segment.text);
    if (!text) {
      continue;
    }

    const start = toFiniteNumber(segment.start) ?? toFiniteNumber(chunk.startSec ?? chunk.start_sec) ?? 0;
    const fallbackEndSec =
      toFiniteNumber(segment.end) ??
      toFiniteNumber(chunk.endSec ?? chunk.end_sec) ??
      resolveDemeterBackendChunkDuration(chunk, response);
    const confidence = toFiniteNumber(segment.confidence) ?? undefined;
    const speaker = normalizeChunkText(segment.speaker) ?? normalizeChunkText(segment.speaker_id);
    const words = options.includeWordTimestamps ? buildDemeterBackendWordSegments(segment.words) : undefined;

    segments.push({
      index: nextIndex,
      start: Math.max(0, start),
      end: Math.max(0, Math.max(start, fallbackEndSec)),
      text,
      speaker,
      chunkId: normalizeChunkId(segment.chunkId ?? segment.chunk_id) ?? chunkId,
      strategy: "chunks",
      confidence,
      confidenceSource: typeof confidence === "number" ? "model" : undefined,
      words,
    });
    nextIndex += 1;
  }

  if (!segments.length) {
    const fallbackText = normalizeChunkText(chunk.text);
    if (fallbackText) {
      const start = toFiniteNumber(chunk.startSec ?? chunk.start_sec) ?? 0;
      const end =
        toFiniteNumber(chunk.endSec ?? chunk.end_sec) ??
        Math.max(start, resolveDemeterBackendChunkDuration(chunk, response));

      segments.push({
        index: nextIndex,
        start: Math.max(0, start),
        end: Math.max(0, Math.max(start, end)),
        text: fallbackText,
        chunkId,
        strategy: "chunks",
      });
    }
  }

  return segments;
}

function buildDemeterBackendChunkBatch(
  response: DemeterTranscriptionResponse | null | undefined,
  options: {
    fallbackChunkId: string;
    includeWordTimestamps: boolean;
    startSegmentIndex: number;
  }
): DemeterBackendChunkBatch {
  const rawChunks = Array.isArray(response?.chunks) ? response?.chunks : [];
  if (!rawChunks.length) {
    const fallbackText = normalizeChunkText(response?.text);
    if (fallbackText) {
      const chunkId = normalizeChunkId(options.fallbackChunkId) ?? "demeter-backend-direct";
      const duration = toFiniteNumber(response?.duration) ?? 0;
      const words = options.includeWordTimestamps ? buildDemeterBackendWordSegments(response?.words) : undefined;
      return {
        groups: [
          {
            chunkId,
            segments: [
              {
                index: options.startSegmentIndex,
                start: 0,
                end: Math.max(0, duration),
                text: fallbackText,
                chunkId,
                strategy: "chunks",
                words,
              },
            ],
          },
        ],
        nextSegmentIndex: options.startSegmentIndex + 1,
      };
    }

    return {
      groups: [],
      nextSegmentIndex: options.startSegmentIndex,
    };
  }

  const groups: DemeterBackendChunkGroup[] = [];
  let nextSegmentIndex = options.startSegmentIndex;

  for (const [position, rawChunk] of rawChunks.entries()) {
    if (!rawChunk || typeof rawChunk !== "object") {
      continue;
    }

    const chunk = rawChunk as DemeterTranscriptionChunk;
    const chunkIndex = toFiniteInteger(chunk.index) ?? position;
    const chunkId =
      normalizeChunkId(chunk.chunkId ?? chunk.chunk_id) ?? buildDemeterBackendFallbackChunkId(options.fallbackChunkId, chunkIndex);
    const parsedSegments = buildDemeterBackendChunkSegments(chunk, response, {
      fallbackChunkId: options.fallbackChunkId,
      includeWordTimestamps: options.includeWordTimestamps,
      startSegmentIndex: nextSegmentIndex,
      chunkIndex,
    });
    nextSegmentIndex += parsedSegments.length;
    groups.push({
      chunkId,
      segments: parsedSegments,
    });
  }

  return {
    groups,
    nextSegmentIndex,
  };
}

function normalizeChunkId(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : undefined;
}

function normalizeChunkText(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized : undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toFiniteInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.trunc(value);
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

function resolveEffectiveDemeterChunking(
  requestedDurationSec: number,
  requestedOverlapSec: number
): MistralChunkingConfig {
  const requestedDuration = Math.max(5, Math.round(requestedDurationSec || 0));
  const effectiveDurationSec = clampDemeterChunkDurationSec(requestedDurationSec || DEMETER_CHUNK_DURATION_DEFAULT_SEC);
  const requestedOverlap = Math.max(0, Math.round(requestedOverlapSec || 0));
  return {
    requestedDurationSec: requestedDuration,
    effectiveDurationSec,
    effectiveOverlapSec: Math.min(requestedOverlap, Math.max(0, effectiveDurationSec - 1)),
    modelMaxDurationSec: DEMETER_CHUNK_DURATION_MAX_SEC,
    durationWasCapped: effectiveDurationSec < requestedDuration,
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

function groupCloudSegmentsByChunkId(segments: readonly TranscriptionSegment[]): Array<{
  chunkId: string;
  segments: TranscriptionSegment[];
}> {
  const groups = new Map<string, TranscriptionSegment[]>();

  for (const segment of segments) {
    const chunkId = segment.chunkId?.trim() || `__chunk-${segment.index}`;
    const bucket = groups.get(chunkId);
    if (bucket) {
      bucket.push(segment);
    } else {
      groups.set(chunkId, [segment]);
    }
  }

  return [...groups.entries()].map(([chunkId, groupedSegments]) => ({
    chunkId,
    segments: groupedSegments,
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
