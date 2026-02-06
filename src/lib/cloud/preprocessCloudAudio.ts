import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import type { DecodedAudio } from "@/lib/audio";
import { decodeCloudAudio } from "@/lib/cloud/decodeCloudAudio";
import {
  computePreprocessParams,
  estimateNoiseProfile,
  estimateNoiseProfileWithVad,
  preprocessDecodedAudio,
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
  decoded: DecodedAudio;
  processed: DecodedAudio;
  noiseProfile?: Float32Array;
  applied: boolean;
  tune?: CloudAutoTuneResult;
};

export async function preprocessCloudAudio(
  file: File,
  settings: CloudPreprocessSettings,
  telemetry?: TelemetryCollector
): Promise<CloudPreprocessResult> {
  logger.info("[cloud][preprocess] start", {
    fileName: file.name,
    mode: settings.preprocessingMode,
  });
  telemetry?.logEvent("PREPROCESS_START", { context: "cloud", mode: settings.preprocessingMode });

  const decoded = await decodeCloudAudio(file, telemetry);
  const sampleRate = decoded.sampleRate;

  const profileResult = settings.preprocessVadEnabled
    ? estimateNoiseProfileWithVad(
        decoded.pcm,
        sampleRate,
        settings.denoiseCalibrationSeconds,
        settings.preprocessVadThresholdDb,
        settings.preprocessVadMinSilenceMs
      )
    : { ...estimateNoiseProfile(decoded.pcm, sampleRate, settings.denoiseCalibrationSeconds), vadUsed: false, silenceRanges: 0 };

  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    context: "cloud",
    frames: profileResult.frames,
    vadUsed: profileResult.vadUsed,
    silenceRanges: profileResult.silenceRanges,
  });
  logger.info("[cloud][preprocess] noise profile ready", {
    frames: profileResult.frames,
    vadUsed: profileResult.vadUsed,
  });

  let tune: CloudAutoTuneResult | undefined;
  if (settings.autoTunePreprocess) {
    const sampleCount = Math.max(1, Math.floor(settings.denoiseCalibrationSeconds * sampleRate));
    const segment = decoded.pcm.subarray(0, sampleCount);
    const tuned = computePreprocessParams(profileResult.profile, segment);
    tune = tuned;
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
    logger.info("[cloud][preprocess][autotune] computed", {
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
  }

  if (settings.preprocessingMode !== "full") {
    telemetry?.logEvent("PREPROCESS_DONE", { context: "cloud", applied: false });
    logger.info("[cloud][preprocess] quick mode, no processing applied");
    return {
      decoded,
      processed: decoded,
      noiseProfile: profileResult.profile,
      applied: false,
      tune,
    };
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
  logger.info("[cloud][preprocess] done", {
    frames: processed.pcm.length,
    sampleRate: processed.sampleRate,
  });

  return {
    decoded,
    processed: { metadata: decoded.metadata, pcm: processed.pcm, sampleRate: processed.sampleRate },
    noiseProfile: profileResult.profile,
    applied: true,
    tune,
  };
}
