/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { normaliseSegments } from './useTranscriptionController';

// Mock types minimal to satisfy calls

describe('normaliseSegments', () => {
  it('computes segment confidence from text when missing (silence mode)', () => {
    const result: any = {
      segments: [
        {
          text: 'Bonjour ceci est un test simple.',
          start: 0,
          end: 3,
          // no confidence, no words
        },
      ],
      chunk: { id: 'c1', start: 0, end: 3 },
    };

    const out = normaliseSegments(result, 'silence', 0);
    expect(out.length).toBe(1);
    expect(typeof out[0].confidence).toBe('number');
    expect(out[0].confidence!).toBeGreaterThanOrEqual(0);
    expect(out[0].confidence!).toBeLessThanOrEqual(1);
    expect(out[0].confidenceSource).toBe('estimated');
  });

  it('computes chunk confidence from text when aggregate missing (chunks mode)', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c2', start: 0, end: 4 },
      text: 'Bonjour comment ça va?'
    };
    const out = normaliseSegments(result, 'chunks', 0);
    expect(out.length).toBe(1);
    expect(typeof out[0].confidence).toBe('number');
    expect(out[0].confidence!).toBeGreaterThanOrEqual(0);
    expect(out[0].confidence!).toBeLessThanOrEqual(1);
    expect(out[0].confidenceSource).toBe('estimated');
  });
});