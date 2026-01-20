/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import MicPage from './MicPage';
import { useAsrStore } from '@/store/asr-store';

const micMock = {
  isRecording: false,
  isStopping: false,
  pendingCount: 0,
  recordingSeconds: 0,
  audioLevel: 0,
  hasRecording: false,
  isCalibratingNoise: false,
  noiseCalibrated: false,
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  prepareRecordingWav: vi.fn(() => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' })),
  prepareRecordingMp3: vi.fn(async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' })),
  calibrateSilenceThreshold: vi.fn(),
};

vi.mock('@/hooks/useMicTranscription', () => ({
  useMicTranscription: () => micMock,
}));

describe('MicPage', () => {
  beforeEach(() => {
    micMock.isRecording = false;
    micMock.isStopping = false;
    micMock.pendingCount = 0;
    micMock.recordingSeconds = 0;
    micMock.audioLevel = 0;
    micMock.hasRecording = false;
    micMock.isCalibratingNoise = false;
    micMock.noiseCalibrated = false;

    useAsrStore.setState({
      segments: [{ index: 0, start: 0, end: 1, text: 'hello', chunkId: 'c1', strategy: 'chunks' }],
      telemetrySummary: { sessionId: 's1' },
      status: 'ready',
      statusDetail: undefined,
      activeBackend: 'webgpu',
      micBackendPreference: 'webgpu',
      micShowExportVtt: false,
      micShowExportSrt: true,
      micShowExportJson: false,
      micShowExportTelemetry: true,
    } as any);
  });

  it('uses mic export toggles to render export buttons', () => {
    render(<MicPage />);

    expect(screen.queryByText('VTT')).toBeNull();
    expect(screen.queryByText('JSON')).toBeNull();
    expect(screen.getByText('SRT')).toBeTruthy();
    expect(screen.getByText('Telemetry')).toBeTruthy();
  });

  it('shows the recording player only when a recording is available', () => {
    micMock.hasRecording = false;
    const { rerender } = render(<MicPage />);
    expect(screen.queryByLabelText('Lecture enregistrement micro')).toBeNull();

    micMock.hasRecording = true;
    rerender(<MicPage />);
    expect(screen.getByLabelText('Lecture enregistrement micro')).toBeTruthy();
  });

  it('disables start recording until noise is calibrated', () => {
    micMock.isRecording = false;
    micMock.noiseCalibrated = false;
    render(<MicPage />);
    const start = screen.getByRole('button', { name: 'Démarrer' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it('shows active backend in the mic badge', () => {
    useAsrStore.setState({
      activeBackend: 'wasm',
      micBackendPreference: 'webgpu',
      backendPreference: 'wasm',
      status: 'ready',
      segments: [],
      telemetrySummary: null,
      statusDetail: undefined,
    } as any);

    micMock.isRecording = false;
    micMock.isStopping = false;
    micMock.noiseCalibrated = true;

    render(<MicPage />);
    expect(screen.getAllByText('WASM').length).toBeGreaterThan(0);
  });

  it('falls back to global backend preference when active backend is undefined', () => {
    useAsrStore.setState({
      activeBackend: undefined,
      backendPreference: 'wasm',
      micBackendPreference: 'webgpu',
      status: 'ready',
      segments: [],
      telemetrySummary: null,
      statusDetail: undefined,
    } as any);

    micMock.isRecording = false;
    micMock.isStopping = false;
    micMock.noiseCalibrated = true;

    render(<MicPage />);
    expect(screen.getAllByText('WASM').length).toBeGreaterThan(0);
  });

  it('hides recording controls after recording is available', () => {
    micMock.hasRecording = true;
    micMock.isRecording = false;
    micMock.noiseCalibrated = true;
    useAsrStore.setState({
      status: 'stopping',
      progress: 0.5,
      chunkPlan: [{ start: 0, end: 1 }],
      chunkMetrics: [{ startSec: 0, endSec: 1, realtimeFactor: 1 }],
      segments: [],
      telemetrySummary: null,
      statusDetail: undefined,
      backendPreference: 'wasm',
      micBackendPreference: 'wasm',
      activeBackend: 'wasm',
      audioMetadata: { durationSec: 1 },
      chunkStrategy: 'overlap',
      chunkDurationSec: 1,
      overlapSec: 0,
    } as any);

    render(<MicPage />);
    expect(screen.queryByRole('button', { name: 'Démarrer' })).toBeNull();
    expect(screen.getByText(/chunks traités/i)).toBeTruthy();
  });

  it('allows stop after chunk from the mic status bar', () => {
    micMock.hasRecording = true;
    micMock.isRecording = false;
    micMock.noiseCalibrated = true;
    useAsrStore.setState({
      status: 'transcribing',
      statusDetail: 'Finalisation des segments',
      isTranscribing: true,
      stopRequested: false,
      chunkPlan: [{ start: 0, end: 1 }],
      chunkMetrics: [],
      segments: [],
      telemetrySummary: null,
      backendPreference: 'wasm',
      micBackendPreference: 'wasm',
      activeBackend: 'wasm',
      audioMetadata: { durationSec: 1 },
      chunkStrategy: 'overlap',
      chunkDurationSec: 1,
      overlapSec: 0,
    } as any);

    render(<MicPage />);
    const stop = screen.getByRole('button', { name: 'Stop (fin du chunk)' });
    fireEvent.click(stop);

    expect(useAsrStore.getState().stopRequested).toBe(true);
    expect(useAsrStore.getState().status).toBe('stopping');
  });
});
