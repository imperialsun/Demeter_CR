/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { buildChunks, buildFixedSegments, computeDefaultOverlap, offsetChunks } from './chunking';

describe('chunking', () => {
  it('computeDefaultOverlap clamps to 0.2..0.9', () => {
    expect(computeDefaultOverlap(3)).toBe(0.2);
    expect(computeDefaultOverlap(5)).toBe(0.3);
    expect(computeDefaultOverlap(10)).toBe(0.6);
    expect(computeDefaultOverlap(20)).toBe(0.9);
  });

  it('builds sequential chunks', () => {
    const cfg = { chunkDurationSec: 3, overlapSec: 0.5, strategy: 'sequential', durationSec: 10, silence: { silenceThresholdDb: -50, minSilenceMs: 200, minChunkMs: 100, maxChunkMs: 5000 } } as any;
    const chunks = buildChunks(cfg);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(10);
  });

  it('builds overlap chunks with step less than chunk duration', () => {
    const cfg = { chunkDurationSec: 5, overlapSec: 2, strategy: 'overlap', durationSec: 12, silence: { silenceThresholdDb: -50, minSilenceMs: 200, minChunkMs: 100, maxChunkMs: 5000 } } as any;
    const chunks = buildChunks(cfg);
    expect(chunks.length).toBeGreaterThan(1);
    // ensure overlap yields paddedStart < start for non-zero overlap
    expect(chunks[0].paddedStart).toBe(0);
    if (chunks.length > 1) expect(chunks[1].paddedStart).toBeLessThan(chunks[1].start);
  });

  it('builds fixed segments with overlap', () => {
    const segments = buildFixedSegments({ durationSec: 1300, segmentDurationSec: 600, overlapSec: 5 });
    expect(segments.length).toBeGreaterThan(1);
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBe(600);
    expect(segments[1].start).toBe(595);
  });

  it('does not pad silence-based chunks', () => {
    const sampleRate = 1000;
    const pcm = new Float32Array(sampleRate * 2).fill(0.2);
    const cfg = {
      chunkDurationSec: 2,
      overlapSec: 1,
      strategy: 'silence',
      durationSec: 2,
      silence: { silenceThresholdDb: -40, minSilenceMs: 200, minChunkMs: 100, maxChunkMs: 5000, sampleRate },
    } as any;
    const chunks = buildChunks(cfg, pcm, sampleRate);
    expect(chunks.length).toBe(1);
    expect(chunks[0].paddedStart).toBe(chunks[0].start);
    expect(chunks[0].paddedEnd).toBe(chunks[0].end);
  });

  it('offsets chunks with a global start index', () => {
    const segments = buildFixedSegments({ durationSec: 700, segmentDurationSec: 600, overlapSec: 5 });
    const shifted = offsetChunks(segments, 600, 10);
    expect(shifted[0].start).toBe(600);
    expect(shifted[0].index).toBe(10);
  });
});
