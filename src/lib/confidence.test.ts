import { describe, it, expect } from 'vitest';
import { computeOverallConfidenceSource } from './confidence';

import type { TranscriptionSegment } from '@/lib/export';

describe('computeOverallConfidenceSource', () => {
  it('returns model when majority of duration is model-sourced', () => {
    const segs: TranscriptionSegment[] = [
      { index: 0, start: 0, end: 5, text: 'a', chunkId: 'c1', strategy: 'chunks', confidence: 0.9, confidenceSource: 'model' },
      { index: 1, start: 5, end: 8, text: 'b', chunkId: 'c1', strategy: 'chunks', confidence: 0.8, confidenceSource: 'estimated' },
    ];
    expect(computeOverallConfidenceSource(segs)).toBe('model');
  });

  it('returns estimated when majority of duration is estimated', () => {
    const segs: TranscriptionSegment[] = [
      { index: 0, start: 0, end: 1, text: 'a', chunkId: 'c1', strategy: 'chunks', confidence: 0.9, confidenceSource: 'model' },
      { index: 1, start: 1, end: 10, text: 'b', chunkId: 'c1', strategy: 'chunks', confidence: 0.8, confidenceSource: 'estimated' },
    ];
    expect(computeOverallConfidenceSource(segs)).toBe('estimated');
  });

  it('returns null when no sources present', () => {
    const segs: TranscriptionSegment[] = [
      { index: 0, start: 0, end: 1, text: 'a', chunkId: 'c1', strategy: 'chunks' },
    ];
    expect(computeOverallConfidenceSource(segs)).toBeNull();
  });
});