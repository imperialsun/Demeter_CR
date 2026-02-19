import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAsrStore } from "@/store/asr-store";
import { TelemetryCollector, type TelemetrySummary } from "@/lib/telemetry";
import { encodeWavBuffer, probeAudioMetadata, type AudioMetadata } from "@/lib/audio";
import { buildFixedSegments } from "@/lib/chunking";
import { preprocessCloudAudio, type CloudPreprocessSettings } from "@/lib/cloud/preprocessCloudAudio";
import { parseSrtToSegments } from "@/lib/cloud/parseSrt";
import logger from "@/lib/logger";
import { toast } from "@/components/ui/use-toast";
import { getGradioClient } from "@/lib/cloud/gradioClient";
import type { TranscriptionSegment } from "@/lib/export";
import { buildCloudContext } from "@/lib/cloud/context";
import { resolveCloudSessionSettings } from "@/lib/cloud/sessionSettings";
import { makeSafeFilename, uploadCloudFile } from "@/lib/cloud/fileUpload";
import { normalizeFileData } from "@/lib/cloud/fileData";
import { summarizeSegments } from "@/lib/cloud/segmentSummary";
import { buildBatchPlan, DEFAULT_BATCH_DURATION_SEC } from "@/lib/cloud/batchPlan";
import { extractSegmentBlob } from "@/lib/cloud/segmentExtraction";
import { submitWithProgress } from "@/lib/cloud/gradioSubmit";
import { offsetSegments } from "@/lib/cloud/segmentOffsets";
import { getWhisperClient } from "@/lib/cloud/whisperClient";
import { buildWhisperParameters } from "@/lib/cloud/whisperParams";
import { parseWhisperOutput } from "@/lib/cloud/whisperSegments";
import { transcribeWithMistral } from "@/lib/cloud/mistralClient";
import { parseMistralOutput } from "@/lib/cloud/mistralSegments";
import {
  describeCloudError,
  extractSrtText,
  resolveChunkingConfig,
} from "@/hooks/useCloudTranscription.steps";

type CloudStatus = "idle" | "preprocessing" | "uploading" | "transcribing" | "stopping" | "done" | "error";

type PreviewPayload = {
  audioPrev: unknown | null;
  videoPrev: unknown | null;
};

const TRANSCRIBE_PROGRESS_BASE = 0.6;
const TRANSCRIBE_PROGRESS_SPAN = 1 - TRANSCRIBE_PROGRESS_BASE;
const PROGRESS_FALLBACK_DELAY_MS = 2000;
const PROGRESS_FALLBACK_INTERVAL_MS = 1500;

export function useCloudTranscription(provider: "gradio" | "whisper" | "mistral") {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewFile, setPreviewFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [audioMetadata, setAudioMetadata] = useState<AudioMetadata | null>(null);
  const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
  const [telemetrySummary, setTelemetrySummary] = useState<TelemetrySummary | null>(null);
  const [status, setStatus] = useState<CloudStatus>("idle");
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [sessionContext, setSessionContext] = useState("");
  const [sessionApiUrl, setSessionApiUrl] = useState<string | null>(null);
  const [sessionMaxTokens, setSessionMaxTokens] = useState<number | null>(null);
  const [sessionTemperature, setSessionTemperature] = useState<number | null>(null);
  const [sessionTopP, setSessionTopP] = useState<number | null>(null);
  const [sessionDoSample, setSessionDoSample] = useState<boolean | null>(null);

  const runIdRef = useRef(0);
  const runApiUrlRef = useRef<string | null>(null);
  const isTranscribingRef = useRef(false);
  const stopRequestedRef = useRef(false);
  const telemetryRef = useRef<TelemetryCollector | null>(null);
  const previewRef = useRef<PreviewPayload>({ audioPrev: null, videoPrev: null });
  const progressFallbackRef = useRef<{ timeout: number | null; timer: number | null; value: number }>({
    timeout: null,
    timer: null,
    value: 0,
  });

  const cloudApiUrl = useAsrStore((s) => s.cloudApiUrl);
  const hfApiToken = useAsrStore((s) => s.hfApiToken);
  const cloudMistralApiUrl = useAsrStore((s) => s.cloudMistralApiUrl);
  const mistralApiKey = useAsrStore((s) => s.mistralApiKey);
  const cloudMistralModel = useAsrStore((s) => s.cloudMistralModel);
  const cloudMistralDiarizationEnabled = useAsrStore((s) => s.cloudMistralDiarizationEnabled);
  const cloudMaxTokens = useAsrStore((s) => s.cloudMaxTokens);
  const cloudTemperature = useAsrStore((s) => s.cloudTemperature);
  const cloudTopP = useAsrStore((s) => s.cloudTopP);
  const cloudDoSample = useAsrStore((s) => s.cloudDoSample);
  const cloudContextPreset = useAsrStore((s) => s.cloudContextPreset);
  const registerTelemetry = useAsrStore((s) => s.registerTelemetry);
  const setGlobalTelemetrySummary = useAsrStore((s) => s.setTelemetrySummary);
  const combinedContext = useMemo(() => {
    return buildCloudContext(cloudContextPreset ?? "", sessionContext);
  }, [cloudContextPreset, sessionContext]);
  const resolvedSettings = useMemo(() => {
    return resolveCloudSessionSettings(
      {
        apiUrl: cloudApiUrl,
        maxTokens: cloudMaxTokens,
        temperature: cloudTemperature,
        topP: cloudTopP,
        doSample: cloudDoSample,
      },
      {
        apiUrl: sessionApiUrl,
        maxTokens: sessionMaxTokens,
        temperature: sessionTemperature,
        topP: sessionTopP,
        doSample: sessionDoSample,
      }
    );
  }, [
    cloudApiUrl,
    cloudMaxTokens,
    cloudTemperature,
    cloudTopP,
    cloudDoSample,
    sessionApiUrl,
    sessionMaxTokens,
    sessionTemperature,
    sessionTopP,
    sessionDoSample,
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

  const clearProgressFallbackTimers = useCallback(() => {
    if (progressFallbackRef.current.timeout) {
      clearTimeout(progressFallbackRef.current.timeout);
      progressFallbackRef.current.timeout = null;
    }
    if (progressFallbackRef.current.timer) {
      clearInterval(progressFallbackRef.current.timer);
      progressFallbackRef.current.timer = null;
    }
    progressFallbackRef.current.value = 0;
  }, []);

  const clearCloudSessionState = useCallback(
    (detail = "Session réinitialisée") => {
      if (previewUrl) {
        try {
          URL.revokeObjectURL(previewUrl);
        } catch (err) {
          void err;
        }
      }
      clearProgressFallbackTimers();
      runApiUrlRef.current = null;
      stopRequestedRef.current = false;
      previewRef.current = { audioPrev: null, videoPrev: null };
      telemetryRef.current = null;
      setSelectedFile(null);
      setPreviewFile(null);
      setPreviewUrl(null);
      setAudioMetadata(null);
      setSegments([]);
      setTelemetrySummary(null);
      setGlobalTelemetrySummary(null);
      registerTelemetry(null);
      setStatus("idle");
      setStatusDetail(detail);
      setProgress(0);
      setIsTranscribing(false);
      setStopRequested(false);
      setSessionContext("");
      setSessionApiUrl(null);
      setSessionMaxTokens(null);
      setSessionTemperature(null);
      setSessionTopP(null);
      setSessionDoSample(null);
    },
    [clearProgressFallbackTimers, previewUrl, registerTelemetry, setGlobalTelemetrySummary]
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

    const url = runApiUrlRef.current ?? resolvedSettings.apiUrl;
    if (provider === "gradio" && url) {
      try {
        const client = await getGradioClient(url);
        await client.predict("/set_stop_flag", {});
      } catch (err) {
        logger.warn("[cloud] forced stop flag failed during reset", {
          message: (err as Error)?.message ?? String(err),
        });
      }
    }

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
  }, [provider, resolvedSettings.apiUrl]);

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
    setGlobalTelemetrySummary(null);
    registerTelemetry(null);
    setStatus("idle");
    setStatusDetail("Fichier chargé, prêt à lancer");
    setProgress(0);
    setStopRequested(false);
    previewRef.current = { audioPrev: null, videoPrev: null };
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
      logger.error("[cloud] metadata probe failed", err);
      setStatus("error");
      setStatusDetail("Impossible de lire les métadonnées audio");
    }
  }, [previewUrl, registerTelemetry, setGlobalTelemetrySummary]);

  const stopTranscription = useCallback(async () => {
    if (!isTranscribing) return;
    setStopRequested(true);
    setStatus("stopping");
    setStatusDetail("Arrêt demandé");
    const url = runApiUrlRef.current ?? resolvedSettings.apiUrl;
    const telemetry = telemetryRef.current;
    telemetry?.logEvent("STOP_REQUESTED", { context: "cloud" });
    logger.warn("[cloud] stop requested", { url, provider });
    if (provider !== "gradio") {
      if (provider === "whisper") {
        telemetry?.logEvent("CLOUD_WHISPER_STOP_REQUESTED", { provider });
      }
      return;
    }
    try {
      const client = await getGradioClient(url);
      await client.predict("/set_stop_flag", {});
    } catch (err) {
      logger.error("[cloud] stop flag failed", err);
      telemetry?.recordAlert("CLOUD_STOP_FAILED", { message: (err as Error)?.message });
    }
  }, [isTranscribing, provider, resolvedSettings]);

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

    if (combinedContext.trim()) {
      logger.info("[cloud][whisper] context ignored", { length: combinedContext.length });
      telemetry.logEvent("CLOUD_WHISPER_CONTEXT_IGNORED", { length: combinedContext.length });
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
    logger.info("[cloud][whisper] plan", {
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
        logger.warn("[cloud][whisper] run aborted before segment", { runId, segmentIndex });
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
        logger.warn("[cloud][whisper] run aborted after preprocess", { runId, segmentIndex });
        return;
      }

      const wavBuffer = encodeWavBuffer(preprocessResult.processed.pcm, preprocessResult.processed.sampleRate);
      const baseName = segmentFile.name.replace(/\.[^/.]+$/, "");
      const safeBaseName = makeSafeFilename(baseName || "audio");
      const processedFile = new File([wavBuffer], `${safeBaseName}-whisper.wav`, {
        type: "audio/wav",
        lastModified: Date.now(),
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
        logger.warn("[cloud][whisper] run aborted after inference", { runId, segmentIndex });
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

      const summary = summarizeSegments(parsedSegments);
      logger.info("[cloud][whisper] segments ready", { ...summary, segmentIndex, totalSegments });
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
  }, [hfApiToken, combinedContext, resolvedSettings, selectedFile]);

  const runMistralTranscription = useCallback(async (args: {
    runId: number;
    settings: ReturnType<typeof useAsrStore.getState>;
    metadata: AudioMetadata;
    telemetry: TelemetryCollector;
    preprocessSettings: CloudPreprocessSettings;
  }) => {
    const { runId, settings, metadata, telemetry, preprocessSettings } = args;
    const apiKey = mistralApiKey.trim();
    const apiUrl = cloudMistralApiUrl.trim();
    const model = cloudMistralModel.trim() || "voxtral-mini-latest";

    if (!apiKey) {
      const message = "Token API Mistral manquant";
      telemetry.recordAlert("CLOUD_MISTRAL_TOKEN_MISSING", { message });
      throw new Error(message);
    }

    if (combinedContext.trim()) {
      logger.info("[cloud][mistral] context ignored", { length: combinedContext.length });
      telemetry.logEvent("CLOUD_WHISPER_CONTEXT_IGNORED", { provider: "mistral", length: combinedContext.length });
    }

    const sourceFile = selectedFile;
    if (!sourceFile) {
      throw new Error("Fichier audio manquant");
    }

    const { duration: segmentDurationSec, overlap: overlapSec } = resolveChunkingConfig(
      settings.cloudMistralChunkDurationSec,
      settings.cloudMistralOverlapSec
    );
    const plan = buildFixedSegments({
      durationSec: metadata.durationSec,
      segmentDurationSec,
      overlapSec,
    });
    const totalSegments = Math.max(1, plan.length);
    logger.info("[cloud][mistral] plan", {
      segments: totalSegments,
      durationSec: metadata.durationSec,
      segmentDurationSec,
      overlapSec,
      model,
    });
    telemetry.logEvent("CLOUD_MISTRAL_PLAN", {
      model,
      segmentDurationSec,
      overlapSec,
      segments: totalSegments,
      durationSec: metadata.durationSec,
    });

    const allSegments: TranscriptionSegment[] = [];
    let nextIndex = 0;
    let mistralDiarizationEffective = cloudMistralDiarizationEnabled;
    let mistralDiarizationFallbackChunks = 0;

    for (let segmentIndex = 0; segmentIndex < totalSegments; segmentIndex += 1) {
      const segment = plan[segmentIndex];
      if (!segment) continue;

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.warn("[cloud][mistral] run aborted before segment", { runId, segmentIndex });
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
        logger.warn("[cloud][mistral] run aborted after preprocess", { runId, segmentIndex });
        return;
      }

      const wavBuffer = encodeWavBuffer(preprocessResult.processed.pcm, preprocessResult.processed.sampleRate);
      const baseName = segmentFile.name.replace(/\.[^/.]+$/, "");
      const safeBaseName = makeSafeFilename(baseName || "audio");
      const processedFile = new File([wavBuffer], `${safeBaseName}-mistral.wav`, {
        type: "audio/wav",
        lastModified: Date.now(),
      });

      setStatus("transcribing");
      setStatusDetail(`Transcription Mistral${labelSuffix}`);
      setProgress(Math.max(0, Math.min(1, (segmentIndex + 0.4) / totalSegments)));
      telemetry.startTimer("cloud_transcribe");
      logger.info("[cloud][mistral] chunk start", {
        segmentIndex,
        totalSegments,
        model,
      });

      const output = await transcribeWithMistral(
        {
          apiUrl,
          apiKey,
          model,
          file: processedFile,
          diarize: cloudMistralDiarizationEnabled,
          onDiarizationResolved: ({ requestedDiarize, effectiveDiarize, fallbackApplied }) => {
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
          },
        },
        telemetry
      );

      telemetry.stopTimer("cloud_transcribe");

      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.warn("[cloud][mistral] run aborted after inference", { runId, segmentIndex });
        return;
      }

      const chunkId = `mistral-${segmentIndex + 1}`;
      const parsedSegments = parseMistralOutput(output, {
        offsetSec: segment.start,
        startIndex: nextIndex,
        chunkId,
        fallbackDurationSec: Math.max(0, segment.end - segment.start),
        includeWordTimestamps: settings.cloudEnableWordTimestamps,
      });
      nextIndex += parsedSegments.length;
      allSegments.push(...parsedSegments);
      setSegments([...allSegments]);

      const summary = summarizeSegments(parsedSegments);
      logger.info("[cloud][mistral] segments ready", { ...summary, segmentIndex, totalSegments });
      telemetry.logEvent("CLOUD_SEGMENTS_READY", {
        provider: "mistral",
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
    logger.info("[cloud][mistral] all segments ready", summary);
    telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { provider: "mistral", segments: allSegments.length });
    setProgress(1);
    setStatus("done");
    setStatusDetail("Transcription terminée");
  }, [
    mistralApiKey,
    cloudMistralDiarizationEnabled,
    cloudMistralApiUrl,
    cloudMistralModel,
    combinedContext,
    selectedFile,
  ]);

  const startTranscription = useCallback(async () => {
    const settings = useAsrStore.getState();
    const isWhisper = provider === "whisper";
    const isMistral = provider === "mistral";
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

    runApiUrlRef.current = isWhisper || isMistral ? null : resolvedSettings.apiUrl;
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
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
      logger.info("[cloud] resolved session settings", {
        provider,
        apiUrlSource: resolvedSettings.sources.apiUrl,
        maxTokensSource: resolvedSettings.sources.maxTokens,
        temperatureSource: resolvedSettings.sources.temperature,
        topPSource: resolvedSettings.sources.topP,
        doSampleSource: resolvedSettings.sources.doSample,
        apiUrlLength: resolvedSettings.apiUrl.length,
        maxTokens: resolvedSettings.maxTokens,
        temperature: resolvedSettings.temperature,
        topP: resolvedSettings.topP,
        doSample: resolvedSettings.doSample,
        contextLength: combinedContext.length,
      });
      telemetry.logEvent("CLOUD_SESSION_RESOLVED", {
        provider,
        apiUrlSource: resolvedSettings.sources.apiUrl,
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
              chunkDurationSec: settings.cloudMistralChunkDurationSec,
              overlapSec: settings.cloudMistralOverlapSec,
              includeWordTimestamps: settings.cloudEnableWordTimestamps,
              contextUsed: false,
              ...commonCloudPreprocessSettings,
            }
          : {
              provider: "gradio",
              apiUrl: resolvedSettings.apiUrl,
              maxTokens: resolvedSettings.maxTokens,
              temperature: resolvedSettings.temperature,
              topP: resolvedSettings.topP,
              doSample: resolvedSettings.doSample,
              contextUsed: Boolean(combinedContext.trim().length),
              contextLength: combinedContext.trim().length,
              contextPresetConfigured: Boolean(settings.cloudContextPreset.trim().length),
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
        return;
      }

      if (isMistral) {
        await runMistralTranscription({
          runId,
          settings,
          metadata,
          telemetry,
          preprocessSettings,
        });
        return;
      }

      const batches = buildBatchPlan(metadata.durationSec, DEFAULT_BATCH_DURATION_SEC);
      const batchCount = Math.max(1, batches.length);
      const isProgressive = batchCount > 1;
      if (isProgressive) {
        logger.info("[cloud] progressive mode enabled", {
          batches: batchCount,
          batchDurationSec: DEFAULT_BATCH_DURATION_SEC,
          durationSec: metadata.durationSec,
        });
      }

      const client = await getGradioClient(resolvedSettings.apiUrl);
      await client.predict("/reset_stop_flag", {});
      const updateOverallProgress = (batchIndex: number, batchCount: number, batchProgress: number) => {
        const clamped = Math.max(0, Math.min(1, batchProgress));
        const overall = (batchIndex + clamped) / Math.max(1, batchCount);
        setProgress((prev) => Math.max(prev, Math.min(1, overall)));
      };
      const clearProgressFallback = () => {
        if (progressFallbackRef.current.timeout) {
          clearTimeout(progressFallbackRef.current.timeout);
          progressFallbackRef.current.timeout = null;
        }
        if (progressFallbackRef.current.timer) {
          clearInterval(progressFallbackRef.current.timer);
          progressFallbackRef.current.timer = null;
        }
        progressFallbackRef.current.value = 0;
      };
      const scheduleProgressFallback = (batchIndex: number, batchCount: number) => {
        if (typeof window === "undefined") return;
        clearProgressFallback();
        progressFallbackRef.current.timeout = window.setTimeout(() => {
          logger.info("[cloud] transcribe progress fallback enabled", { batchIndex, batchCount });
          progressFallbackRef.current.timer = window.setInterval(() => {
            progressFallbackRef.current.value = Math.min(0.92, progressFallbackRef.current.value + 0.03);
            const batchProgress = TRANSCRIBE_PROGRESS_BASE + TRANSCRIBE_PROGRESS_SPAN * progressFallbackRef.current.value;
            updateOverallProgress(batchIndex, batchCount, batchProgress);
          }, PROGRESS_FALLBACK_INTERVAL_MS);
        }, PROGRESS_FALLBACK_DELAY_MS);
      };

      const allSegments: TranscriptionSegment[] = [];
      let nextIndex = 0;

      for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
        const batch = batches[batchIndex]!;
        const batchLabel = batchCount > 1 ? `Batch ${batchIndex + 1}/${batchCount}` : null;
        const labelSuffix = batchLabel ? ` · ${batchLabel}` : "";

        if (stopRequestedRef.current || runIdRef.current !== runId) {
          logger.warn("[cloud] run aborted before batch", { runId, batchIndex });
          return;
        }

        let batchFile = selectedFile;
        if (batchCount > 1) {
          setStatus("preprocessing");
          setStatusDetail(`Extraction du batch${labelSuffix}`);
          updateOverallProgress(batchIndex, batchCount, 0.05);
          const extracted = await extractSegmentBlob(
            selectedFile,
            { index: batchIndex, startSec: batch.start, endSec: batch.end },
            telemetry
          );
          batchFile = new File([extracted.blob], extracted.name, {
            type: extracted.mimeType,
            lastModified: Date.now(),
          });
        }

        setStatus("preprocessing");
        setStatusDetail(`Prétraitement local${labelSuffix}`);
        telemetry.startTimer("cloud_preprocess");
        const preprocessResult = await preprocessCloudAudio(batchFile, preprocessSettings, telemetry);
        telemetry.stopTimer("cloud_preprocess");

        if (settings.cloudAutoTunePreprocess && preprocessResult.tune && batchIndex === 0) {
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
          logger.warn("[cloud] run aborted after preprocess", { runId, batchIndex });
          return;
        }

        updateOverallProgress(batchIndex, batchCount, 0.2);
        const wavBuffer = encodeWavBuffer(preprocessResult.processed.pcm, preprocessResult.processed.sampleRate);
        const baseName = batchFile.name.replace(/\.[^/.]+$/, "");
        const safeBaseName = makeSafeFilename(baseName || "audio");
        const processedFile = new File([wavBuffer], `${safeBaseName}-cloud.wav`, {
          type: "audio/wav",
          lastModified: Date.now(),
        });
        logger.info("[cloud] prepared wav upload", {
          originalName: batchFile.name,
          uploadName: processedFile.name,
          mimeType: processedFile.type,
          sizeBytes: processedFile.size,
          batchIndex,
        });
        if (previewUrl) {
          try {
            URL.revokeObjectURL(previewUrl);
          } catch (err) {
            void err;
          }
        }
        const processedUrl = URL.createObjectURL(processedFile);
        setPreviewUrl(processedUrl);
        setPreviewFile(processedFile);

        setStatus("uploading");
        setStatusDetail(`Envoi vers le cloud${labelSuffix}`);
        updateOverallProgress(batchIndex, batchCount, 0.35);

        const uploadedFile = await uploadCloudFile({
          client,
          file: processedFile,
          rootUrl: resolvedSettings.apiUrl,
          telemetry,
        });

        try {
          telemetry.startTimer("cloud_preview");
          const previewResult = await client.predict("/update_media_preview", {
            file_path: uploadedFile,
          });
          telemetry.stopTimer("cloud_preview");
          const previewData = Array.isArray(previewResult?.data) ? previewResult.data : [];
          const audioPrev = normalizeFileData(previewData[0]);
          const videoPrev = normalizeFileData(previewData[1]);
          previewRef.current = {
            audioPrev: audioPrev ?? null,
            videoPrev: videoPrev ?? null,
          };
          if (!previewRef.current.audioPrev) {
            logger.warn("[cloud] preview audio invalid, fallback to uploaded file");
            previewRef.current.audioPrev = uploadedFile;
          }
          logger.info("[cloud] preview updated", {
            hasAudio: Boolean(previewRef.current.audioPrev),
            hasVideo: Boolean(previewRef.current.videoPrev),
            batchIndex,
          });
          telemetry.logEvent("CLOUD_PREVIEW_UPDATE", {
            hasAudio: Boolean(previewRef.current.audioPrev),
            hasVideo: Boolean(previewRef.current.videoPrev),
          });
        } catch (err) {
          const message = describeCloudError(err);
          previewRef.current = { audioPrev: null, videoPrev: null };
          telemetry.stopTimer("cloud_preview");
          telemetry.recordAlert("CLOUD_PREVIEW_FAILED", { message });
          logger.warn("[cloud] preview failed, continuing without preview", { message });
        }

        if (stopRequestedRef.current || runIdRef.current !== runId) {
          logger.warn("[cloud] run aborted after preview", { runId, batchIndex });
          return;
        }

        setStatus("transcribing");
        setStatusDetail(`Transcription cloud en cours${labelSuffix}`);
        updateOverallProgress(batchIndex, batchCount, TRANSCRIBE_PROGRESS_BASE);
        telemetry.startTimer("cloud_transcribe");
        telemetry.logEvent("CLOUD_TRANSCRIBE_START", {
          url: resolvedSettings.apiUrl,
          maxTokens: resolvedSettings.maxTokens,
          batchIndex,
          batchCount,
        });
        logger.info("[cloud] transcribe submit start", {
          endpoint: "/transcribe_wrapper",
          batchIndex,
          batchCount,
          url: resolvedSettings.apiUrl,
        });

        let progressSeen = false;
        const submitStartedAt = Date.now();
        const stallIntervalMs = 30000;
        let stallTimer: number | null = null;
        if (typeof window !== "undefined") {
          stallTimer = window.setInterval(() => {
            const elapsedMs = Date.now() - submitStartedAt;
            logger.warn("[cloud] transcribe waiting for response", {
              batchIndex,
              batchCount,
              elapsedMs,
            });
            telemetry.recordAlert("CLOUD_TRANSCRIBE_STALL", {
              batchIndex,
              batchCount,
              elapsedMs,
            });
            setStatusDetail(`Transcription cloud en cours${labelSuffix} (attente serveur)`);
          }, stallIntervalMs);
        }
        scheduleProgressFallback(batchIndex, batchCount);
        let submitResult: { data: unknown[]; progressSeen: boolean } | null = null;
        try {
          submitResult = await submitWithProgress<unknown[]>(
            client,
            "/transcribe_wrapper",
            {
              file_input: uploadedFile,
              audio_rec: null,
              video_rec: null,
              audio_prev: previewRef.current.audioPrev ?? null,
              video_prev: previewRef.current.videoPrev ?? null,
              max_tokens: resolvedSettings.maxTokens,
              temp: resolvedSettings.temperature,
              top_p: resolvedSettings.topP,
              do_sample: resolvedSettings.doSample,
              context_info: combinedContext,
            },
            {
              shouldAbort: () => stopRequestedRef.current || runIdRef.current !== runId,
              onStatus: (statusMessage) => {
                if (statusMessage.stage === "pending" && statusMessage.queue && statusMessage.position) {
                  const size = statusMessage.size ? `/${statusMessage.size}` : "";
                  setStatusDetail(`En file d'attente${labelSuffix} (${statusMessage.position}${size})`);
                }
              },
              onProgress: (update) => {
                if (typeof update.progress === "number") {
                  progressSeen = true;
                  clearProgressFallback();
                  logger.debug("[cloud] transcribe progress", {
                    batchIndex,
                    progress: update.progress,
                    desc: update.desc,
                    eta: update.eta,
                  });
                  const batchProgress = TRANSCRIBE_PROGRESS_BASE + TRANSCRIBE_PROGRESS_SPAN * update.progress;
                  updateOverallProgress(batchIndex, batchCount, batchProgress);
                  if (update.desc) {
                    setStatusDetail(`${update.desc}${labelSuffix}`);
                  }
                }
              },
            }
          );
        } finally {
          if (stallTimer && typeof window !== "undefined") {
            window.clearInterval(stallTimer);
          }
          stallTimer = null;
        }
        const { data: resultData, progressSeen: progressAvailable } = submitResult!;
        clearProgressFallback();
        if (progressAvailable && !progressSeen) {
          progressSeen = true;
        }
        if (!progressSeen) {
          logger.info("[cloud] transcribe progress not available, used fallback", { batchIndex });
        }
        telemetry.stopTimer("cloud_transcribe");
        logger.info("[cloud] transcribe submit done", {
          batchIndex,
          batchCount,
          durationMs: Date.now() - submitStartedAt,
        });

        if (stopRequestedRef.current || runIdRef.current !== runId) {
          logger.warn("[cloud] run aborted after transcribe", { runId, batchIndex });
          return;
        }

        const data = Array.isArray(resultData) ? resultData : [];
        const srtText = await extractSrtText(data[3], resolvedSettings.apiUrl);
        let parsedSegments = srtText ? parseSrtToSegments(srtText) : [];
        if (!parsedSegments.length && typeof data[0] === "string" && data[0].trim().length) {
          const durationSec = Math.max(0, batch.end - batch.start);
          parsedSegments = [
            {
              index: 0,
              start: 0,
              end: durationSec,
              text: data[0].trim(),
              chunkId: `cloud-${batchIndex}`,
              strategy: "chunks",
            },
          ];
        }

        const batchId = `cloud-batch-${batchIndex + 1}`;
        const offseted = offsetSegments(parsedSegments, batch.start, nextIndex, batchId);
        nextIndex += offseted.length;
        allSegments.push(...offseted);
        setSegments([...allSegments]);

        const summary = summarizeSegments(offseted);
        logger.info("[cloud] segments ready", { ...summary, batchIndex });
        telemetry.logEvent("CLOUD_SEGMENTS_READY", {
          count: summary.count,
          totalDurationSec: summary.totalDurationSec,
          textChars: summary.textChars,
          tokenCount: summary.tokenCount,
          batchIndex,
          batchCount,
        });

        telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { segments: offseted.length, batchIndex, batchCount });
        updateOverallProgress(batchIndex, batchCount, 1);
      }

      const summary = summarizeSegments(allSegments);
      logger.info("[cloud] all segments ready", summary);
      setProgress(1);
      setStatus("done");
      setStatusDetail("Transcription terminée");
      telemetry.logEvent("CLOUD_TRANSCRIBE_DONE", { segments: allSegments.length });
    } catch (err) {
      const message = (err as Error)?.message ?? "Erreur inconnue";
      if (stopRequestedRef.current || runIdRef.current !== runId) {
        logger.warn("[cloud] run aborted", { message });
        return;
      }
      logger.error("[cloud] transcription failed", err);
      telemetryRef.current?.logEvent("ERROR", { context: "cloud", message });
      telemetryRef.current?.recordAlert("CLOUD_TRANSCRIBE_FAILED", { message });
      setStatus("error");
      setStatusDetail(message);
      toast(`Échec de la transcription cloud : ${message}`);
    } finally {
      clearProgressFallbackTimers();
      telemetryRef.current?.stopTimer("cloud_total");
      const summary = telemetryRef.current?.exportSummary();
      setTelemetrySummary(summary ?? null);
      setGlobalTelemetrySummary(summary ?? null);
      registerTelemetry(null);
      runApiUrlRef.current = null;
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
    clearProgressFallbackTimers,
    combinedContext,
    isTranscribing,
    isResettingSession,
    provider,
    previewUrl,
    registerTelemetry,
    runMistralTranscription,
    runWhisperTranscription,
    resolvedSettings,
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
    isTranscribing,
    isResettingSession,
    stopRequested,
    sessionContext,
    setSessionContext,
    sessionApiUrl,
    sessionMaxTokens,
    sessionTemperature,
    sessionTopP,
    sessionDoSample,
    setSessionApiUrl,
    setSessionMaxTokens,
    setSessionTemperature,
    setSessionTopP,
    setSessionDoSample,
    combinedContext,
    resolvedSettings,
    handleFileSelected,
    startTranscription,
    stopTranscription,
    resetTranscriptionSession,
  };
}
