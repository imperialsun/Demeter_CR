/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TelemetryPanel } from './TelemetryPanel';

const baseSummary = {
  sessionId: 's1',
  createdAt: Date.now(),
  userAgent: 'tls',
  transformersVersion: 'x',
  backend: 'wasm',
  modelId: 'm1',
  timings: { load_model_total: 123, decode_audio_total: 456 },
  memorySnapshots: [{ label: 'snap', usedJSHeapSize: 10, totalJSHeapSize: 50, timestamp: 100 }],
  events: [
    { type: 'RAM_USAGE', timestamp: 200, data: { context: 'chunk', index: 0, mb: 12 } },
    { type: 'OTHER', timestamp: 300, data: { foo: 'bar' } },
  ],
  chunks: [ { id: 'c1', index: 0, startSec: 0, endSec: 10, transcriptionMs: 1000, realtimeFactor: 0.5 } ],
  alerts: {},
};

describe('TelemetryPanel', () => {
  it('renders message when no summary provided', () => {
    render(<TelemetryPanel summary={null} />);
    expect(screen.getByText('Aucun run enregistré pour le moment.')).toBeTruthy();
  });

  it('renders summary content when provided', () => {
    render(<TelemetryPanel summary={baseSummary as any} />);
    expect(screen.getAllByText(/Session/).length).toBeGreaterThan(0);
    expect(screen.getByText(baseSummary.sessionId)).toBeTruthy();
    expect(screen.getAllByText(/Mémoire/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Chunks/).length).toBeGreaterThan(0);
    // event timeline
    expect(screen.getByText('OTHER')).toBeTruthy();
  });
});
