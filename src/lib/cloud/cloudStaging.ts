import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
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

    await putSegment({
      key: `${sessionId}:${stageIndex}`,
      sessionId,
      index: stageIndex,
      startSec: segment.startSec,
      endSec: segment.endSec,
      blob: preprocessResult.uploadFile,
      name: preprocessResult.uploadFile.name,
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
