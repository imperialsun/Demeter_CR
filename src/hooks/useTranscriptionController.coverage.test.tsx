/* eslint-disable @typescript-eslint/no-explicit-any */
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAsrStore } from "@/store/asr-store";

const mocks = vi.hoisted(() => {
  const state = {
    metadataDurationSec: 120,
  };
  return {
    state,
    toast: vi.fn(),
    decodeFileFully: vi.fn(async () => ({
      metadata: { durationSec: state.metadataDurationSec, sampleRate: 16000, channels: 1 },
      pcm: new Float32Array(32000).fill(0.1),
      sampleRate: 16000,
    })),
    probeAudioMetadata: vi.fn(async () => ({
      durationSec: state.metadataDurationSec,
      sampleRate: 16000,
    })),
    decodeCompressedBlobToPcm: vi.fn(async () => ({
      metadata: { durationSec: 60, sampleRate: 16000 },
      pcm: new Float32Array(16000).fill(0.05),
      sampleRate: 16000,
    })),
    preprocessDecodedAudio: vi.fn(async (decoded: { pcm: Float32Array; sampleRate: number }) => ({
      pcm: decoded.pcm,
      sampleRate: decoded.sampleRate,
      noiseProfile: new Float32Array(16),
    })),
    estimateNoiseProfileWithVad: vi.fn(() => ({
      profile: new Float32Array(16),
      frames: 4,
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
      lowpassHz: 7000,
      limiterThresholdDb: -1,
      limiterSoftness: 0.7,
      vadThresholdDb: -40,
      overlapBlockSec: 1.1,
      overlapSec: 0.2,
    })),
    buildChunks: vi.fn(() => [{ id: "c-0", index: 0, start: 0, end: 1, paddedStart: 0, paddedEnd: 1 }]),
    buildFixedSegments: vi.fn(() => [{ index: 0, start: 0, end: 60 }]),
    offsetChunks: vi.fn((chunks: Array<Record<string, unknown>>) =>
      chunks.map((chunk, index) => ({
        ...chunk,
        index,
      }))
    ),
    createSegmentCache: vi.fn(async () => ({ completed: 1, total: 1, aborted: false })),
    getSegment: vi.fn(async () => ({ blob: new Blob(["a"], { type: "audio/webm" }) })),
    deleteSegment: vi.fn(async () => {}),
    deleteSessionSegments: vi.fn(async () => {}),
    createAsrPipeline: vi.fn(async (args?: { onStatus?: (status: string, detail?: string) => void }) => {
      args?.onStatus?.("transcribing", "Pipeline prêt");
      return {
        pipeline: {} as unknown as import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline,
        backend: "wasm",
        modelId: "mock-model",
      };
    }),
    transcribeChunk: vi.fn(async ({ chunk }: { chunk: { id: string; index: number; start: number; end: number } }) => ({
      chunk,
      text: `text-${chunk.index}`,
      segments: [
        {
          text: `text-${chunk.index}`,
          start: chunk.start,
          end: chunk.end,
          confidence: 0.8,
        },
      ],
      processingMs: 5,
      realtimeFactor: 1,
    })),
    disposePipeline: vi.fn(async () => {}),
    isModelTooLargeError: vi.fn(() => false),
  };
});

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/asr", () => ({
  createAsrPipeline: mocks.createAsrPipeline,
  disposePipeline: mocks.disposePipeline,
  transcribeChunk: mocks.transcribeChunk,
  isModelTooLargeError: mocks.isModelTooLargeError,
}));

vi.mock("@/lib/audio", async () => {
  const actual = await vi.importActual("@/lib/audio");
  return {
    ...actual,
    decodeFileFully: mocks.decodeFileFully,
    probeAudioMetadata: mocks.probeAudioMetadata,
    decodeCompressedBlobToPcm: mocks.decodeCompressedBlobToPcm,
  };
});

vi.mock("@/lib/preprocessing", async () => {
  const actual = await vi.importActual("@/lib/preprocessing");
  return {
    ...actual,
    preprocessDecodedAudio: mocks.preprocessDecodedAudio,
    estimateNoiseProfileWithVad: mocks.estimateNoiseProfileWithVad,
    computePreprocessParams: mocks.computePreprocessParams,
  };
});

vi.mock("@/lib/chunking", async () => {
  const actual = await vi.importActual("@/lib/chunking");
  return {
    ...actual,
    buildChunks: mocks.buildChunks,
    buildFixedSegments: mocks.buildFixedSegments,
    offsetChunks: mocks.offsetChunks,
  };
});

vi.mock("@/lib/segmenter", () => ({
  createSegmentCache: mocks.createSegmentCache,
}));

vi.mock("@/lib/segment-cache", () => ({
  getSegment: mocks.getSegment,
  deleteSegment: mocks.deleteSegment,
  deleteSessionSegments: mocks.deleteSessionSegments,
}));

import {
  setSharedAbortController,
  useTranscriptionController,
} from "@/hooks/useTranscriptionController";

function HookHarness({ onReady }: { onReady: (api: ReturnType<typeof useTranscriptionController>) => void }) {
  const api = useTranscriptionController();
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

describe("useTranscriptionController coverage", () => {
  beforeEach(() => {
    useAsrStore.getState().resetApp();
    useAsrStore.setState({
      memoryMode: "full",
      preprocessingMode: "quick",
      chunkStrategy: "fixed",
      chunkDurationSec: 15,
      overlapSec: 1,
      segmentationMode: "chunks",
      stopRequested: false,
      isTranscribing: false,
      segments: [],
      chunkPlan: [],
      chunkMetrics: [],
      status: "idle",
      activePreset: "balanced",
      blockedPresets: [],
      autoTunePreprocess: true,
      noiseCalibrationRequestedAt: Date.now(),
    } as any);
    mocks.state.metadataDurationSec = 120;
    vi.clearAllMocks();
    setSharedAbortController(null);
  });

  it("runs a successful full-memory upload transcription and exports telemetry summary", async () => {
    let api!: ReturnType<typeof useTranscriptionController>;
    render(<HookHarness onReady={(value) => (api = value)} />);
    const file = new File([new Uint8Array([1, 2, 3])], "demo.wav", { type: "audio/wav" });

    await act(async () => {
      await api.startUploadTranscription(file);
    });

    await waitFor(() => {
      expect(useAsrStore.getState().status).toBe("ready");
      expect(useAsrStore.getState().segments.length).toBeGreaterThan(0);
    });
    expect(mocks.decodeFileFully).toHaveBeenCalled();
    expect(mocks.createAsrPipeline).toHaveBeenCalled();
    expect(useAsrStore.getState().telemetrySummary).not.toBeNull();
  });

  it("runs progressive mode with segment cache and compressed segment decode", async () => {
    useAsrStore.setState({
      memoryMode: "progressive",
      preprocessingMode: "full",
      audioMetadata: { durationSec: 120, sampleRate: 16000 },
    } as any);

    let api!: ReturnType<typeof useTranscriptionController>;
    render(<HookHarness onReady={(value) => (api = value)} />);
    const file = new File([new Uint8Array([1, 2, 3])], "progressive.wav", { type: "audio/wav" });

    await act(async () => {
      await api.startUploadTranscription(file);
    });

    await waitFor(() => {
      expect(useAsrStore.getState().status).toBe("ready");
    });
    expect(mocks.createSegmentCache).toHaveBeenCalled();
    expect(mocks.getSegment).toHaveBeenCalled();
    expect(mocks.decodeCompressedBlobToPcm).toHaveBeenCalled();
  });

  it("auto-switches to progressive mode for long files (>15 minutes)", async () => {
    mocks.state.metadataDurationSec = 1001;
    useAsrStore.setState({
      memoryMode: "full",
      preprocessingMode: "off",
    } as any);

    let api!: ReturnType<typeof useTranscriptionController>;
    render(<HookHarness onReady={(value) => (api = value)} />);
    const file = new File([new Uint8Array([1])], "long.wav", { type: "audio/wav" });

    await act(async () => {
      await api.startUploadTranscription(file);
    });

    expect(useAsrStore.getState().memoryMode).toBe("progressive");
    expect(mocks.toast).toHaveBeenCalledWith("Audio > 15 min : passage automatique en mode progressif.");
  });

  it("marks status as stopping when stopTranscription is requested", async () => {
    useAsrStore.setState({
      isTranscribing: true,
      status: "transcribing",
    } as any);

    let api!: ReturnType<typeof useTranscriptionController>;
    render(<HookHarness onReady={(value) => (api = value)} />);

    act(() => {
      api.stopTranscription();
    });

    expect(useAsrStore.getState().stopRequested).toBe(true);
    expect(useAsrStore.getState().status).toBe("stopping");
  });

  it("aborts immediately when abortTranscription(waitForStop=false) is used", async () => {
    useAsrStore.setState({
      isTranscribing: true,
      stopRequested: true,
      status: "transcribing",
    } as any);
    setSharedAbortController(new AbortController());

    let api!: ReturnType<typeof useTranscriptionController>;
    render(<HookHarness onReady={(value) => (api = value)} />);

    act(() => {
      api.abortTranscription({ waitForStop: false });
    });

    expect(useAsrStore.getState().isTranscribing).toBe(false);
    expect(useAsrStore.getState().stopRequested).toBe(false);
  });
});
