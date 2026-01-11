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

  // compute a conservative percentile (20th) for each bin to avoid speech contamination
  const percentile = (arr: number[], p: number) => {
    const copy = arr.slice().sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(copy.length - 1, Math.floor(p * (copy.length - 1))));
    return copy[idx] ?? 0;
  };

  const profile = new Float32Array(binCount);
  for (let bin = 0; bin < binCount; bin++) {
    profile[bin] = percentile(frameMags[bin]!, 0.2);
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
): { noiseFloorDb: number; reductionDb: number; smoothing: number; snrDb: number } {
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
  let reductionDb = 10;
  if (snrDb >= 20) reductionDb = 6;
  else if (snrDb >= 10) reductionDb = 8;
  else if (snrDb >= 0) reductionDb = 10;
  else reductionDb = 12;

  // smoothing: more smoothing for lower SNR (0.6..0.98)
  let smoothing = 0.9 - snrDb / 40; // lower SNR -> higher smoothing
  smoothing = Math.min(0.98, Math.max(0.6, smoothing));

  return { noiseFloorDb, reductionDb, smoothing, snrDb };
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
