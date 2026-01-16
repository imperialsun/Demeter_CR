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
      lastAutoTuneParams: {
        noiseFloorDb: -22,
        reductionDb: 10,
        smoothing: 0.7,
        targetLufs: -20,
        highpassHz: 90,
        lowpassHz: 7800,
        limiterThresholdDb: -1,
        limiterSoftness: 0.6,
        vadThresholdDb: -45,
        overlapBlockSec: 1.2,
        overlapSec: 0.25,
      },
      denoiseNoiseFloorDb: -25,
      denoiseReductionDb: 12,
      denoiseSmoothing: 0.8,
      denoiseCalibrationSeconds: 5,
      preprocessTargetLufs: -20,
      preprocessHighpassHz: 80,
      preprocessLowpassHz: 8000,
      preprocessLimiterThresholdDb: -1,
      preprocessLimiterSoftness: 0.6,
      preprocessVadThresholdDb: -45,
      preprocessOverlapBlockSec: 1.2,
      preprocessOverlapSec: 0.25,
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
