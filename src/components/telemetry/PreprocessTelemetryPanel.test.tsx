/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreprocessTelemetryPanel } from './PreprocessTelemetryPanel';
import { useAsrStore } from '@/store/asr-store';

const summary = {
  events: [
    { type: 'PREPROCESS_START', timestamp: 1, data: {} },
    { type: 'CALIBRATION_REQUESTED', timestamp: 2, data: {} },
  ],
  alerts: { PREPROCESS_NOISE: { count: 1, lastData: { a: 1 } } },
} as any;

describe('PreprocessTelemetryPanel', () => {
  beforeEach(() => {
    useAsrStore.setState({
      autoTunePreprocess: true,
      lastAutoTuneParams: { noiseFloorDb: -22, reductionDb: 10, smoothing: 0.7 },
      denoiseNoiseFloorDb: -25,
      denoiseReductionDb: 12,
      denoiseSmoothing: 0.8,
      denoiseCalibrationSeconds: 5,
      preprocessingStatus: 'calibrating',
      preprocessingProgress: 0.45,
    } as any);
  });

  it('renders preprocess information and alerts', () => {
    render(<PreprocessTelemetryPanel summary={summary} />);
    expect(screen.getByText(/Prétraitement/)).toBeTruthy();
    expect(screen.getByText(/calibrating/)).toBeTruthy();
    expect(screen.getByText(/45%/)).toBeTruthy();
    expect(screen.getByText(/PREPROCESS_START/)).toBeTruthy();
    expect(screen.getByText(/PREPROCESS_NOISE/)).toBeTruthy();
  });
});
