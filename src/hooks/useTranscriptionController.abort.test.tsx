import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, waitFor } from "@testing-library/react";
import { useAsrStore } from "@/store/asr-store";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let transcribeDeferred: Deferred<{
  chunk: { id: string; start: number; end: number; paddedStart: number; paddedEnd: number; index: number };
  text: string;
  segments: Array<unknown>;
  processingMs: number;
  realtimeFactor: number;
}>;

vi.mock("@/lib/audio", async () => {
  const actual = await vi.importActual("@/lib/audio");
  return {
    ...actual,
    decodeFileFully: vi.fn(async () => ({
      metadata: { durationSec: 1 },
      pcm: new Float32Array(16000),
      sampleRate: 16000,
    })),
    probeAudioMetadata: vi.fn(async () => ({ durationSec: 1 })),
  };
});

vi.mock("@/lib/preprocessing", async () => {
  const actual = await vi.importActual("@/lib/preprocessing");
  return {
    ...actual,
    estimateNoiseProfileWithVad: vi.fn(() => ({
      profile: new Float32Array(513),
      frames: 10,
      vadUsed: true,
      silenceRanges: 1,
    })),
    preprocessDecodedAudio: vi.fn(async (decoded: { pcm: Float32Array; sampleRate: number }) => ({
      pcm: decoded.pcm,
      sampleRate: decoded.sampleRate,
      noiseProfile: new Float32Array(513),
    })),
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

vi.mock("@/lib/asr", async () => {
  return {
    createAsrPipeline: vi.fn(async () => ({
      pipeline: {} as unknown as import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline,
      backend: "wasm",
      modelId: "X",
    })),
    disposePipeline: vi.fn(async () => {}),
    transcribeChunk: vi.fn(() => transcribeDeferred.promise),
    isModelTooLargeError: vi.fn(() => false),
  };
});

vi.mock("@/lib/chunking", async () => ({
  buildChunks: vi.fn(() => [{ id: "c1", start: 0, end: 1, paddedStart: 0, paddedEnd: 1, index: 0 }]),
}));

import { useTranscriptionController } from "./useTranscriptionController";

describe("useTranscriptionController abort", () => {
  beforeEach(() => {
    transcribeDeferred = createDeferred();
    useAsrStore.setState({
      memoryMode: "full",
      preprocessingMode: "quick",
      segmentationMode: "chunks",
      autoTunePreprocess: false,
      stopRequested: false,
      isTranscribing: false,
      segments: [],
      progress: 0,
      status: "idle",
    } as unknown as Partial<ReturnType<typeof useAsrStore.getState>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAsrStore.setState({
      stopRequested: false,
      isTranscribing: false,
      segments: [],
      progress: 0,
      status: "idle",
    } as unknown as Partial<ReturnType<typeof useAsrStore.getState>>);
  });

  it("ignores late chunks after abort to avoid leaking segments between runs", async () => {
    let startUpload: ((file: File) => Promise<void>) | null = null;
    let abortRun: (() => void) | null = null;

    function TestComp({ onReady }: { onReady: (startFn: (file: File) => Promise<void>, abortFn: () => void) => void }) {
      const controller = useTranscriptionController();
      onReady(controller.startUploadTranscription, controller.abortTranscription);
      return null;
    }

    await act(async () => {
      render(<TestComp onReady={(startFn, abortFn) => { startUpload = startFn; abortRun = abortFn; }} />);
    });

    const file = new File([new ArrayBuffer(8)], "test.wav", { type: "audio/wav" });
    if (!startUpload || !abortRun) throw new Error("transcription handlers not obtained");

    let startPromise: Promise<void>;
    await act(async () => {
      startPromise = startUpload!(file);
    });
    await waitFor(() => {
      expect(useAsrStore.getState().isTranscribing).toBe(true);
    });

    await act(async () => {
      abortRun!();
    });

    await act(async () => {
      transcribeDeferred.resolve({
        chunk: { id: "c1", start: 0, end: 1, paddedStart: 0, paddedEnd: 1, index: 0 },
        text: "hello",
        segments: [],
        processingMs: 1,
        realtimeFactor: 1,
      });
    });

    await act(async () => {
      await startPromise!;
    });
    expect(useAsrStore.getState().segments).toHaveLength(0);
  });
});
