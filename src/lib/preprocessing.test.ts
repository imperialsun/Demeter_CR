import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computePreprocessParams,
  estimateNoiseProfile,
  estimateNoiseProfileWithVad,
  preprocessDecodedAudio,
  preprocessPcmChunk,
  safeNormalize,
} from './preprocessing';
import { TelemetryCollector } from './telemetry';

function makeSine(length = 1024, value = 0.1) {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = Math.sin(i) * value;
  }
  return out;
}

type BufferLike = {
  length: number;
  sampleRate: number;
  numberOfChannels: number;
  getChannelData: (channel: number) => Float32Array;
  copyToChannel: (data: Float32Array, channel: number) => void;
  copyFromChannel: (out: Float32Array, channel: number) => void;
};

class MockOfflineAudioContext {
  public readonly sampleRate: number;
  public readonly length: number;
  public readonly destination = {} as AudioDestinationNode;
  public readonly audioWorklet = {
    addModule: vi.fn(async () => {}),
  };

  private lastBufferData = new Float32Array(0);

  constructor(_channels: number, frameCount: number, sampleRate: number) {
    this.length = frameCount;
    this.sampleRate = sampleRate;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBuffer {
    const data = new Float32Array(length);
    const buffer: BufferLike = {
      length,
      sampleRate,
      numberOfChannels: 1,
      getChannelData: () => data,
      copyToChannel: (next: Float32Array) => {
        data.set(next.subarray(0, length));
        this.lastBufferData = data.slice();
      },
      copyFromChannel: (out: Float32Array) => {
        out.set(data.subarray(0, out.length));
      },
    };
    return buffer as unknown as AudioBuffer;
  }

  createBufferSource(): AudioBufferSourceNode {
    return {
      buffer: null,
      connect: (node: AudioNode) => node,
      start: () => {},
    } as unknown as AudioBufferSourceNode;
  }

  createBiquadFilter(): BiquadFilterNode {
    return {
      connect: (node: AudioNode) => node,
      type: 'highpass',
      frequency: { value: 0 },
      Q: { value: 0 },
    } as unknown as BiquadFilterNode;
  }

  createDynamicsCompressor(): DynamicsCompressorNode {
    return {
      connect: (node: AudioNode) => node,
      threshold: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
      knee: { value: 0 },
    } as unknown as DynamicsCompressorNode;
  }

  async startRendering(): Promise<AudioBuffer> {
    const rendered = new Float32Array(this.length);
    if (this.lastBufferData.length > 0) {
      rendered.set(this.lastBufferData.subarray(0, rendered.length));
    }
    return {
      length: rendered.length,
      copyFromChannel: (out: Float32Array) => {
        out.set(rendered.subarray(0, out.length));
      },
    } as unknown as AudioBuffer;
  }
}

class MockAudioWorkletNode {
  connect(node: AudioNode) {
    return node;
  }
}

const globalAudio = globalThis as typeof globalThis & {
  OfflineAudioContext?: typeof OfflineAudioContext;
  AudioWorkletNode?: typeof AudioWorkletNode;
};

const originalOfflineAudioContext = globalAudio.OfflineAudioContext;
const originalAudioWorkletNode = globalAudio.AudioWorkletNode;

beforeEach(() => {
  globalAudio.OfflineAudioContext = MockOfflineAudioContext as unknown as typeof OfflineAudioContext;
  globalAudio.AudioWorkletNode = MockAudioWorkletNode as unknown as typeof AudioWorkletNode;
});

afterEach(() => {
  globalAudio.OfflineAudioContext = originalOfflineAudioContext;
  globalAudio.AudioWorkletNode = originalAudioWorkletNode;
});

describe('preprocessing', () => {
  it('safeNormalize handles near-zero signals', () => {
    const zero = new Float32Array(10);
    const out = safeNormalize(zero, 0.9);
    expect(out).not.toBe(zero);
    expect(out.every((v) => v === 0)).toBe(true);
  });

  it("safeNormalize doesn't amplify inputs beyond gain=1", () => {
    const src = new Float32Array([0.1, -0.2, 0.05]);
    const out = safeNormalize(src, 0.5);
    const peak = Math.max(...Array.from(out).map(Math.abs));
    expect(peak).toBeCloseTo(0.2, 8);
  });

  it('estimateNoiseProfile returns at least one frame even when pcm smaller than fft', () => {
    const pcm = new Float32Array(100);
    const { profile, frames } = estimateNoiseProfile(pcm, 16000, 1);
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

  it('preprocessDecodedAudio runs full pipeline and emits telemetry events', async () => {
    const telemetry = new TelemetryCollector('full-run');
    const logEventSpy = vi.spyOn(telemetry, 'logEvent');
    const decoded = {
      metadata: { durationSec: 2 },
      pcm: makeSine(4096, 0.04),
      sampleRate: 16000,
    };

    const result = await preprocessDecodedAudio(
      decoded,
      {
        noiseFloorDb: -30,
        reductionDb: 10,
        smoothing: 0.85,
        calibrationSeconds: 0.5,
        preprocessEnableFilters: true,
        preprocessEnableLufs: true,
        preprocessLimiterEnabled: true,
        preprocessVadEnabled: true,
        preprocessOverlapAdd: true,
      },
      telemetry
    );

    expect(result.sampleRate).toBe(16000);
    expect(result.pcm.length).toBe(decoded.pcm.length);
    expect(result.noiseProfile.length).toBe(1024 / 2 + 1);

    const events = logEventSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('PREPROCESS_FILTERS');
    expect(events).toContain('PREPROCESS_NOISE_PROFILE');
    expect(events).toContain('PREPROCESS_GATE');
    expect(events).toContain('PREPROCESS_OVERLAP');
    expect(events).toContain('PREPROCESS_LIMITER');
    expect(events).toContain('PREPROCESS_DONE');
  });

  it('preprocessDecodedAudio reuses supplied noise profile and can skip lufs/limiter/overlap', async () => {
    const telemetry = new TelemetryCollector('reuse-profile');
    const logEventSpy = vi.spyOn(telemetry, 'logEvent');
    const decoded = {
      metadata: { durationSec: 1 },
      pcm: makeSine(2048, 0.08),
      sampleRate: 16000,
    };
    const providedNoise = new Float32Array(1024 / 2 + 1).fill(0.001);

    const result = await preprocessDecodedAudio(
      decoded,
      {
        noiseFloorDb: -25,
        reductionDb: 8,
        smoothing: 0.8,
        noiseProfile: providedNoise,
        preprocessEnableFilters: false,
        preprocessEnableLufs: false,
        preprocessLimiterEnabled: false,
        preprocessVadEnabled: false,
        preprocessOverlapAdd: false,
      },
      telemetry
    );

    expect(result.noiseProfile).toBe(providedNoise);

    const events = logEventSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('PREPROCESS_NORMALIZE');
    expect(events).not.toContain('PREPROCESS_LUFS');
    expect(events).not.toContain('PREPROCESS_LIMITER');
    expect(events).not.toContain('PREPROCESS_OVERLAP');
  });

  it('preprocessPcmChunk full mode reuses provided profile and emits gate event', async () => {
    const telemetry = new TelemetryCollector('chunk-full');
    const logEventSpy = vi.spyOn(telemetry, 'logEvent');
    const pcm = makeSine(2048, 0.05);
    const providedNoise = new Float32Array(1024 / 2 + 1).fill(0.002);

    const result = await preprocessPcmChunk(
      pcm,
      16000,
      {
        noiseFloorDb: -28,
        reductionDb: 9,
        smoothing: 0.82,
        noiseProfile: providedNoise,
        preprocessEnableFilters: true,
        preprocessEnableLufs: false,
        preprocessLimiterEnabled: false,
        preprocessVadEnabled: false,
        preprocessOverlapAdd: false,
      },
      telemetry,
      { mode: 'full' }
    );

    expect(result.noiseProfile).toBe(providedNoise);
    const events = logEventSpy.mock.calls.map((call) => call[0]);
    expect(events).toContain('PREPROCESS_GATE');
    expect(events).not.toContain('PREPROCESS_LUFS');
  });

  it('preprocessPcmChunk quick mode skips noise profile and gating', async () => {
    const telemetry = new TelemetryCollector('quick-run');
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

  it('throws a clear error when offline audio is unavailable (full decode)', async () => {
    globalAudio.OfflineAudioContext = undefined;

    await expect(
      preprocessDecodedAudio(
        {
          metadata: { durationSec: 1 },
          pcm: makeSine(1024, 0.02),
          sampleRate: 16000,
        },
        {
          noiseFloorDb: -25,
          reductionDb: 8,
          smoothing: 0.8,
        }
      )
    ).rejects.toThrow("L'audio offline n'est pas disponible dans cet environnement.");
  });

  it('throws a clear error when offline audio is unavailable (chunk full mode)', async () => {
    globalAudio.OfflineAudioContext = undefined;

    await expect(
      preprocessPcmChunk(
        makeSine(1024, 0.02),
        16000,
        {
          noiseFloorDb: -25,
          reductionDb: 8,
          smoothing: 0.8,
        },
        undefined,
        { mode: 'full' }
      )
    ).rejects.toThrow("L'audio offline n'est pas disponible dans cet environnement.");
  });
});
