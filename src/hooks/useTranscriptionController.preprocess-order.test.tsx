import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAsrStore } from '../store/asr-store';

// Mocks
let calibrated = false;

vi.mock('@/lib/audio', async () => {
  const actual = await vi.importActual('@/lib/audio');
  return {
    ...actual,
    decodeFileFully: vi.fn(async () => ({ metadata: { durationSec: 1 }, pcm: new Float32Array(16000), sampleRate: 16000 })),
    probeAudioMetadata: vi.fn(async () => ({ durationSec: 1 })),
  };
});

vi.mock('@/lib/preprocessing', async () => {
  const actual = await vi.importActual('@/lib/preprocessing');
  return {
    ...actual,
    estimateNoiseProfileWithVad: vi.fn(() => {
      calibrated = true;
      return { profile: new Float32Array(513), frames: 10, vadUsed: true, silenceRanges: 1 };
    }),
    preprocessDecodedAudio: vi.fn(async (decoded: { pcm: Float32Array; sampleRate: number }) => ({ pcm: decoded.pcm, sampleRate: decoded.sampleRate, noiseProfile: new Float32Array(513) })),
    computePreprocessParams: vi.fn(() => ({
      noiseFloorDb: -25,
      reductionDb: 10,
      smoothing: 0.8,
      snrDb: 20,
      targetLufs: -20,
      highpassHz: 80,
      lowpassHz: 8000,
      limiterThresholdDb: -1,
      limiterSoftness: 0.6,
      vadThresholdDb: -45,
      overlapBlockSec: 1.2,
      overlapSec: 0.25,
    })),
  };
});

vi.mock('@/lib/asr', async () => {
  return {
    createAsrPipeline: vi.fn(async () => {
      // ensure calibration happened before model init
      expect(calibrated).toBe(true);
      return { pipeline: {} as unknown as import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline, backend: 'wasm', modelId: 'X' };
    }),
    disposePipeline: vi.fn(async () => {}),
    transcribeChunk: vi.fn(async () => ({ chunk: { id: 'c1', start: 0, end: 1, paddedStart: 0, paddedEnd: 1, index: 0 }, text: '', segments: [], processingMs: 1, realtimeFactor: 1 })),
    isModelTooLargeError: vi.fn(() => false),
  };
});

vi.mock('@/lib/chunking', async () => ({
  buildChunks: vi.fn(() => [{ id: 'c1', start: 0, end: 1, paddedStart: 0, paddedEnd: 1, index: 0 }]),
  computeDefaultOverlap: vi.fn(() => 1),
}));

// Import the hook under test after mocks
import { useTranscriptionController } from './useTranscriptionController';

import { render, act } from '@testing-library/react';

describe('preprocess-before-model init', () => {
  beforeEach(() => {
    calibrated = false;
    useAsrStore.setState({
      memoryMode: 'full',
      preprocessingMode: 'quick',
      denoiseCalibrationSeconds: 1,
      denoiseNoiseFloorDb: -25,
      denoiseReductionDb: 10,
      denoiseSmoothing: 0.8,
      autoTunePreprocess: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs calibration before createAsrPipeline when memoryMode=full and preprocessing=quick', async () => {
    // Render a test component to use the hook in a valid React context
    let startUpload: ((file: File) => Promise<void>) | null = null;
    function TestComp({ onReady }: { onReady: (fn: (file: File) => Promise<void>) => void }) {
      // The hook must be used inside a component
      const controller = useTranscriptionController();
      onReady(controller.startUploadTranscription);
      return null;
    }

    await act(async () => {
      await render(<TestComp onReady={(fn: (file: File) => Promise<void>) => { startUpload = fn; }} />);
    });

    const file = new File([new ArrayBuffer(8)], 'test.wav', { type: 'audio/wav' });
    if (!startUpload) throw new Error('startUpload not obtained');
    await act(async () => {
      await startUpload!(file);
    });
  });
});
