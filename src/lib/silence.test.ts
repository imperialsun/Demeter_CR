import { describe, it, expect } from 'vitest';
import { detectSilenceRegions } from './silence';

function buildPcm(sampleRate: number, segments: Array<{ durationMs: number; amplitude: number }>) {
  const totalSamples = segments.reduce(
    (sum, seg) => sum + Math.round((seg.durationMs / 1000) * sampleRate),
    0
  );
  const pcm = new Float32Array(totalSamples);
  let offset = 0;
  for (const seg of segments) {
    const samples = Math.round((seg.durationMs / 1000) * sampleRate);
    pcm.fill(seg.amplitude, offset, offset + samples);
    offset += samples;
  }
  return pcm;
}

describe('detectSilenceRegions', () => {
  const sampleRate = 1000;
  const silenceThresholdDb = -35;

  it('returns empty when sampleRate is missing', () => {
    const pcm = new Float32Array(100);
    const segments = detectSilenceRegions(pcm, {
      silenceThresholdDb,
      minSilenceMs: 200,
      minChunkMs: 0,
      maxChunkMs: 1000,
    });
    expect(segments).toEqual([]);
  });

  it('splits speech regions on silence longer than minSilenceMs', () => {
    const pcm = buildPcm(sampleRate, [
      { durationMs: 400, amplitude: 0.1 },
      { durationMs: 400, amplitude: 0 },
      { durationMs: 400, amplitude: 0.1 },
    ]);
    const segments = detectSilenceRegions(pcm, {
      sampleRate,
      silenceThresholdDb,
      minSilenceMs: 200,
      minChunkMs: 0,
      maxChunkMs: 2000,
    });
    expect(segments).toHaveLength(2);
    expect(segments[0]?.startSec).toBeCloseTo(0, 2);
    expect(segments[0]?.endSec).toBeCloseTo(0.4, 2);
    expect(segments[1]?.startSec).toBeCloseTo(0.8, 2);
    expect(segments[1]?.endSec).toBeCloseTo(1.2, 2);
  });

  it('merges tiny segments shorter than minChunkMs', () => {
    const pcm = buildPcm(sampleRate, [
      { durationMs: 400, amplitude: 0.1 },
      { durationMs: 300, amplitude: 0 },
      { durationMs: 100, amplitude: 0.1 },
    ]);
    const segments = detectSilenceRegions(pcm, {
      sampleRate,
      silenceThresholdDb,
      minSilenceMs: 200,
      minChunkMs: 300,
      maxChunkMs: 2000,
    });
    expect(segments).toHaveLength(1);
    expect(segments[0]?.startSec).toBeCloseTo(0, 2);
    expect(segments[0]?.endSec).toBeCloseTo(0.8, 2);
  });

  it('splits long segments to respect maxChunkMs', () => {
    const pcm = buildPcm(sampleRate, [{ durationMs: 1000, amplitude: 0.1 }]);
    const segments = detectSilenceRegions(pcm, {
      sampleRate,
      silenceThresholdDb,
      minSilenceMs: 200,
      minChunkMs: 0,
      maxChunkMs: 300,
    });
    expect(segments).toHaveLength(4);
    expect(segments[0]?.startSec).toBeCloseTo(0, 2);
    expect(segments[0]?.endSec).toBeCloseTo(0.3, 2);
    expect(segments[3]?.endSec).toBeCloseTo(1.0, 2);
  });
});
