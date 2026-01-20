import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  safeNormalize,
  estimateNoiseProfile,
  estimateNoiseProfileWithVad,
  computePreprocessParams,
  preprocessPcmChunk,
} from './preprocessing';
import { TelemetryCollector } from './telemetry';

function makeSine(length = 1024, value = 0.1) {
  const a = new Float32Array(length);
  for (let i = 0; i < length; i++) a[i] = Math.sin(i) * value;
  return a;
}

describe('preprocessing', () => {
  beforeAll(() => {
    type GlobalWithOfflineAudio = typeof globalThis & {
      OfflineAudioContext?: typeof OfflineAudioContext;
    };
    const globalWithOffline = globalThis as GlobalWithOfflineAudio;
    if (typeof globalWithOffline.OfflineAudioContext === 'undefined') {
      globalWithOffline.OfflineAudioContext = class {} as unknown as typeof OfflineAudioContext;
    }
  });

  it('safeNormalize handles near-zero signals', () => {
    const z = new Float32Array(10);
    const out = safeNormalize(z, 0.9);
    expect(out).not.toBe(z);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("safeNormalize doesn't amplify inputs beyond gain=1", () => {
    const src = new Float32Array([0.1, -0.2, 0.05]);
    const out = safeNormalize(src, 0.5);
    const peak = Math.max(...Array.from(out).map(Math.abs));
    // The implementation clamps gain to <= 1, so small signals are not amplified
    expect(peak).toBeCloseTo(0.2, 8);
  });

  it('estimateNoiseProfile returns at least one frame even when pcm smaller than fft', () => {
    const pcm = new Float32Array(100); // less than default fft 1024
    const { profile, frames } = estimateNoiseProfile(pcm, 16000, 1);
    // Implementation pads/calculates calibrationSamples using Math.max(fftSize, ...)
    expect(frames).toBeGreaterThanOrEqual(1);
    expect(profile.length).toBe(1024 / 2 + 1);
  });

  it('estimateNoiseProfile computes a profile when enough samples', () => {
    const pcm = makeSine(2048, 0.1);
    const { profile, frames } = estimateNoiseProfile(pcm, 16000, 0.1, 256, 128);
    expect(frames).toBeGreaterThan(0);
    expect(profile.length).toBe(256 / 2 + 1);
  });

  it('computePreprocessParams maps snr to reasonable values', () => {
    const noise = new Float32Array(129).fill(1e-5);
    const pcmSegment = new Float32Array(1024).fill(0.5);
    const res = computePreprocessParams(noise, pcmSegment);
    expect(res.snrDb).toBeGreaterThan(0);
    expect(res.noiseFloorDb).toBeGreaterThanOrEqual(-35);
    expect(res.reductionDb).toBeGreaterThanOrEqual(6);
    expect(res.smoothing).toBeGreaterThanOrEqual(0.6);
    expect(res.targetLufs).toBeLessThanOrEqual(-18);
    expect(res.highpassHz).toBeGreaterThanOrEqual(60);
    expect(res.lowpassHz).toBeGreaterThanOrEqual(6500);
    expect(res.overlapBlockSec).toBeGreaterThan(0);
    expect(res.limiterSoftness).toBeGreaterThan(0);
  });

  it('estimateNoiseProfileWithVad uses silence ranges when possible', () => {
    const pcm = new Float32Array(4096);
    const res = estimateNoiseProfileWithVad(pcm, 16000, 1, -45, 200);
    expect(res.frames).toBeGreaterThan(0);
    expect(res.profile.length).toBe(1024 / 2 + 1);
    expect(res.silenceRanges).toBeGreaterThan(0);
  });

  it('preprocessPcmChunk quick mode skips noise profile and gating', async () => {
    const telemetry = new TelemetryCollector('test-session');
    const logEventSpy = vi.spyOn(telemetry, 'logEvent');
    const pcm = new Float32Array(512).fill(0.01);
    const result = await preprocessPcmChunk(
      pcm,
      16000,
      {
        noiseFloorDb: -28,
        reductionDb: 10,
        smoothing: 0.85,
        preprocessEnableFilters: false,
        preprocessEnableLufs: false,
        preprocessLimiterEnabled: false,
      },
      telemetry,
      { mode: 'quick' }
    );
    const events = logEventSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('PREPROCESS_START');
    expect(events).toContain('PREPROCESS_DONE');
    expect(events).not.toContain('PREPROCESS_NOISE_PROFILE');
    expect(events).not.toContain('PREPROCESS_GATE');
    expect(result.noiseProfile.length).toBe(0);
    expect(result.sampleRate).toBe(16000);
  });
});
