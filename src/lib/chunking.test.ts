/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { buildChunks, computeDefaultOverlap } from './chunking';

describe('chunking', () => {
  it('computeDefaultOverlap uses 10% but clamps at 0.5', () => {
    expect(computeDefaultOverlap(3)).toBe(0.5); // 10% => 0.3 -> clamp to 0.5
    expect(computeDefaultOverlap(10)).toBe(1); // 10% => 1
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
});
