import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { probeAudioMetadata } from "@/lib/audio";
import { extractSegmentBlob } from "@/lib/cloud/segmentExtraction";
import { preprocessCloudAudio, type CloudAutoTuneResult, type CloudPreprocessSettings } from "@/lib/cloud/preprocessCloudAudio";
import { putSegment } from "@/lib/segment-cache";
import { splitCloudSegmentWindow, type CloudSegmentWindow } from "@/lib/cloud/segmentWindows";

export type CloudStagedSegment = CloudSegmentWindow & {
  index: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
};

export type StageCloudSegmentsOptions = {
  sessionId: string;
  sourceFile: File;
  provider: "whisper" | "mistral" | "demeter_sante";
  segments: CloudSegmentWindow[];
  preprocessSettings: CloudPreprocessSettings;
  telemetry?: TelemetryCollector;
  maxUploadBytes?: number;
  startIndex?: number;
  shouldAbort?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
};

export type StageCloudSegmentsResult = {
  stagedSegments: CloudStagedSegment[];
  nextIndex: number;
  tune?: CloudAutoTuneResult;
  aborted: boolean;
};

const CLOUD_SEGMENT_ALLOWED_FORMATS = new Set(["wav", "webm", "ogg", "mp3", "mp4", "aac"]);

function applyTuneToSettings(settings: CloudPreprocessSettings, tune: CloudAutoTuneResult) {
  settings.denoiseNoiseFloorDb = tune.noiseFloorDb;
  settings.denoiseReductionDb = tune.reductionDb;
  settings.denoiseSmoothing = tune.smoothing;
  settings.preprocessTargetLufs = tune.targetLufs;
  settings.preprocessHighpassHz = tune.highpassHz;
  settings.preprocessLowpassHz = tune.lowpassHz;
  settings.preprocessLimiterThresholdDb = tune.limiterThresholdDb;
  settings.preprocessLimiterSoftness = tune.limiterSoftness;
  settings.preprocessVadThresholdDb = tune.vadThresholdDb;
  settings.preprocessOverlapBlockSec = tune.overlapBlockSec;
  settings.preprocessOverlapSec = tune.overlapSec;
}

export async function stageCloudSegments(options: StageCloudSegmentsOptions): Promise<StageCloudSegmentsResult> {
  const {
    sessionId,
    sourceFile,
    provider,
    segments,
    preprocessSettings,
    telemetry,
    maxUploadBytes,
    startIndex = 0,
    shouldAbort,
    onProgress,
  } = options;

  const queue = segments.map((segment) => ({ ...segment }));
  const stagedSegments: CloudStagedSegment[] = [];
  let nextIndex = startIndex;
  let autoTuneApplied = false;
  let tune: CloudAutoTuneResult | undefined;

  logger.debug("[cloud][staging] start", {
    provider,
    sessionId,
    segments: queue.length,
    startIndex,
    maxUploadBytes,
  });

  while (queue.length > 0) {
    if (shouldAbort?.()) {
      logger.info("[cloud][staging] aborted", {
        provider,
        sessionId,
        completed: stagedSegments.length,
        remaining: queue.length,
      });
      return { stagedSegments, nextIndex, tune, aborted: true };
    }

    const segment = queue.shift()!;
    const stageIndex = nextIndex;
    const label = `${stagedSegments.length + 1}/${Math.max(stagedSegments.length + queue.length + 1, 1)}`;

    logger.debug("[cloud][staging] segment start", {
      provider,
      sessionId,
      index: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
      label,
    });
    telemetry?.logEvent("LOG_DEBUG", {
      provider,
      context: "cloud_stage_start",
      segmentIndex: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
    });

    const extracted = await extractSegmentBlob(
      sourceFile,
      { index: stageIndex, startSec: segment.startSec, endSec: segment.endSec },
      telemetry
    );
    if (shouldAbort?.()) {
      logger.info("[cloud][staging] aborted after extract", {
        provider,
        sessionId,
        index: stageIndex,
      });
      return { stagedSegments, nextIndex, tune, aborted: true };
    }

    const segmentFile = new File([extracted.blob], extracted.name, {
      type: extracted.mimeType,
      lastModified: Date.now(),
    });

    const shouldAutoTune = preprocessSettings.autoTunePreprocess && !autoTuneApplied;
    preprocessSettings.autoTunePreprocess = shouldAutoTune;

    const preprocessResult = await preprocessCloudAudio(segmentFile, preprocessSettings, telemetry);
    if (shouldAbort?.()) {
      logger.info("[cloud][staging] aborted after preprocess", {
        provider,
        sessionId,
        index: stageIndex,
      });
      return { stagedSegments, nextIndex, tune, aborted: true };
    }

    if (preprocessResult.noiseProfile && !preprocessSettings.noiseProfile) {
      preprocessSettings.noiseProfile = preprocessResult.noiseProfile;
    } else if (!preprocessSettings.noiseProfile) {
      preprocessSettings.noiseProfile = new Float32Array(0);
    }

    if (shouldAutoTune) {
      autoTuneApplied = true;
      preprocessSettings.autoTunePreprocess = false;
      if (preprocessResult.tune) {
        tune = preprocessResult.tune;
        applyTuneToSettings(preprocessSettings, preprocessResult.tune);
      }
    }

    if (maxUploadBytes && preprocessResult.uploadFile.size > maxUploadBytes) {
      const splitSegments = splitCloudSegmentWindow(segment);
      if (!splitSegments) {
        const message = `Chunk ${provider} trop volumineux (${preprocessResult.uploadFile.size} bytes) et impossible de découper davantage.`;
        telemetry?.recordAlert("CLOUD_STAGE_FILE_TOO_LARGE", {
          provider,
          index: stageIndex,
          sizeBytes: preprocessResult.uploadFile.size,
          maxUploadBytes,
        });
        throw new Error(message);
      }
      logger.warn("[cloud][staging] chunk exceeds size limit, splitting before upload", {
        provider,
        sessionId,
        index: stageIndex,
        startSec: segment.startSec,
        endSec: segment.endSec,
        sizeBytes: preprocessResult.uploadFile.size,
        maxUploadBytes,
      });
      telemetry?.logEvent("LOG_WARN", {
        context: "cloud_stage_chunk_split_size",
        provider,
        index: stageIndex,
        startSec: segment.startSec,
        endSec: segment.endSec,
        sizeBytes: preprocessResult.uploadFile.size,
        maxUploadBytes,
      });
      queue.unshift(splitSegments[1]);
      queue.unshift(splitSegments[0]);
      continue;
    }

    await validateCloudSegmentUploadFile({
      file: preprocessResult.uploadFile,
      provider,
      sessionId,
      index: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
      telemetry,
    });

    await putSegment({
      key: `${sessionId}:${stageIndex}`,
      sessionId,
      index: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
      blob: preprocessResult.uploadFile,
      name: preprocessResult.uploadFile.name,
      rawBlob: extracted.blob,
      rawName: extracted.name,
      rawMimeType: extracted.mimeType,
    });

    stagedSegments.push({
      index: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
      fileName: preprocessResult.uploadFile.name,
      mimeType: preprocessResult.uploadFile.type || "audio/wav",
      sizeBytes: preprocessResult.uploadFile.size,
    });
    nextIndex += 1;
    onProgress?.(stagedSegments.length, Math.max(stagedSegments.length + queue.length, stagedSegments.length));

    telemetry?.logEvent("LOG_DEBUG", {
      provider,
      context: "cloud_stage_done",
      segmentIndex: stageIndex,
      fileName: preprocessResult.uploadFile.name,
      sizeBytes: preprocessResult.uploadFile.size,
      applied: preprocessResult.applied,
    });
  }

  logger.debug("[cloud][staging] done", {
    provider,
    sessionId,
    stagedSegments: stagedSegments.length,
    aborted: false,
  });
  return { stagedSegments, nextIndex, tune, aborted: false };
}

function normalizeAudioMimeType(rawMimeType: string): string {
  const normalized = rawMimeType.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  return normalized.split(";", 1)[0]?.trim() ?? "";
}

function resolveAudioFormat(file: File): string {
  const mimeType = normalizeAudioMimeType(file.type);
  const extension = resolveFileExtension(file.name);

  switch (true) {
    case mimeType === "audio/wav":
    case mimeType === "audio/x-wav":
    case extension === "wav":
    case extension === "wave":
    case extension === "x-wav":
      return "wav";
    case mimeType === "audio/webm":
    case extension === "webm":
      return "webm";
    case mimeType === "audio/ogg":
    case extension === "ogg":
    case extension === "oga":
      return "ogg";
    case mimeType === "audio/mpeg":
    case mimeType === "audio/mp3":
    case extension === "mp3":
      return "mp3";
    case mimeType === "audio/mp4":
    case mimeType === "audio/x-m4a":
    case extension === "m4a":
    case extension === "mp4":
      return "mp4";
    case mimeType === "audio/aac":
    case extension === "aac":
      return "aac";
    default:
      return "";
  }
}

function resolveFileExtension(fileName: string): string {
  const normalized = fileName.trim();
  if (!normalized) {
    return "";
  }
  const dotIndex = normalized.lastIndexOf(".");
  if (dotIndex < 0 || dotIndex === normalized.length - 1) {
    return "";
  }
  return normalized.slice(dotIndex + 1).toLowerCase();
}

function isCompatibleExtensionForFormat(format: string, extension: string): boolean {
  switch (format) {
    case "wav":
      return extension === "wav" || extension === "wave" || extension === "x-wav";
    case "webm":
      return extension === "webm";
    case "ogg":
      return extension === "ogg" || extension === "oga";
    case "mp3":
      return extension === "mp3";
    case "mp4":
      return extension === "m4a" || extension === "mp4";
    case "aac":
      return extension === "aac";
    default:
      return false;
  }
}

async function validateCloudSegmentUploadFile(args: {
  file: File;
  provider: StageCloudSegmentsOptions["provider"];
  sessionId: string;
  index: number;
  startSec: number;
  endSec: number;
  telemetry?: TelemetryCollector;
}): Promise<void> {
  const { file, provider, sessionId, index, startSec, endSec, telemetry } = args;
  const audioFormat = resolveAudioFormat(file);
  const normalizedMimeType = normalizeAudioMimeType(file.type) || "application/octet-stream";
  const fileExtension = resolveFileExtension(file.name);
  if (file.size <= 0) {
    const message = `Segment audio vide avant envoi (${provider} #${index})`;
    logger.warn("[cloud][staging] invalid segment before upload", {
      provider,
      sessionId,
      index,
      reason: "empty",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    telemetry?.recordAlert("CLOUD_STAGE_SEGMENT_INVALID", {
      provider,
      sessionId,
      segmentIndex: index,
      reason: "empty",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    throw new Error(message);
  }

  if (!audioFormat) {
    const message = `Segment audio de format non supporté (${file.name || "segment"} / ${normalizedMimeType})`;
    logger.warn("[cloud][staging] invalid segment before upload", {
      provider,
      sessionId,
      index,
      reason: "unsupported_format",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    telemetry?.recordAlert("CLOUD_STAGE_SEGMENT_INVALID", {
      provider,
      sessionId,
      segmentIndex: index,
      reason: "unsupported_format",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    throw new Error(message);
  }

  if (!CLOUD_SEGMENT_ALLOWED_FORMATS.has(audioFormat)) {
    const message = `Segment audio de format non supporté (${file.name || "segment"} / ${audioFormat})`;
    logger.warn("[cloud][staging] invalid segment before upload", {
      provider,
      sessionId,
      index,
      reason: "unsupported_format",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    telemetry?.recordAlert("CLOUD_STAGE_SEGMENT_INVALID", {
      provider,
      sessionId,
      segmentIndex: index,
      reason: "unsupported_format",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
    });
    throw new Error(message);
  }

  if (fileExtension && !isCompatibleExtensionForFormat(audioFormat, fileExtension)) {
    logger.warn("[cloud][staging] segment format mismatch", {
      provider,
      sessionId,
      index,
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      expectedFormat: audioFormat,
      fileExtension,
      startSec,
      endSec,
    });
    telemetry?.logEvent("LOG_WARN", {
      provider,
      context: "cloud_stage_segment_format_mismatch",
      sessionId,
      segmentIndex: index,
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      expectedFormat: audioFormat,
      fileExtension,
      startSec,
      endSec,
    });
  }

  const metadata = await probeAudioMetadata(file);
  const durationSec = Number.isFinite(metadata.durationSec) ? Math.max(0, metadata.durationSec) : 0;
  if (!(durationSec > 0)) {
    const message = `Segment audio illisible avant envoi (${file.name || "segment"})`;
    logger.warn("[cloud][staging] invalid segment before upload", {
      provider,
      sessionId,
      index,
      reason: "unreadable",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
      durationSec: metadata.durationSec,
    });
    telemetry?.recordAlert("CLOUD_STAGE_SEGMENT_INVALID", {
      provider,
      sessionId,
      segmentIndex: index,
      reason: "unreadable",
      fileName: file.name,
      mimeType: normalizedMimeType,
      sizeBytes: file.size,
      startSec,
      endSec,
      durationSec: metadata.durationSec,
    });
    throw new Error(message);
  }
}
