/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResultsTable } from './ResultsTable';

const sample = [
  { index: 0, start: 0, end: 2.3, text: 'Bonjour le monde', confidence: 0.9, words: [{word:'Bonjour',start:0,end:0.5}] },
  { index: 1, start: 2.3, end: 5, text: 'Ceci est un test', confidence: 0.5 },
  { index: 2, start: 5, end: 7, text: 'Autre segment', confidence: undefined },
];

import { useAsrStore } from '@/store/asr-store';

describe('ResultsTable', () => {
  beforeEach(() => {
    useAsrStore.setState({ enableWordTimestamps: true, showSegmentConfidence: true } as any);
  });

  it('renders segments and confidences and filters via search', () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getByText('Bonjour le monde')).toBeTruthy();
    expect(screen.getByText('90%')).toBeTruthy();

    const input = screen.getByPlaceholderText('Rechercher un mot clé…');
    fireEvent.change(input, { target: { value: 'Ceci' } });
    expect(screen.getByText('Ceci est un test')).toBeTruthy();
    expect(screen.queryByText('Bonjour le monde')).toBeNull();
  });

  it('shows missing confidence as dash', () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows word timestamps when enabled', () => {
    render(<ResultsTable segments={sample as any} />);
    expect(screen.getByText(/\[00:00:00.000 - 00:00:00.500\]/)).toBeTruthy();
  });
});
