import type { DecodedAudio } from "@/lib/audio";
import type { TelemetryCollector } from "@/lib/telemetry";
import logger from "@/lib/logger";
import { detectSilenceRegions } from "@/lib/silence";

const DEFAULT_TARGET_PEAK = 0.89; // ~ -1 dBFS
const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_HOP_SIZE = 256;
const DEFAULT_LUFS_TARGET = -20;
const DEFAULT_LIMITER_THRESHOLD_DB = -1;
const DEFAULT_LIMITER_SOFTNESS = 0.6;
const DEFAULT_HIGHPASS_HZ = 80;
const DEFAULT_LOWPASS_HZ = 7800;
const DEFAULT_VAD_THRESHOLD_DB = -40;
const DEFAULT_VAD_MIN_SILENCE_MS = 250;
const DEFAULT_OVERLAP_BLOCK_SEC = 1.2;
const DEFAULT_OVERLAP_SEC = 0.25;

export interface SpectralGateParams {
  noiseFloorDb: number;
  reductionDb: number;
  smoothing: number;
  calibrationSeconds?: number;
  noiseProfile?: Float32Array;
  preprocessEnableFilters?: boolean;
  preprocessHighpassHz?: number;
  preprocessLowpassHz?: number;
  preprocessEnableLufs?: boolean;
  preprocessTargetLufs?: number;
  preprocessLimiterEnabled?: boolean;
  preprocessLimiterThresholdDb?: number;
  preprocessLimiterSoftness?: number;
  preprocessVadEnabled?: boolean;
  preprocessVadThresholdDb?: number;
  preprocessVadMinSilenceMs?: number;
  preprocessOverlapAdd?: boolean;
  preprocessOverlapBlockSec?: number;
  preprocessOverlapSec?: number;
}

export interface PreprocessResult {
  pcm: Float32Array;
  sampleRate: number;
  noiseProfile: Float32Array;
}

type NoiseRange = { startSample: number; endSample: number };

function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

function linearToDb(value: number) {
  return 20 * Math.log10(Math.max(1e-12, value));
}

function measureLufsApprox(pcm: Float32Array, sampleRate: number) {
  const frameDuration = 0.4;
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameDuration));
  const gateDb = -60;
  let gatedFrames = 0;
  let sumSq = 0;
  let totalFrames = 0;
  for (let start = 0; start < pcm.length; start += frameSamples) {
    totalFrames += 1;
    const end = Math.min(start + frameSamples, pcm.length);
    let frameSum = 0;
    for (let i = start; i < end; i++) {
      const sample = pcm[i] ?? 0;
      frameSum += sample * sample;
    }
    const rms = Math.sqrt(frameSum / Math.max(1, end - start));
    const frameDb = linearToDb(rms);
    if (frameDb >= gateDb) {
      gatedFrames += 1;
      sumSq += frameSum / Math.max(1, end - start);
    }
  }
  if (gatedFrames === 0) {
    let fullSum = 0;
    for (let i = 0; i < pcm.length; i++) {
      const sample = pcm[i] ?? 0;
      fullSum += sample * sample;
    }
    const rms = Math.sqrt(fullSum / Math.max(1, pcm.length));
    return { lufs: linearToDb(rms), gatedFrames: 0, totalFrames };
  }
  const meanSq = sumSq / gatedFrames;
  return { lufs: linearToDb(Math.sqrt(meanSq)), gatedFrames, totalFrames };
}

function normalizeToLufs(pcm: Float32Array, sampleRate: number, targetLufs: number) {
  const measurement = measureLufsApprox(pcm, sampleRate);
  const deltaDb = targetLufs - measurement.lufs;
  const gain = Math.min(6, Math.max(0.1, dbToLinear(deltaDb)));
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i]! * gain;
  }
  return { pcm: out, measuredLufs: measurement.lufs, gain, gatedFrames: measurement.gatedFrames, totalFrames: measurement.totalFrames };
}

function applyLimiter(pcm: Float32Array, thresholdDb: number, softness: number) {
  const threshold = dbToLinear(thresholdDb);
  const shape = Math.max(0.05, softness);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const input = pcm[i] ?? 0;
    const sign = input >= 0 ? 1 : -1;
    const abs = Math.abs(input);
    if (abs <= threshold) {
      out[i] = input;
      continue;
    }
    const excess = abs - threshold;
    const softened = Math.tanh(excess / shape) * shape;
    out[i] = sign * Math.min(1, threshold + softened);
  }
  return out;
}

function computePercentile(arr: number[], p: number) {
  if (!arr.length) return 0;
  const copy = [...arr].sort((a, b) => a - b);
  const idx = Math.min(copy.length - 1, Math.max(0, Math.floor(p * (copy.length - 1))));
  return copy[idx] ?? 0;
}

function buildNoiseRangesFromSpeech(speech: Array<{ startSec: number; endSec: number }>, totalSamples: number, sampleRate: number): NoiseRange[] {
  if (!speech.length) {
    return [{ startSample: 0, endSample: totalSamples }];
  }
  const ranges: NoiseRange[] = [];
  const sorted = [...speech].sort((a, b) => a.startSec - b.startSec);
  let cursor = 0;
  for (const segment of sorted) {
    const startSample = Math.max(0, Math.floor(segment.startSec * sampleRate));
    const endSample = Math.min(totalSamples, Math.floor(segment.endSec * sampleRate));
    if (startSample > cursor) {
      ranges.push({ startSample: cursor, endSample: startSample });
    }
    cursor = Math.max(cursor, endSample);
  }
  if (cursor < totalSamples) {
    ranges.push({ startSample: cursor, endSample: totalSamples });
  }
  return ranges.filter((range) => range.endSample - range.startSample > 0);
}

function estimateNoiseProfileFromRanges(
  pcm: Float32Array,
  sampleRate: number,
  ranges: NoiseRange[],
  calibrationSeconds: number,
  fftSize: number = DEFAULT_FFT_SIZE,
  hopSize: number = DEFAULT_HOP_SIZE
): { profile: Float32Array; frames: number } | null {
  const window = buildHann(fftSize);
  const binCount = fftSize / 2 + 1;
  const maxSamples = Math.min(pcm.length, Math.max(fftSize, Math.floor(calibrationSeconds * sampleRate)));
  const frameMags: number[][] = Array.from({ length: binCount }, () => []);
  let frames = 0;
  let usedSamples = 0;

  for (const range of ranges) {
    if (usedSamples >= maxSamples) break;
    const rangeLength = Math.min(range.endSample, pcm.length) - range.startSample;
    if (rangeLength < fftSize) continue;
    const rangeMax = Math.min(range.endSample, range.startSample + maxSamples - usedSamples);
    for (let offset = range.startSample; offset + fftSize <= rangeMax; offset += hopSize) {
      const re = new Float32Array(fftSize);
      const im = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        const sample = pcm[offset + i] ?? 0;
        re[i] = sample * window[i]!;
      }
      fftRadix2(re, im);
      for (let bin = 0; bin < binCount; bin++) {
        const mag = Math.hypot(re[bin]!, im[bin]!);
        frameMags[bin]!.push(mag);
      }
      frames += 1;
      usedSamples = Math.min(maxSamples, usedSamples + hopSize);
      if (usedSamples >= maxSamples) break;
    }
  }

  if (!frames) return null;
  const profile = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    profile[bin] = computePercentile(frameMags[bin]!, 0.2);
  }
  if (binCount > 2) {
    const smoothed = new Float32Array(binCount);
    smoothed[0] = profile[0];
    smoothed[binCount - 1] = profile[binCount - 1];
    for (let bin = 1; bin < binCount - 1; bin++) {
      smoothed[bin] = 0.25 * profile[bin - 1] + 0.5 * profile[bin] + 0.25 * profile[bin + 1];
    }
    return { profile: smoothed, frames };
  }
  return { profile, frames };
}

export function estimateNoiseProfileWithVad(
  pcm: Float32Array,
  sampleRate: number,
  calibrationSeconds: number,
  vadThresholdDb: number,
  vadMinSilenceMs: number
): { profile: Float32Array; frames: number; vadUsed: boolean; silenceRanges: number } {
  const speechRegions = detectSilenceRegions(pcm, {
    sampleRate,
    silenceThresholdDb: vadThresholdDb,
    minSilenceMs: vadMinSilenceMs,
    minChunkMs: 0,
    maxChunkMs: pcm.length / sampleRate,
  });
  const noiseRanges = buildNoiseRangesFromSpeech(speechRegions, pcm.length, sampleRate);
  const vadProfile = estimateNoiseProfileFromRanges(
    pcm,
    sampleRate,
    noiseRanges,
    calibrationSeconds
  );
  if (vadProfile) {
    return { ...vadProfile, vadUsed: true, silenceRanges: noiseRanges.length };
  }
  const fallback = estimateNoiseProfile(pcm, sampleRate, calibrationSeconds);
  return { ...fallback, vadUsed: false, silenceRanges: noiseRanges.length };
}

function applyOverlapAddSmoothing(
  pcm: Float32Array,
  sampleRate: number,
  blockSec: number,
  overlapSec: number
): Float32Array {
  const blockSamples = Math.max(1, Math.floor(blockSec * sampleRate));
  const overlapSamples = Math.max(0, Math.min(blockSamples - 1, Math.floor(overlapSec * sampleRate)));
  if (blockSamples <= 1 || overlapSamples <= 0) {
    return pcm.slice();
  }
  const stride = blockSamples - overlapSamples;
  const window = buildHann(blockSamples);
  const output = new Float32Array(pcm.length);
  const weights = new Float32Array(pcm.length);
  for (let start = 0; start < pcm.length; start += stride) {
    const end = Math.min(start + blockSamples, pcm.length);
    for (let i = 0; i < end - start; i++) {
      const w = window[i] ?? 0;
      output[start + i] += (pcm[start + i] ?? 0) * w;
      weights[start + i] += w;
    }
  }
  for (let i = 0; i < pcm.length; i++) {
    const w = weights[i] ?? 0;
    output[i] = w > 1e-6 ? output[i] / w : pcm[i] ?? 0;
  }
  return output;
}

export async function preprocessDecodedAudio(
  decoded: DecodedAudio,
  params: SpectralGateParams,
  telemetry?: TelemetryCollector
): Promise<PreprocessResult> {
  const startedAt = performance.now();
  logger.info("[preprocess] start (full decode)", {
    sampleRate: decoded.sampleRate,
    durationSec: decoded.metadata.durationSec,
    calibrationSeconds: params.calibrationSeconds ?? 1,
  });
  telemetry?.logEvent("PREPROCESS_START", {
    mode: "full",
    sampleRate: decoded.sampleRate,
    durationSec: decoded.metadata.durationSec,
  });

  const tFilters = performance.now();
  const filtered = await applyFiltersAndCompressor(decoded.pcm, decoded.sampleRate, {
    enabled: params.preprocessEnableFilters ?? true,
    highpassHz: params.preprocessHighpassHz ?? DEFAULT_HIGHPASS_HZ,
    lowpassHz: params.preprocessLowpassHz ?? DEFAULT_LOWPASS_HZ,
  });
  const filtersMs = performance.now() - tFilters;
  logger.info("[preprocess] filters + compressor done", { durationMs: Math.round(filtersMs) });
  telemetry?.logEvent("PREPROCESS_FILTERS", { durationMs: filtersMs, sampleRate: decoded.sampleRate });

  const lufsEnabled = params.preprocessEnableLufs ?? true;
  const targetLufs = params.preprocessTargetLufs ?? DEFAULT_LUFS_TARGET;
  let normalized: Float32Array;
  if (lufsEnabled) {
    const lufsResult = normalizeToLufs(filtered, decoded.sampleRate, targetLufs);
    normalized = lufsResult.pcm;
    logger.info("[preprocess] loudness normalize", {
      measuredLufs: Number(lufsResult.measuredLufs.toFixed(2)),
      targetLufs,
      gain: Number(lufsResult.gain.toFixed(3)),
      gatedFrames: lufsResult.gatedFrames,
      totalFrames: lufsResult.totalFrames,
    });
    telemetry?.logEvent("PREPROCESS_LUFS", {
      measuredLufs: lufsResult.measuredLufs,
      targetLufs,
      gain: lufsResult.gain,
      gatedFrames: lufsResult.gatedFrames,
      totalFrames: lufsResult.totalFrames,
    });
  } else {
    const peakBeforeNorm = getPeak(filtered);
    normalized = safeNormalize(filtered, DEFAULT_TARGET_PEAK);
    logger.info("[preprocess] normalize", {
      peakIn: Number(peakBeforeNorm.toFixed(4)),
      targetPeak: DEFAULT_TARGET_PEAK,
    });
    telemetry?.logEvent("PREPROCESS_NORMALIZE", {
      peakIn: peakBeforeNorm,
      targetPeak: DEFAULT_TARGET_PEAK,
    });
  }

  const calibrationSeconds = params.calibrationSeconds ?? 1;
  const vadEnabled = params.preprocessVadEnabled ?? true;
  const vadThresholdDb = params.preprocessVadThresholdDb ?? DEFAULT_VAD_THRESHOLD_DB;
  const vadMinSilenceMs = params.preprocessVadMinSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS;
  const noiseProfileResult =
    params.noiseProfile && params.noiseProfile.length === DEFAULT_FFT_SIZE / 2 + 1
      ? { profile: params.noiseProfile, frames: 0, vadUsed: false, silenceRanges: 0 }
      : vadEnabled
        ? estimateNoiseProfileWithVad(normalized, decoded.sampleRate, calibrationSeconds, vadThresholdDb, vadMinSilenceMs)
        : { ...estimateNoiseProfile(normalized, decoded.sampleRate, calibrationSeconds), vadUsed: false, silenceRanges: 0 };
  const { profile: noiseProfile, frames: noiseFrames } = noiseProfileResult;
  logger.info("[preprocess] noise profile ready", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
    vadUsed: noiseProfileResult.vadUsed,
    silenceRanges: noiseProfileResult.silenceRanges,
  });
  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
    vadUsed: noiseProfileResult.vadUsed,
    silenceRanges: noiseProfileResult.silenceRanges,
  });

  const tGate = performance.now();
  const gated = await applySpectralGate(normalized, decoded.sampleRate, {
    noiseProfile,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  const gateMs = performance.now() - tGate;
  logger.info("[preprocess] spectral gate done", {
    durationMs: Math.round(gateMs),
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  telemetry?.logEvent("PREPROCESS_GATE", {
    durationMs: gateMs,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });

  const overlapEnabled = params.preprocessOverlapAdd ?? true;
  const overlapBlockSec = params.preprocessOverlapBlockSec ?? DEFAULT_OVERLAP_BLOCK_SEC;
  const overlapSec = params.preprocessOverlapSec ?? DEFAULT_OVERLAP_SEC;
  const smoothed = overlapEnabled
    ? applyOverlapAddSmoothing(gated, decoded.sampleRate, overlapBlockSec, overlapSec)
    : gated;
  if (overlapEnabled) {
    logger.info("[preprocess] overlap-add smoothing", {
      blockSec: overlapBlockSec,
      overlapSec,
    });
    telemetry?.logEvent("PREPROCESS_OVERLAP", { blockSec: overlapBlockSec, overlapSec });
  }

  const peakAfterGate = getPeak(smoothed);
  const peakNormalized = safeNormalize(smoothed, DEFAULT_TARGET_PEAK);
  logger.info("[preprocess] finalize normalize", {
    peakIn: Number(peakAfterGate.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const limiterEnabled = params.preprocessLimiterEnabled ?? true;
  const limiterThresholdDb = params.preprocessLimiterThresholdDb ?? DEFAULT_LIMITER_THRESHOLD_DB;
  const limiterSoftness = params.preprocessLimiterSoftness ?? DEFAULT_LIMITER_SOFTNESS;
  const finalPcm = limiterEnabled ? applyLimiter(peakNormalized, limiterThresholdDb, limiterSoftness) : peakNormalized;
  if (limiterEnabled) {
    logger.info("[preprocess] limiter applied", {
      thresholdDb: limiterThresholdDb,
      softness: limiterSoftness,
    });
    telemetry?.logEvent("PREPROCESS_LIMITER", { thresholdDb: limiterThresholdDb, softness: limiterSoftness });
  }

  const totalMs = performance.now() - startedAt;
  telemetry?.logEvent("PREPROCESS_DONE", {
    durationMs: totalMs,
    sampleRate: decoded.sampleRate,
    mode: "full",
  });
  logger.info("[preprocess] done", { durationMs: Math.round(totalMs) });

  return {
    pcm: finalPcm,
    sampleRate: decoded.sampleRate,
    noiseProfile,
  };
}

export async function preprocessPcmChunk(
  pcm: Float32Array,
  sampleRate: number,
  params: SpectralGateParams,
  telemetry?: TelemetryCollector,
  options?: { mode?: "quick" | "full" }
): Promise<PreprocessResult> {
  const startedAt = performance.now();
  const mode = options?.mode ?? "full";
  logger.info("[preprocess] start (progressive chunk)", {
    length: pcm.length,
    sampleRate,
    calibrationSeconds: params.calibrationSeconds ?? 1,
    mode,
  });
  telemetry?.logEvent("PREPROCESS_START", {
    mode: "chunk",
    sampleRate,
    pcmLength: pcm.length,
  });

  const tFilters = performance.now();
  const filtered = await applyFiltersAndCompressor(pcm, sampleRate, {
    enabled: params.preprocessEnableFilters ?? true,
    highpassHz: params.preprocessHighpassHz ?? DEFAULT_HIGHPASS_HZ,
    lowpassHz: params.preprocessLowpassHz ?? DEFAULT_LOWPASS_HZ,
  });
  const filtersMs = performance.now() - tFilters;
  logger.info("[preprocess] filters + compressor done (chunk)", { durationMs: Math.round(filtersMs) });
  telemetry?.logEvent("PREPROCESS_FILTERS", { durationMs: filtersMs, sampleRate });

  const lufsEnabled = params.preprocessEnableLufs ?? true;
  const targetLufs = params.preprocessTargetLufs ?? DEFAULT_LUFS_TARGET;
  let normalized: Float32Array;
  if (lufsEnabled) {
    const lufsResult = normalizeToLufs(filtered, sampleRate, targetLufs);
    normalized = lufsResult.pcm;
    logger.info("[preprocess] loudness normalize (chunk)", {
      measuredLufs: Number(lufsResult.measuredLufs.toFixed(2)),
      targetLufs,
      gain: Number(lufsResult.gain.toFixed(3)),
      gatedFrames: lufsResult.gatedFrames,
      totalFrames: lufsResult.totalFrames,
    });
    telemetry?.logEvent("PREPROCESS_LUFS", {
      measuredLufs: lufsResult.measuredLufs,
      targetLufs,
      gain: lufsResult.gain,
      gatedFrames: lufsResult.gatedFrames,
      totalFrames: lufsResult.totalFrames,
    });
  } else {
    const peakBeforeNorm = getPeak(filtered);
    normalized = safeNormalize(filtered, DEFAULT_TARGET_PEAK);
    logger.info("[preprocess] normalize (chunk)", {
      peakIn: Number(peakBeforeNorm.toFixed(4)),
      targetPeak: DEFAULT_TARGET_PEAK,
    });
    telemetry?.logEvent("PREPROCESS_NORMALIZE", {
      peakIn: peakBeforeNorm,
      targetPeak: DEFAULT_TARGET_PEAK,
    });
  }

  if (mode === "quick") {
    const peakAfterNorm = getPeak(normalized);
    const peakNormalized = safeNormalize(normalized, DEFAULT_TARGET_PEAK);
    logger.info("[preprocess] finalize normalize (chunk)", {
      peakIn: Number(peakAfterNorm.toFixed(4)),
      targetPeak: DEFAULT_TARGET_PEAK,
    });
    telemetry?.logEvent("PREPROCESS_NORMALIZE", {
      peakIn: peakAfterNorm,
      targetPeak: DEFAULT_TARGET_PEAK,
    });

    const limiterEnabled = params.preprocessLimiterEnabled ?? true;
    const limiterThresholdDb = params.preprocessLimiterThresholdDb ?? DEFAULT_LIMITER_THRESHOLD_DB;
    const limiterSoftness = params.preprocessLimiterSoftness ?? DEFAULT_LIMITER_SOFTNESS;
    const finalPcm = limiterEnabled ? applyLimiter(peakNormalized, limiterThresholdDb, limiterSoftness) : peakNormalized;
    if (limiterEnabled) {
      logger.info("[preprocess] limiter applied (chunk)", {
        thresholdDb: limiterThresholdDb,
        softness: limiterSoftness,
      });
      telemetry?.logEvent("PREPROCESS_LIMITER", { thresholdDb: limiterThresholdDb, softness: limiterSoftness });
    }

    const totalMs = performance.now() - startedAt;
    telemetry?.logEvent("PREPROCESS_DONE", {
      durationMs: totalMs,
      sampleRate,
      mode: "quick",
    });
    logger.info("[preprocess] done (chunk)", { durationMs: Math.round(totalMs), mode: "quick" });

    return {
      pcm: finalPcm,
      sampleRate,
      noiseProfile: params.noiseProfile ?? new Float32Array(0),
    };
  }

  const calibrationSeconds = params.calibrationSeconds ?? 1;
  const vadEnabled = params.preprocessVadEnabled ?? true;
  const vadThresholdDb = params.preprocessVadThresholdDb ?? DEFAULT_VAD_THRESHOLD_DB;
  const vadMinSilenceMs = params.preprocessVadMinSilenceMs ?? DEFAULT_VAD_MIN_SILENCE_MS;
  const noiseProfileResult =
    params.noiseProfile && params.noiseProfile.length === DEFAULT_FFT_SIZE / 2 + 1
      ? { profile: params.noiseProfile, frames: 0, vadUsed: false, silenceRanges: 0 }
      : vadEnabled
        ? estimateNoiseProfileWithVad(normalized, sampleRate, calibrationSeconds, vadThresholdDb, vadMinSilenceMs)
        : { ...estimateNoiseProfile(normalized, sampleRate, calibrationSeconds), vadUsed: false, silenceRanges: 0 };
  const { profile: noiseProfile, frames: noiseFrames } = noiseProfileResult;
  logger.info("[preprocess] noise profile ready (chunk)", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
    vadUsed: noiseProfileResult.vadUsed,
    silenceRanges: noiseProfileResult.silenceRanges,
  });
  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
    vadUsed: noiseProfileResult.vadUsed,
    silenceRanges: noiseProfileResult.silenceRanges,
  });

  const tGate = performance.now();
  const gated = await applySpectralGate(normalized, sampleRate, {
    noiseProfile,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  const gateMs = performance.now() - tGate;
  logger.info("[preprocess] spectral gate done (chunk)", {
    durationMs: Math.round(gateMs),
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  telemetry?.logEvent("PREPROCESS_GATE", {
    durationMs: gateMs,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });

  const overlapEnabled = params.preprocessOverlapAdd ?? true;
  const overlapBlockSec = params.preprocessOverlapBlockSec ?? DEFAULT_OVERLAP_BLOCK_SEC;
  const overlapSec = params.preprocessOverlapSec ?? DEFAULT_OVERLAP_SEC;
  const smoothed = overlapEnabled ? applyOverlapAddSmoothing(gated, sampleRate, overlapBlockSec, overlapSec) : gated;
  if (overlapEnabled) {
    logger.info("[preprocess] overlap-add smoothing (chunk)", {
      blockSec: overlapBlockSec,
      overlapSec,
    });
    telemetry?.logEvent("PREPROCESS_OVERLAP", { blockSec: overlapBlockSec, overlapSec });
  }

  const peakAfterGate = getPeak(smoothed);
  const peakNormalized = safeNormalize(smoothed, DEFAULT_TARGET_PEAK);
  logger.info("[preprocess] finalize normalize (chunk)", {
    peakIn: Number(peakAfterGate.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const limiterEnabled = params.preprocessLimiterEnabled ?? true;
  const limiterThresholdDb = params.preprocessLimiterThresholdDb ?? DEFAULT_LIMITER_THRESHOLD_DB;
  const limiterSoftness = params.preprocessLimiterSoftness ?? DEFAULT_LIMITER_SOFTNESS;
  const finalPcm = limiterEnabled ? applyLimiter(peakNormalized, limiterThresholdDb, limiterSoftness) : peakNormalized;
  if (limiterEnabled) {
    logger.info("[preprocess] limiter applied (chunk)", {
      thresholdDb: limiterThresholdDb,
      softness: limiterSoftness,
    });
    telemetry?.logEvent("PREPROCESS_LIMITER", { thresholdDb: limiterThresholdDb, softness: limiterSoftness });
  }

  const totalMs = performance.now() - startedAt;
  telemetry?.logEvent("PREPROCESS_DONE", {
    durationMs: totalMs,
    sampleRate,
    mode: "chunk",
  });
  logger.info("[preprocess] done (chunk)", { durationMs: Math.round(totalMs) });

  return {
    pcm: finalPcm,
    sampleRate,
    noiseProfile,
  };
}

export function safeNormalize(pcm: Float32Array, targetPeak: number = DEFAULT_TARGET_PEAK): Float32Array {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]!);
    if (abs > peak) {
      peak = abs;
    }
  }
  if (peak < 1e-8) {
    return pcm.slice();
  }
  const gain = Math.min(1, targetPeak / peak);
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    out[i] = pcm[i]! * gain;
  }
  return out;
}

function getPeak(pcm: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]!);
    if (abs > peak) {
      peak = abs;
    }
  }
  return peak;
}

export function estimateNoiseProfile(
  pcm: Float32Array,
  sampleRate: number,
  calibrationSeconds: number,
  fftSize: number = DEFAULT_FFT_SIZE,
  hopSize: number = DEFAULT_HOP_SIZE
): { profile: Float32Array; frames: number } {
  // ASR-friendly noise profile estimation: use a low percentile across frames (robust to speech frames)
  // and apply light smoothing across frequency bins to avoid spiky profiles.
  const window = buildHann(fftSize);
  const binCount = fftSize / 2 + 1;
  const calibrationSamples = Math.max(fftSize, Math.min(pcm.length, Math.floor(calibrationSeconds * sampleRate)));
  const frameMags: number[][] = Array.from({ length: binCount }, () => []);
  let frames = 0;

  for (let offset = 0; offset + fftSize <= calibrationSamples; offset += hopSize) {
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) {
      const sample = pcm[offset + i] ?? 0;
      re[i] = sample * window[i]!;
      im[i] = 0;
    }
    fftRadix2(re, im);
    for (let bin = 0; bin < binCount; bin++) {
      const mag = Math.hypot(re[bin]!, im[bin]!);
      frameMags[bin]!.push(mag);
    }
    frames += 1;
  }

  if (frames === 0) {
    return { profile: new Float32Array(binCount), frames: 0 };
  }

  const profile = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    profile[bin] = computePercentile(frameMags[bin]!, 0.2);
  }

  // Smooth across bins with a small kernel to avoid sharp spectral artifacts
  if (binCount > 2) {
    const smoothed = new Float32Array(binCount);
    smoothed[0] = profile[0];
    smoothed[binCount - 1] = profile[binCount - 1];
    for (let bin = 1; bin < binCount - 1; bin++) {
      smoothed[bin] = 0.25 * profile[bin - 1] + 0.5 * profile[bin] + 0.25 * profile[bin + 1];
    }
    return { profile: smoothed, frames };
  }

  return { profile, frames };
}

/**
 * Compute ASR‑friendly gate parameters from a noise profile and a short audio segment.
 * Returns noiseFloorDb, reductionDb and smoothing that are conservative for Whisper.
 */
export function computePreprocessParams(
  noiseProfile: Float32Array,
  pcmSegment: Float32Array
): {
  noiseFloorDb: number;
  reductionDb: number;
  smoothing: number;
  snrDb: number;
  targetLufs: number;
  highpassHz: number;
  lowpassHz: number;
  limiterThresholdDb: number;
  limiterSoftness: number;
  vadThresholdDb: number;
  overlapBlockSec: number;
  overlapSec: number;
} {
  const binCount = noiseProfile.length;
  const eps = 1e-12;

  // noise median in dB
  const noiseBinsDb = new Float32Array(binCount);
  for (let i = 0; i < binCount; i++) {
    noiseBinsDb[i] = 20 * Math.log10(Math.max(noiseProfile[i]!, eps));
  }
  // median
  const copy = Array.from(noiseBinsDb).sort((a, b) => a - b);
  const noiseDbMedian = copy[Math.floor(copy.length / 2)] ?? copy[0] ?? -100;

  // signal RMS dB on the pcm segment
  let sumSq = 0;
  for (let i = 0; i < pcmSegment.length; i++) {
    const s = pcmSegment[i] ?? 0;
    sumSq += s * s;
  }
  const rms = Math.sqrt(sumSq / Math.max(1, pcmSegment.length));
  const signalDb = 20 * Math.log10(Math.max(rms, eps));

  const snrDb = signalDb - noiseDbMedian;

  // map SNR to parameters (conservative ASR-friendly defaults)
  let noiseFloorDb: number;
  if (snrDb >= 20) noiseFloorDb = -35;
  else if (snrDb >= 10) noiseFloorDb = -30;
  else if (snrDb >= 0) noiseFloorDb = -25;
  else noiseFloorDb = -20;

  // reduction: 6..14 dB
  let reductionDb: number;
  if (snrDb >= 20) reductionDb = 6;
  else if (snrDb >= 10) reductionDb = 8;
  else if (snrDb >= 0) reductionDb = 10;
  else reductionDb = 12;

  // smoothing: more smoothing for lower SNR (0.6..0.98)
  let smoothing = 0.9 - snrDb / 40; // lower SNR -> higher smoothing
  smoothing = Math.min(0.98, Math.max(0.6, smoothing));

  let targetLufs: number;
  if (snrDb >= 20) targetLufs = -23;
  else if (snrDb >= 10) targetLufs = -21;
  else if (snrDb >= 0) targetLufs = -20;
  else targetLufs = -18;

  let highpassHz = DEFAULT_HIGHPASS_HZ;
  if (snrDb < 0) highpassHz = 120;
  else if (snrDb < 10) highpassHz = 100;
  else if (snrDb >= 20) highpassHz = 70;

  let lowpassHz = DEFAULT_LOWPASS_HZ;
  if (snrDb < 0) lowpassHz = 6500;
  else if (snrDb < 10) lowpassHz = 7200;
  else if (snrDb >= 20) lowpassHz = 7800;

  const limiterThresholdDb = DEFAULT_LIMITER_THRESHOLD_DB;
  let limiterSoftness = DEFAULT_LIMITER_SOFTNESS;
  if (snrDb < 0) limiterSoftness = 0.75;
  else if (snrDb >= 20) limiterSoftness = 0.55;

  let vadThresholdDb = DEFAULT_VAD_THRESHOLD_DB;
  if (snrDb < 0) vadThresholdDb = -40;
  else if (snrDb >= 20) vadThresholdDb = -48;

  let overlapBlockSec = DEFAULT_OVERLAP_BLOCK_SEC;
  if (snrDb < 0) overlapBlockSec = 0.9;
  else if (snrDb >= 20) overlapBlockSec = 1.4;
  const overlapSec = Math.min(overlapBlockSec * 0.25, 0.35);

  return {
    noiseFloorDb,
    reductionDb,
    smoothing,
    snrDb,
    targetLufs,
    highpassHz,
    lowpassHz,
    limiterThresholdDb,
    limiterSoftness,
    vadThresholdDb,
    overlapBlockSec,
    overlapSec,
  };
}

async function applySpectralGate(
  pcm: Float32Array,
  sampleRate: number,
  params: {
    noiseProfile: Float32Array;
    noiseFloorDb: number;
    reductionDb: number;
    smoothing: number;
  }
): Promise<Float32Array> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("L'audio offline n'est pas disponible dans cet environnement.");
  }

  const offline = new OfflineAudioContext(1, pcm.length, sampleRate);
  const buffer = offline.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(new Float32Array(pcm), 0);

  await offline.audioWorklet.addModule("/worklets/spectral-gate.js");

  const source = offline.createBufferSource();
  source.buffer = buffer;

  const gateNode = new AudioWorkletNode(offline, "spectral-gate-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: {
      noiseProfile: params.noiseProfile,
      noiseFloorDb: params.noiseFloorDb,
      reductionDb: params.reductionDb,
      smoothing: params.smoothing,
      fftSize: DEFAULT_FFT_SIZE,
      hopSize: DEFAULT_HOP_SIZE,
    },
  });

  source.connect(gateNode).connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const out = new Float32Array(rendered.length);
  rendered.copyFromChannel(out, 0);
  return out;
}

async function applyFiltersAndCompressor(
  pcm: Float32Array,
  sampleRate: number,
  params: { enabled: boolean; highpassHz: number; lowpassHz: number }
): Promise<Float32Array> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("L'audio offline n'est pas disponible dans cet environnement.");
  }
  if (!params.enabled) {
    return pcm.slice();
  }
  const nyquist = sampleRate / 2;
  const highpassHz = Math.min(Math.max(20, params.highpassHz), nyquist - 100);
  const lowpassHz = Math.min(Math.max(highpassHz + 100, params.lowpassHz), nyquist);
  const offline = new OfflineAudioContext(1, pcm.length, sampleRate);
  const buffer = offline.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(new Float32Array(pcm), 0);

  const source = offline.createBufferSource();
  source.buffer = buffer;

  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = highpassHz;
  highpass.Q.value = 0.707;

  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = lowpassHz;
  lowpass.Q.value = 0.707;

  const compressor = offline.createDynamicsCompressor();
  compressor.threshold.value = -20;
  compressor.ratio.value = 2;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.05;
  compressor.knee.value = 10;

  source.connect(highpass).connect(lowpass).connect(compressor).connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const out = new Float32Array(rendered.length);
  rendered.copyFromChannel(out, 0);
  return out;
}

function buildHann(size: number): Float32Array {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

function fftRadix2(re: Float32Array, im: Float32Array) {
  const n = re.length;
  if (n <= 1) return;
  let target = 0;
  for (let position = 0; position < n; position++) {
    if (target > position) {
      const tr = re[target]!;
      const ti = im[target]!;
      re[target] = re[position]!;
      im[target] = im[position]!;
      re[position] = tr;
      im[position] = ti;
    }
    let mask = n >> 1;
    while (target & mask) {
      target &= ~mask;
      mask >>= 1;
    }
    target |= mask;
  }
  for (let step = 2; step <= n; step <<= 1) {
    const delta = Math.PI * 2 / step;
    const sine = Math.sin(delta / 2);
    const multiplier = -2 * sine * sine;
    const phaseShiftStep = Math.sin(delta);
    for (let group = 0; group < n; group += step) {
      let phaseShiftRe = 1;
      let phaseShiftIm = 0;
      for (let pair = 0; pair < step / 2; pair++) {
        const match = group + pair + step / 2;
        const gr = re[group + pair]!;
        const gi = im[group + pair]!;
        const hr = re[match]!;
        const hi = im[match]!;

        const tr = phaseShiftRe * hr - phaseShiftIm * hi;
        const ti = phaseShiftRe * hi + phaseShiftIm * hr;
        re[group + pair] = gr + tr;
        im[group + pair] = gi + ti;
        re[match] = gr - tr;
        im[match] = gi - ti;

        const tmpRe = phaseShiftRe;
        phaseShiftRe += phaseShiftRe * multiplier + phaseShiftIm * phaseShiftStep;
        phaseShiftIm += phaseShiftIm * multiplier - tmpRe * phaseShiftStep;
      }
    }
  }
}

// Helper kept for potential reuse of gating math elsewhere if needed in the future.
