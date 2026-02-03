import { describe, it, expect } from 'vitest';
import { cleanTranscriptText } from './text-cleanup';

describe('cleanTranscriptText', () => {
  it('removes immediate duplicate tokens with sentence boundary', () => {
    const input = 'La situation politique. politique reste tendue.';
    expect(cleanTranscriptText(input)).toBe('La situation politique reste tendue.');
  });

  it('collapses repeated short phrases', () => {
    const input = 'on y va on y va maintenant';
    expect(cleanTranscriptText(input)).toBe('on y va maintenant');
  });

  it('keeps short emphatic repetitions', () => {
    const input = 'oui oui';
    expect(cleanTranscriptText(input)).toBe('oui oui');
  });

  it('limits long single-token runs but keeps two occurrences', () => {
    const input = 'très très très très';
    expect(cleanTranscriptText(input)).toBe('très très');
  });
});
