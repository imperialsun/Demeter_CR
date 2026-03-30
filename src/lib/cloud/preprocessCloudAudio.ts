import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import type { DecodedAudio } from "@/lib/audio";
import { encodeWavBuffer } from "@/lib/audio";
import { decodeCloudAudio } from "@/lib/cloud/decodeCloudAudio";
import { extractSegmentBlob } from "@/lib/cloud/segmentExtraction";
import {
  computePreprocessParams,
  estimateNoiseProfile,
  estimateNoiseProfileWithVad,
  preprocessDecodedAudio,
  preprocessPcmChunk,
} from "@/lib/preprocessing";

export type CloudPreprocessSettings = {
  preprocessingMode: "quick" | "full";
  denoiseNoiseFloorDb: number;
  denoiseReductionDb: number;
  denoiseSmoothing: number;
  denoiseCalibrationSeconds: number;
  preprocessEnableFilters: boolean;
  preprocessHighpassHz: number;
  preprocessLowpassHz: number;
  preprocessEnableLufs: boolean;
  preprocessTargetLufs: number;
  preprocessLimiterEnabled: boolean;
  preprocessLimiterThresholdDb: number;
  preprocessLimiterSoftness: number;
  preprocessVadEnabled: boolean;
  preprocessVadThresholdDb: number;
  preprocessVadMinSilenceMs: number;
  preprocessOverlapAdd: boolean;
  preprocessOverlapBlockSec: number;
  preprocessOverlapSec: number;
  autoTunePreprocess: boolean;
  noiseProfile?: Float32Array;
};

export type CloudAutoTuneResult = {
  noiseFloorDb: number;
  reductionDb: number;
  smoothing: number;
  targetLufs: number;
  highpassHz: number;
  lowpassHz: number;
  limiterThresholdDb: number;
  limiterSoftness: number;
  vadThresholdDb: number;
  overlapBlockSec: number;
  overlapSec: number;
  snrDb: number;
};

export type CloudPreprocessResult = {
  uploadFile: File;
  applied: boolean;
  tune?: CloudAutoTuneResult;
  noiseProfile?: Float32Array;
};

const EMPTY_PCM = new Float32Array(0);

function clearDecodedAudio(decoded: DecodedAudio | null | undefined) {
  if (!decoded) return;
  decoded.pcm = EMPTY_PCM;
}

function resolveCalibrationSeconds(settings: CloudPreprocessSettings, mode: "quick" | "full") {
  const value = settings.denoiseCalibrationSeconds;
  if (mode === "quick") {
    return Math.max(0.25, Math.min(value, 1));
  }
  return Math.max(0.25, value);
}

function buildNoiseProfileResult(
  pcm: Float32Array,
  sampleRate: number,
  settings: CloudPreprocessSettings,
  calibrationSeconds: number
) {
  return settings.preprocessVadEnabled
    ? estimateNoiseProfileWithVad(
        pcm,
        sampleRate,
        calibrationSeconds,
        settings.preprocessVadThresholdDb,
        settings.preprocessVadMinSilenceMs
      )
    : { ...estimateNoiseProfile(pcm, sampleRate, calibrationSeconds), vadUsed: false, silenceRanges: 0 };
}

function logNoiseProfileResult(
  telemetry: TelemetryCollector | undefined,
  result: { frames: number; vadUsed: boolean; silenceRanges: number }
) {
  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    context: "cloud",
    frames: result.frames,
    vadUsed: result.vadUsed,
    silenceRanges: result.silenceRanges,
  });
  logger.debug("[cloud][preprocess] noise profile ready", {
    frames: result.frames,
    vadUsed: result.vadUsed,
  });
}

function buildAutoTuneResult(
  decoded: DecodedAudio,
  profileResult: { profile: Float32Array },
  calibrationSeconds: number,
  telemetry?: TelemetryCollector
): CloudAutoTuneResult {
  const sampleCount = Math.max(1, Math.floor(calibrationSeconds * decoded.sampleRate));
  const tuned = computePreprocessParams(profileResult.profile, decoded.pcm.subarray(0, sampleCount));
  telemetry?.logEvent("PREPROCESS_AUTOTUNE", {
    context: "cloud",
    snrDb: tuned.snrDb,
    noiseFloorDb: tuned.noiseFloorDb,
    reductionDb: tuned.reductionDb,
    smoothing: tuned.smoothing,
    targetLufs: tuned.targetLufs,
    highpassHz: tuned.highpassHz,
    lowpassHz: tuned.lowpassHz,
    limiterThresholdDb: tuned.limiterThresholdDb,
    limiterSoftness: tuned.limiterSoftness,
    vadThresholdDb: tuned.vadThresholdDb,
    overlapBlockSec: tuned.overlapBlockSec,
    overlapSec: tuned.overlapSec,
  });
  logger.debug("[cloud][preprocess][autotune] computed", {
    noiseFloorDb: tuned.noiseFloorDb,
    reductionDb: tuned.reductionDb,
    smoothing: tuned.smoothing,
    targetLufs: tuned.targetLufs,
    highpassHz: tuned.highpassHz,
    lowpassHz: tuned.lowpassHz,
    limiterThresholdDb: tuned.limiterThresholdDb,
    limiterSoftness: tuned.limiterSoftness,
    vadThresholdDb: tuned.vadThresholdDb,
    overlapBlockSec: tuned.overlapBlockSec,
    overlapSec: tuned.overlapSec,
    snrDb: tuned.snrDb,
  });
  return tuned;
}

async function decodeQuickCalibrationAudio(
  file: File,
  settings: CloudPreprocessSettings,
  telemetry?: TelemetryCollector
): Promise<DecodedAudio> {
  const calibrationSeconds = resolveCalibrationSeconds(settings, "quick");
  const segment = await extractSegmentBlob(
    file,
    { index: 0, startSec: 0, endSec: calibrationSeconds },
    telemetry
  );
  const calibrationFile = new File([segment.blob], segment.name, {
    type: segment.mimeType,
    lastModified: Date.now(),
  });
  return await decodeCloudAudio(calibrationFile, telemetry);
}

function buildProcessedUploadFile(file: File, pcm: Float32Array, sampleRate: number): File {
  const wavBuffer = encodeWavBuffer(pcm, sampleRate);
  const wavBytes = new Uint8Array(wavBuffer);
  const baseName = file.name.replace(/\.[^/.]+$/, "") || "audio";
  const uploadFile = new File([wavBytes], `${baseName}-cloud.wav`, {
    type: "audio/wav",
    lastModified: Date.now(),
  });
  wavBytes.fill(0);
  return uploadFile;
}

export async function preprocessCloudAudio(
  file: File,
  settings: CloudPreprocessSettings,
  telemetry?: TelemetryCollector
): Promise<CloudPreprocessResult> {
  logger.debug("[cloud][preprocess] start", {
    fileName: file.name,
    mode: settings.preprocessingMode,
  });
  telemetry?.logEvent("PREPROCESS_START", { context: "cloud", mode: settings.preprocessingMode });

  let tune: CloudAutoTuneResult | undefined;
  let noiseProfile: Float32Array | undefined = settings.noiseProfile;
  if (settings.preprocessingMode !== "full") {
    const shouldCalibrate = settings.autoTunePreprocess || !noiseProfile;
    if (shouldCalibrate) {
      let calibrationAudio: DecodedAudio | null = null;
      try {
        calibrationAudio = await decodeQuickCalibrationAudio(file, settings, telemetry);
        const calibrationSeconds = resolveCalibrationSeconds(settings, "quick");
        const profileResult = buildNoiseProfileResult(
          calibrationAudio.pcm,
          calibrationAudio.sampleRate,
          settings,
          calibrationSeconds
        );
        logNoiseProfileResult(telemetry, profileResult);
        noiseProfile = profileResult.profile;
        if (settings.autoTunePreprocess) {
          tune = buildAutoTuneResult(calibrationAudio, profileResult, calibrationSeconds, telemetry);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("[cloud][preprocess][autotune] quick calibration failed", err);
        telemetry?.recordAlert("PREPROCESS_AUTOTUNE_FAILED", {
          message,
          mode: settings.preprocessingMode,
          fileName: file.name,
        });
      } finally {
        clearDecodedAudio(calibrationAudio);
      }
    }

    let decoded: DecodedAudio | null = null;
    try {
      decoded = await decodeCloudAudio(file, telemetry);
      const processed = await preprocessPcmChunk(
        decoded.pcm,
        decoded.sampleRate,
        {
          noiseFloorDb: settings.denoiseNoiseFloorDb,
          reductionDb: settings.denoiseReductionDb,
          smoothing: settings.denoiseSmoothing,
          calibrationSeconds: settings.denoiseCalibrationSeconds,
          noiseProfile,
          preprocessEnableFilters: settings.preprocessEnableFilters,
          preprocessHighpassHz: settings.preprocessHighpassHz,
          preprocessLowpassHz: settings.preprocessLowpassHz,
          preprocessEnableLufs: settings.preprocessEnableLufs,
          preprocessTargetLufs: settings.preprocessTargetLufs,
          preprocessLimiterEnabled: settings.preprocessLimiterEnabled,
          preprocessLimiterThresholdDb: settings.preprocessLimiterThresholdDb,
          preprocessLimiterSoftness: settings.preprocessLimiterSoftness,
          preprocessVadEnabled: settings.preprocessVadEnabled,
          preprocessVadThresholdDb: settings.preprocessVadThresholdDb,
          preprocessVadMinSilenceMs: settings.preprocessVadMinSilenceMs,
          preprocessOverlapAdd: settings.preprocessOverlapAdd,
          preprocessOverlapBlockSec: settings.preprocessOverlapBlockSec,
          preprocessOverlapSec: settings.preprocessOverlapSec,
        },
        telemetry,
        { mode: "quick" }
      );

      telemetry?.logEvent("PREPROCESS_DONE", { context: "cloud", applied: true, mode: "quick" });
      logger.debug("[cloud][preprocess] quick mode processed", {
        frames: processed.pcm.length,
        sampleRate: processed.sampleRate,
        hasNoiseProfile: Boolean(noiseProfile),
      });

      const uploadFile = buildProcessedUploadFile(file, processed.pcm, processed.sampleRate);
      processed.pcm = EMPTY_PCM;

      return {
        uploadFile,
        applied: true,
        tune,
        noiseProfile,
      };
    } finally {
      clearDecodedAudio(decoded);
    }
  }

  let decoded: DecodedAudio | null = null;
  try {
    decoded = await decodeCloudAudio(file, telemetry);
    const calibrationSeconds = resolveCalibrationSeconds(settings, "full");
    const profileResult = buildNoiseProfileResult(decoded.pcm, decoded.sampleRate, settings, calibrationSeconds);
    logNoiseProfileResult(telemetry, profileResult);

    if (settings.autoTunePreprocess) {
      try {
        tune = buildAutoTuneResult(decoded, profileResult, calibrationSeconds, telemetry);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("[cloud][preprocess][autotune] full calibration failed", err);
        telemetry?.recordAlert("PREPROCESS_AUTOTUNE_FAILED", {
          message,
          mode: settings.preprocessingMode,
          fileName: file.name,
        });
      }
    }

    const processed = await preprocessDecodedAudio(
      decoded,
      {
        noiseFloorDb: settings.denoiseNoiseFloorDb,
        reductionDb: settings.denoiseReductionDb,
        smoothing: settings.denoiseSmoothing,
        calibrationSeconds: settings.denoiseCalibrationSeconds,
        noiseProfile: profileResult.profile,
        preprocessEnableFilters: settings.preprocessEnableFilters,
        preprocessHighpassHz: settings.preprocessHighpassHz,
        preprocessLowpassHz: settings.preprocessLowpassHz,
        preprocessEnableLufs: settings.preprocessEnableLufs,
        preprocessTargetLufs: settings.preprocessTargetLufs,
        preprocessLimiterEnabled: settings.preprocessLimiterEnabled,
        preprocessLimiterThresholdDb: settings.preprocessLimiterThresholdDb,
        preprocessLimiterSoftness: settings.preprocessLimiterSoftness,
        preprocessVadEnabled: settings.preprocessVadEnabled,
        preprocessVadThresholdDb: settings.preprocessVadThresholdDb,
        preprocessVadMinSilenceMs: settings.preprocessVadMinSilenceMs,
        preprocessOverlapAdd: settings.preprocessOverlapAdd,
        preprocessOverlapBlockSec: settings.preprocessOverlapBlockSec,
        preprocessOverlapSec: settings.preprocessOverlapSec,
      },
      telemetry
    );

    telemetry?.logEvent("PREPROCESS_DONE", { context: "cloud", applied: true });
    logger.debug("[cloud][preprocess] done", {
      frames: processed.pcm.length,
      sampleRate: processed.sampleRate,
    });

    const uploadFile = buildProcessedUploadFile(file, processed.pcm, processed.sampleRate);
    processed.pcm = EMPTY_PCM;

    return {
      uploadFile,
      applied: true,
      tune,
      noiseProfile: profileResult.profile,
    };
  } finally {
    clearDecodedAudio(decoded);
  }
}
