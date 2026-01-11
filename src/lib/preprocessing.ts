import type { DecodedAudio } from "@/lib/audio";
import type { TelemetryCollector } from "@/lib/telemetry";

const DEFAULT_TARGET_PEAK = 0.89; // ~ -1 dBFS
const DEFAULT_FFT_SIZE = 1024;
const DEFAULT_HOP_SIZE = 256;

export interface SpectralGateParams {
  noiseFloorDb: number;
  reductionDb: number;
  smoothing: number;
  calibrationSeconds?: number;
  noiseProfile?: Float32Array;
}

export interface PreprocessResult {
  pcm: Float32Array;
  sampleRate: number;
  noiseProfile: Float32Array;
}

export async function preprocessDecodedAudio(
  decoded: DecodedAudio,
  params: SpectralGateParams,
  telemetry?: TelemetryCollector
): Promise<PreprocessResult> {
  const startedAt = performance.now();
  console.info("[preprocess] start (full decode)", {
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
  const filtered = await applyFiltersAndCompressor(decoded.pcm, decoded.sampleRate);
  const filtersMs = performance.now() - tFilters;
  console.info("[preprocess] filters + compressor done", { durationMs: Math.round(filtersMs) });
  telemetry?.logEvent("PREPROCESS_FILTERS", { durationMs: filtersMs, sampleRate: decoded.sampleRate });

  const peakBeforeNorm = getPeak(filtered);
  const normalized = safeNormalize(filtered, DEFAULT_TARGET_PEAK);
  console.info("[preprocess] normalize", {
    peakIn: Number(peakBeforeNorm.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });
  telemetry?.logEvent("PREPROCESS_NORMALIZE", {
    peakIn: peakBeforeNorm,
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const calibrationSeconds = params.calibrationSeconds ?? 1;
  const { profile: noiseProfile, frames: noiseFrames } =
    params.noiseProfile && params.noiseProfile.length === DEFAULT_FFT_SIZE / 2 + 1
      ? { profile: params.noiseProfile, frames: 0 }
      : estimateNoiseProfile(normalized, decoded.sampleRate, calibrationSeconds);
  console.info("[preprocess] noise profile ready", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
  });
  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
  });

  const tGate = performance.now();
  const gated = await applySpectralGate(normalized, decoded.sampleRate, {
    noiseProfile,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  const gateMs = performance.now() - tGate;
  console.info("[preprocess] spectral gate done", {
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

  const peakAfterGate = getPeak(gated);
  const finalPcm = safeNormalize(gated, DEFAULT_TARGET_PEAK);
  console.info("[preprocess] finalize normalize", {
    peakIn: Number(peakAfterGate.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const totalMs = performance.now() - startedAt;
  telemetry?.logEvent("PREPROCESS_DONE", {
    durationMs: totalMs,
    sampleRate: decoded.sampleRate,
    mode: "full",
  });
  console.info("[preprocess] done", { durationMs: Math.round(totalMs) });

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
  telemetry?: TelemetryCollector
): Promise<PreprocessResult> {
  const startedAt = performance.now();
  console.info("[preprocess] start (progressive chunk)", {
    length: pcm.length,
    sampleRate,
    calibrationSeconds: params.calibrationSeconds ?? 1,
  });
  telemetry?.logEvent("PREPROCESS_START", {
    mode: "chunk",
    sampleRate,
    pcmLength: pcm.length,
  });

  const tFilters = performance.now();
  const filtered = await applyFiltersAndCompressor(pcm, sampleRate);
  const filtersMs = performance.now() - tFilters;
  console.info("[preprocess] filters + compressor done (chunk)", { durationMs: Math.round(filtersMs) });
  telemetry?.logEvent("PREPROCESS_FILTERS", { durationMs: filtersMs, sampleRate });

  const peakBeforeNorm = getPeak(filtered);
  const normalized = safeNormalize(filtered, DEFAULT_TARGET_PEAK);
  console.info("[preprocess] normalize (chunk)", {
    peakIn: Number(peakBeforeNorm.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });
  telemetry?.logEvent("PREPROCESS_NORMALIZE", {
    peakIn: peakBeforeNorm,
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const calibrationSeconds = params.calibrationSeconds ?? 1;
  const { profile: noiseProfile, frames: noiseFrames } =
    params.noiseProfile && params.noiseProfile.length === DEFAULT_FFT_SIZE / 2 + 1
      ? { profile: params.noiseProfile, frames: 0 }
      : estimateNoiseProfile(normalized, sampleRate, calibrationSeconds);
  console.info("[preprocess] noise profile ready (chunk)", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
  });
  telemetry?.logEvent("PREPROCESS_NOISE_PROFILE", {
    reused: noiseFrames === 0,
    frames: noiseFrames,
    calibrationSeconds,
  });

  const tGate = performance.now();
  const gated = await applySpectralGate(normalized, sampleRate, {
    noiseProfile,
    noiseFloorDb: params.noiseFloorDb,
    reductionDb: params.reductionDb,
    smoothing: params.smoothing,
  });
  const gateMs = performance.now() - tGate;
  console.info("[preprocess] spectral gate done (chunk)", {
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

  const peakAfterGate = getPeak(gated);
  const finalPcm = safeNormalize(gated, DEFAULT_TARGET_PEAK);
  console.info("[preprocess] finalize normalize (chunk)", {
    peakIn: Number(peakAfterGate.toFixed(4)),
    targetPeak: DEFAULT_TARGET_PEAK,
  });

  const totalMs = performance.now() - startedAt;
  telemetry?.logEvent("PREPROCESS_DONE", {
    durationMs: totalMs,
    sampleRate,
    mode: "chunk",
  });
  console.info("[preprocess] done (chunk)", { durationMs: Math.round(totalMs) });

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
  const window = buildHann(fftSize);
  const binCount = fftSize / 2 + 1;
  const accumulator = new Float32Array(binCount);
  const calibrationSamples = Math.max(fftSize, Math.min(pcm.length, Math.floor(calibrationSeconds * sampleRate)));
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
      accumulator[bin]! += mag;
    }
    frames += 1;
  }

  if (frames === 0) {
    return { profile: accumulator, frames: 0 };
  }

  for (let bin = 0; bin < accumulator.length; bin++) {
    accumulator[bin]! /= frames;
  }
  return { profile: accumulator, frames };
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

async function applyFiltersAndCompressor(pcm: Float32Array, sampleRate: number): Promise<Float32Array> {
  if (typeof OfflineAudioContext === "undefined") {
    throw new Error("L'audio offline n'est pas disponible dans cet environnement.");
  }
  const offline = new OfflineAudioContext(1, pcm.length, sampleRate);
  const buffer = offline.createBuffer(1, pcm.length, sampleRate);
  buffer.copyToChannel(new Float32Array(pcm), 0);

  const source = offline.createBufferSource();
  source.buffer = buffer;

  const highpass = offline.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 80;
  highpass.Q.value = 0.707;

  const lowpass = offline.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 8000;
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
