/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import { StatusBar } from './StatusBar';
import { useAsrStore } from '@/store/asr-store';

describe('StatusBar', () => {
  beforeEach(() => {
    // Reset store values used by StatusBar
    useAsrStore.setState({
      status: 'idle',
      statusDetail: undefined,
      progress: 0,
      isTranscribing: false,
      stopRequested: false,
      chunkPlan: [],
      chunkMetrics: [],
      segments: [],
      activeBackend: undefined,
      backendPreference: 'webgpu',
    } as any);
  });

  it('shows start button and calls onStart', () => {
    const onStart = vi.fn();
    render(<StatusBar onStart={onStart} startDisabled={false} />);
    const startBtn = screen.getByText(/Lancer la transcription/i);
    expect(startBtn).toBeTruthy();
    fireEvent.click(startBtn);
    expect(onStart).toHaveBeenCalled();
  });

  it('shows stop button when transcribing and calls onStop', () => {
    useAsrStore.setState({ isTranscribing: true, stopRequested: false } as any);
    const onStop = vi.fn();
    const { rerender } = render(<StatusBar onStop={onStop} />);
    const stopBtn = screen.getByText(/Stop/);
    expect(stopBtn).toBeTruthy();
    fireEvent.click(stopBtn);
    expect(onStop).toHaveBeenCalled();

    // When stopRequested is true, button shows waiting label; update state inside act and rerender
    act(() => {
      useAsrStore.setState({ stopRequested: true } as any);
    });
    rerender(<StatusBar onStop={onStop} />);
    const waiting = screen.getAllByText(/Arrêt en cours…/i);
    expect(waiting.length).toBeGreaterThan(0);
  });

  it('displays progress, segments and percent correctly', () => {
    useAsrStore.setState({ progress: 0.42, chunkPlan: [{start:0,end:10},{start:10,end:20},{start:20,end:30}], segments: [{}, {}] } as any);
    render(<StatusBar />);
    expect(screen.getByText(/42%/)).toBeTruthy();
    expect(screen.getByText(/2\/3 segments traités/i)).toBeTruthy();
  });

  it('estimates total segments from full audio duration in progressive mode', () => {
    useAsrStore.setState({
      progress: 0.1,
      chunkPlan: [],
      segments: [{}],
      chunkStrategy: 'overlap',
      chunkDurationSec: 30,
      overlapSec: 5,
      audioMetadata: { durationSec: 120 },
    } as any);
    render(<StatusBar />);
    expect(screen.getByText(/1\/5 segments traités/i)).toBeTruthy();
  });

  it('shows realtime speed and ETA when metrics available', () => {
    useAsrStore.setState({
      chunkPlan: [{ start: 0, end: 10 }, { start: 10, end: 20 }],
      chunkMetrics: [{ startSec: 0, endSec: 5, realtimeFactor: 0.5 }],
    } as any);
    render(<StatusBar />);

    // realtime factor should be present
    expect(screen.getByText(/Vitesse/)).toBeTruthy();
    // ETA estimation line should be present
    expect(screen.getByText(/Estimation restante/)).toBeTruthy();
  });
});
