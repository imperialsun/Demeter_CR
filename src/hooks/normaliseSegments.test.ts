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

  it('trims overlapping prefix from chunk text', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c3', start: 0, end: 4 },
      text: 'Tout le monde comment ça va'
    };
    const previous: any = {
      text: 'Bonjour tout le monde',
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, 'chunks', 0, previous);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('comment ça va');
  });

  it('trims when short overlap matches in normal mode', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c4', start: 0, end: 5 },
      text: 'bonjour blanches on commence maintenant',
    };
    const previous: any = {
      text: 'Hier bonjour Blanche on commence',
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, 'chunks', 0, previous, { dedupeMode: 'normal' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('maintenant');
  });

  it('trims overlap when fuzzy mode tolerates minor token differences', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c5', start: 0, end: 5 },
      text: 'bonjour blanches on commence maintenant',
    };
    const previous: any = {
      text: 'Hier bonjour Blanche on commence',
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, 'chunks', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('maintenant');
  });

  it('trims overlap in silence mode when segments are adjacent', () => {
    const result: any = {
      segments: [
        {
          text: 'bonjour blanches on commence maintenant',
          start: 1.1,
          end: 3,
        },
      ],
      chunk: { id: 'c6', start: 0, end: 4 },
    };
    const previous: any = {
      text: 'bonjour Blanche on commence',
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, 'silence', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('maintenant');
  });

  it('trims overlap with offset tokens at the start of the segment', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c8', start: 0, end: 5 },
      text: 'euh bonjour on commence maintenant',
    };
    const previous: any = {
      text: 'bonjour on commence',
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, 'chunks', 0, previous, { dedupeMode: 'normal' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('maintenant');
  });

  it('trims overlap using character-level match in fuzzy mode', () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c9', start: 0, end: 5 },
      text: 'abxde fghij klmno',
    };
    const previous: any = {
      text: 'abcde fghij',
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, 'chunks', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('klmno');
  });

  it('trims short debris prefix when previous ends with continuation', () => {
    const result: any = {
      segments: [
        {
          text: 'surveillance de la cyber securite NetBlocks confirme',
          start: 1.1,
          end: 4,
        },
      ],
      chunk: { id: 'c10', start: 0, end: 4 },
    };
    const previous: any = {
      text: "L'ONG de",
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, 'silence', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('cyber securite NetBlocks confirme');
  });

  it('keeps prefix when previous ends with terminal punctuation', () => {
    const result: any = {
      segments: [
        {
          text: 'depuis ce matin la situation reste tendue',
          start: 1.1,
          end: 4,
        },
      ],
      chunk: { id: 'c11', start: 0, end: 4 },
    };
    const previous: any = {
      text: 'C’est terminé.',
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, 'silence', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('depuis ce matin la situation reste tendue');
  });

  it('keeps text in silence mode when segments are far apart', () => {
    const result: any = {
      segments: [
        {
          text: 'bonjour blanches on commence maintenant',
          start: 4,
          end: 6,
        },
      ],
      chunk: { id: 'c7', start: 0, end: 6 },
    };
    const previous: any = {
      text: 'bonjour Blanche on commence',
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, 'silence', 0, previous, { dedupeMode: 'fuzzy' });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe('bonjour blanches on commence maintenant');
  });
});
