/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useAsrStore } from '@/store/asr-store';
import { useEffect } from 'react';

const mocks = vi.hoisted(() => ({
  createAsrPipeline: vi.fn(async () => ({
    pipeline: {} as unknown as import('@huggingface/transformers').AutomaticSpeechRecognitionPipeline,
    backend: 'wasm',
    modelId: 'mock-model',
  })),
  transcribeChunk: vi.fn(async (args: any) => ({
    chunk: args.chunk,
    text: `chunk-${args.chunk.index}`,
    segments: [],
    processingMs: 1,
    realtimeFactor: 1,
  })),
  preprocessPcmChunk: vi.fn(async (pcm: Float32Array, sampleRate: number) => ({
    pcm,
    sampleRate,
    noiseProfile: new Float32Array(0),
  })),
  estimateNoiseProfileWithVad: vi.fn(() => ({
    profile: new Float32Array(513),
    frames: 5,
    vadUsed: true,
    silenceRanges: 1,
  })),
  computePreprocessParams: vi.fn(() => ({
    noiseFloorDb: -30,
    reductionDb: 12,
    smoothing: 0.9,
    snrDb: 22,
    targetLufs: -18,
    highpassHz: 90,
    lowpassHz: 7500,
    limiterThresholdDb: -1,
    limiterSoftness: 0.7,
    vadThresholdDb: -40,
    overlapBlockSec: 1.1,
    overlapSec: 0.2,
  })),
  ffmpegInstance: {
    writeFile: vi.fn(async () => {}),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    deleteFile: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
  },
  getFfmpeg: vi.fn(async () => mocks.ffmpegInstance),
}));

vi.mock('@/lib/asr', () => ({
  createAsrPipeline: mocks.createAsrPipeline,
  disposePipeline: vi.fn(async () => {}),
  transcribeChunk: mocks.transcribeChunk,
  isModelTooLargeError: vi.fn(() => false),
}));

vi.mock('@/lib/preprocessing', async () => {
  const actual = await vi.importActual('@/lib/preprocessing');
  return {
    ...actual,
    preprocessPcmChunk: mocks.preprocessPcmChunk,
    estimateNoiseProfileWithVad: mocks.estimateNoiseProfileWithVad,
    computePreprocessParams: mocks.computePreprocessParams,
  };
});

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/lib/ffmpeg-loader', () => ({
  getFfmpeg: mocks.getFfmpeg,
  resetFfmpeg: vi.fn(),
}));

import { useMicTranscription } from './useMicTranscription';
import { useTranscriptionController } from './useTranscriptionController';
import { disposePipeline } from '@/lib/asr';

type AudioProcessHandler = ((event: { inputBuffer: { getChannelData: (channel: number) => Float32Array } }) => void) | null;

class FakeScriptProcessorNode {
  onaudioprocess: AudioProcessHandler = null;
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeGainNode {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

let lastProcessor: FakeScriptProcessorNode | null = null;

class FakeAudioContext {
  sampleRate = 1000;
  destination = {};
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createScriptProcessor = vi.fn(() => {
    lastProcessor = new FakeScriptProcessorNode();
    return lastProcessor as unknown as ScriptProcessorNode;
  });
  createGain = vi.fn(() => new FakeGainNode());
}

describe('useMicTranscription', () => {
  let originalAudioContext: typeof AudioContext | undefined;
  let originalMediaDevices: MediaDevices | undefined;
  let originalNow: typeof Date.now;

  beforeEach(() => {
    mocks.createAsrPipeline.mockClear();
    mocks.transcribeChunk.mockClear();
    mocks.preprocessPcmChunk.mockClear();
    mocks.estimateNoiseProfileWithVad.mockClear();
    mocks.computePreprocessParams.mockClear();
    mocks.getFfmpeg.mockClear();
    mocks.ffmpegInstance.writeFile.mockClear();
    mocks.ffmpegInstance.readFile.mockClear();
    mocks.ffmpegInstance.deleteFile.mockClear();
    mocks.ffmpegInstance.exec.mockClear();

    lastProcessor = null;

    useAsrStore.setState({
      micSegmentationMode: 'chunks',
      micPreprocessingMode: 'quick',
      micAutoTunePreprocess: false,
      micEnableWordTimestamps: false,
      micShowSegmentConfidence: false,
      segments: [],
      chunkPlan: [],
      chunkMetrics: [],
      status: 'idle',
      statusDetail: undefined,
      isTranscribing: false,
      stopRequested: false,
    } as any);

    originalAudioContext = globalThis.AudioContext;
    globalThis.AudioContext = FakeAudioContext as unknown as typeof AudioContext;

    originalMediaDevices = navigator.mediaDevices;
    const fakeStream = { getTracks: () => [{ stop: vi.fn() }] };
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia: vi.fn(async () => fakeStream) },
      configurable: true,
    });

    originalNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalNow;
    if (originalAudioContext) {
      globalThis.AudioContext = originalAudioContext;
    } else {
      try {
        delete (globalThis as any).AudioContext;
      } catch {
        /* ignore */
      }
    }
    if (originalMediaDevices) {
      Object.defineProperty(navigator, 'mediaDevices', {
        value: originalMediaDevices,
        configurable: true,
      });
    } else {
      try {
        delete (navigator as any).mediaDevices;
      } catch {
        /* ignore */
      }
    }
  });

  it('creates fixed 15s mic chunks when segmentation is set to chunks', async () => {
    let startRecording: (() => Promise<void>) | null = null;
    let stopRecording: (() => Promise<void>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (start: () => Promise<void>, stop: () => Promise<void>, calibrate: () => Promise<void>) => void;
    }) {
      const controller = useMicTranscription();
      onReady(controller.startRecording, controller.stopRecording, controller.calibrateSilenceThreshold);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(start, stop, calibrate) => {
          startRecording = start;
          stopRecording = stop;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    expect(lastProcessor).toBeTruthy();
    const pcm = new Float32Array(32000).fill(0.02);
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await act(async () => {
      await stopRecording!();
    });

    await waitFor(() => expect(mocks.transcribeChunk).toHaveBeenCalledTimes(3), { timeout: 5000 });
    const chunks = mocks.transcribeChunk.mock.calls.map((call) => call[0].chunk);
    expect(chunks.map((chunk: any) => [chunk.start, chunk.end])).toEqual([
      [0, 15],
      [15, 30],
      [30, 32],
    ]);
    const sampleRates = mocks.transcribeChunk.mock.calls.map((call) => call[0].sampleRate);
    expect(sampleRates).toEqual([16000, 16000, 16000]);

    unmount();
  });

  it('reuses autotune preprocessing params after the first mic chunk', async () => {
    useAsrStore.setState({
      micAutoTunePreprocess: true,
      micDenoiseNoiseFloorDb: -12,
      micDenoiseReductionDb: 4,
      micDenoiseSmoothing: 0.4,
      micPreprocessHighpassHz: 50,
      micPreprocessLowpassHz: 4000,
      micPreprocessTargetLufs: -24,
      micPreprocessLimiterThresholdDb: -6,
      micPreprocessLimiterSoftness: 0.3,
      micPreprocessVadThresholdDb: -50,
      micPreprocessOverlapBlockSec: 0.5,
      micPreprocessOverlapSec: 0.1,
    } as any);

    mocks.computePreprocessParams.mockReturnValue({
      noiseFloorDb: -30,
      reductionDb: 12,
      smoothing: 0.9,
      snrDb: 22,
      targetLufs: -18,
      highpassHz: 90,
      lowpassHz: 7500,
      limiterThresholdDb: -1,
      limiterSoftness: 0.7,
      vadThresholdDb: -40,
      overlapBlockSec: 1.1,
      overlapSec: 0.2,
    });

    let startRecording: (() => Promise<void>) | null = null;
    let stopRecording: (() => Promise<void>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (start: () => Promise<void>, stop: () => Promise<void>, calibrate: () => Promise<void>) => void;
    }) {
      const controller = useMicTranscription();
      onReady(controller.startRecording, controller.stopRecording, controller.calibrateSilenceThreshold);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(start, stop, calibrate) => {
          startRecording = start;
          stopRecording = stop;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    const pcm = new Float32Array(31000).fill(0.03);
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await act(async () => {
      await stopRecording!();
    });

    await waitFor(() => expect(mocks.transcribeChunk).toHaveBeenCalledTimes(3), { timeout: 5000 });
    expect(mocks.computePreprocessParams).toHaveBeenCalledTimes(1);
    expect(mocks.estimateNoiseProfileWithVad).toHaveBeenCalledTimes(1);

    const preprocessParams = (mocks.preprocessPcmChunk as any).mock.calls
      .map((call: any[]) => call[2])
      .filter(Boolean);
    expect(preprocessParams).toHaveLength(3);
    for (const params of preprocessParams) {
      expect((params as any).noiseFloorDb).toBe(-30);
      expect((params as any).reductionDb).toBe(12);
      expect((params as any).smoothing).toBe(0.9);
      expect((params as any).preprocessHighpassHz).toBe(90);
      expect((params as any).preprocessLowpassHz).toBe(7500);
      expect((params as any).preprocessTargetLufs).toBe(-18);
      expect((params as any).preprocessLimiterThresholdDb).toBe(-1);
      expect((params as any).preprocessLimiterSoftness).toBe(0.7);
      expect((params as any).preprocessVadThresholdDb).toBe(-40);
      expect((params as any).preprocessOverlapBlockSec).toBe(1.1);
      expect((params as any).preprocessOverlapSec).toBe(0.2);
    }

    unmount();
  });

  it('calibrates mic silence threshold from recent audio', async () => {
    useAsrStore.setState({ micSilenceThresholdDb: -35, micNoiseCalibrationMarginDb: 6 } as any);

    let startRecording: (() => Promise<void>) | null = null;
    let stopRecording: (() => Promise<void>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (start: () => Promise<void>, stop: () => Promise<void>, calibrate: () => Promise<void>) => void
    }) {
      const controller = useMicTranscription();
      onReady(controller.startRecording, controller.stopRecording, controller.calibrateSilenceThreshold);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(start, stop, calibrate) => {
          startRecording = start;
          stopRecording = stop;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    expect(lastProcessor).toBeTruthy();
    const pcm = new Float32Array(2000).fill(0.01);
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await act(async () => {
      await calibrateSilenceThreshold!();
    });

    expect(useAsrStore.getState().micSilenceThresholdDb).toBeCloseTo(-34, 1);

    await act(async () => {
      await stopRecording!();
    });

    unmount();
  });

  it('does not emit silence-based chunks smaller than minChunkMs during recording', async () => {
    // simulate time so MIN_DETECT_INTERVAL_MS gate triggers per buffer push
    let now = 0;
    Date.now = () => now;

    useAsrStore.setState({
      micSegmentationMode: 'silence',
      micSilenceThresholdDb: -35,
      micMinSilenceMs: 500,
      micMinChunkMs: 10_000,
      micMaxChunkMs: 20_000,
      micPreprocessingMode: 'off',
      micAutoTunePreprocess: false,
      micEnableWordTimestamps: false,
      micShowSegmentConfidence: false,
      segments: [],
      chunkPlan: [],
      chunkMetrics: [],
      status: 'idle',
      statusDetail: undefined,
      isTranscribing: false,
      stopRequested: false,
    } as any);

    let startRecording: (() => Promise<void>) | null = null;
    let stopRecording: (() => Promise<void>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (start: () => Promise<void>, stop: () => Promise<void>, calibrate: () => Promise<void>) => void;
    }) {
      const controller = useMicTranscription();
      onReady(controller.startRecording, controller.stopRecording, controller.calibrateSilenceThreshold);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(start, stop, calibrate) => {
          startRecording = start;
          stopRecording = stop;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    expect(lastProcessor).toBeTruthy();

    const speech = new Float32Array(1000).fill(0.1); // 1s @ 1kHz
    const silence = new Float32Array(600).fill(0.0001); // 0.6s silence (> 500ms)
    const frame = new Float32Array(speech.length + silence.length);
    frame.set(speech, 0);
    frame.set(silence, speech.length);

    // Push 6 times: 1.6s * 6 = 9.6s total -> still below 10s
    for (let i = 0; i < 6; i += 1) {
      now += 300;
      await act(async () => {
        lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
      });
    }

    // Should not have emitted any chunk yet
    expect(mocks.transcribeChunk).toHaveBeenCalledTimes(0);

    // 7th push crosses 10s threshold -> one chunk should be enqueued/transcribed
    now += 300;
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
    });

    await waitFor(() => expect(mocks.transcribeChunk).toHaveBeenCalledTimes(1), { timeout: 5000 });
    const chunk = mocks.transcribeChunk.mock.calls[0]![0].chunk as any;
    expect(chunk.end - chunk.start).toBeGreaterThanOrEqual(10);
    expect(chunk.end - chunk.start).toBeLessThanOrEqual(20);

    await act(async () => {
      await stopRecording!();
    });

    unmount();
  });

  it('prepares an mp3 blob using the FFmpeg class API', async () => {
    useAsrStore.setState({ micSegmentationMode: 'chunks' } as any);

    let startRecording: (() => Promise<void>) | null = null;
    let stopRecording: (() => Promise<void>) | null = null;
    let prepareRecordingMp3: (() => Promise<Blob>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (
        start: () => Promise<void>,
        stop: () => Promise<void>,
        prepare: () => Promise<Blob>,
        calibrate: () => Promise<void>
      ) => void;
    }) {
      const controller = useMicTranscription();
      onReady(
        controller.startRecording,
        controller.stopRecording,
        controller.prepareRecordingMp3,
        controller.calibrateSilenceThreshold
      );
      return null;
    }

    render(
      <TestComp
        onReady={(start, stop, prepare, calibrate) => {
          startRecording = start;
          stopRecording = stop;
          prepareRecordingMp3 = prepare;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    // produce some recorded audio so we have something to export
    const pcm = new Float32Array(2000).fill(0.02);
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await act(async () => {
      await stopRecording!();
    });

    const blob = await prepareRecordingMp3!();
    expect(blob.type).toBe('audio/mpeg');

    // ensure we used the modern API (no legacy FS present in this mock)
    expect(mocks.getFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.ffmpegInstance.writeFile).toHaveBeenCalled();
    expect(mocks.ffmpegInstance.exec).toHaveBeenCalled();
    expect(mocks.ffmpegInstance.readFile).toHaveBeenCalled();
  });

  it('does not dispose the mic pipeline while an inference is in-flight during abort', async () => {
    const deferred: { resolve: (value: any) => void; promise: Promise<any> } = (() => {
      let resolve!: (value: any) => void;
      const promise = new Promise<any>((res) => {
        resolve = res;
      });
      return { resolve, promise };
    })();

    const transcribeSpy = mocks.transcribeChunk;
    transcribeSpy.mockImplementationOnce(async (args: any) => {
      const res = await deferred.promise;
      return {
        chunk: args.chunk,
        text: res?.text ?? 'delayed',
        segments: [],
        processingMs: 1,
        realtimeFactor: 1,
      };
    });

    (disposePipeline as unknown as { mockClear: () => void }).mockClear?.();

    let startRecording: (() => Promise<void>) | null = null;
    let abortTranscription: (() => void | Promise<void>) | null = null;
    let calibrateSilenceThreshold: (() => Promise<void>) | null = null;

    function TestComp({
      onReady,
    }: {
      onReady: (start: () => Promise<void>, abort: () => void | Promise<void>, calibrate: () => Promise<void>) => void;
    }) {
      const mic = useMicTranscription();
      const controller = useTranscriptionController();
      onReady(mic.startRecording, controller.abortTranscription, mic.calibrateSilenceThreshold);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(start, abort, calibrate) => {
          startRecording = start;
          abortTranscription = abort;
          calibrateSilenceThreshold = calibrate;
        }}
      />
    );

    await act(async () => {
      await calibrateSilenceThreshold!();
      await startRecording!();
    });

    expect(lastProcessor).toBeTruthy();
    const pcm = new Float32Array(16000).fill(0.02); // 16s @ 1kHz -> 0-15s chunk + tail
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await waitFor(() => expect(mocks.transcribeChunk).toHaveBeenCalledTimes(1), { timeout: 2000 });

    const abortPromise = act(async () => {
      await Promise.resolve(abortTranscription?.());
    });

    expect((disposePipeline as unknown as any).mock.calls.length).toBe(0);

    deferred.resolve({ text: 'ok' });
    await abortPromise;

    await waitFor(() => expect(disposePipeline).toHaveBeenCalled(), { timeout: 5000 });
    unmount();
  });

  it('resets mic local state after a store reset', async () => {
    let controller: ReturnType<typeof useMicTranscription> | null = null;

    function TestComp({ onReady }: { onReady: (value: ReturnType<typeof useMicTranscription>) => void }) {
      const next = useMicTranscription();
      useEffect(() => onReady(next), [next, onReady]);
      return null;
    }

    const { unmount } = render(
      <TestComp
        onReady={(value) => {
          controller = value;
        }}
      />
    );

    await act(async () => {
      await controller!.calibrateSilenceThreshold();
    });

    expect(controller!.noiseCalibrated).toBe(true);

    await act(async () => {
      await controller!.startRecording();
    });

    const pcm = new Float32Array(1000).fill(0.02);
    await act(async () => {
      lastProcessor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => pcm } });
    });

    await act(async () => {
      await controller!.stopRecording();
    });

    await waitFor(() => expect(controller!.hasRecording).toBe(true), { timeout: 5000 });

    await act(async () => {
      useAsrStore.getState().resetSession();
    });

    await waitFor(() => expect(controller!.hasRecording).toBe(false), { timeout: 5000 });
    expect(controller!.noiseCalibrated).toBe(false);
    expect(controller!.pendingCount).toBe(0);
    expect(controller!.recordingSeconds).toBe(0);

    unmount();
  });
});
