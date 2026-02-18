import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { useAsrStore } from "@/store/asr-store";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";

const mocks = vi.hoisted(() => {
  const gradioClient = {
    predict: vi.fn(async () => ({ data: [null, null] })),
  };
  return {
    toast: vi.fn(),
    probeAudioMetadata: vi.fn(async () => ({ durationSec: 10, sampleRate: 16000 })),
    encodeWavBuffer: vi.fn(() => new ArrayBuffer(8)),
    preprocessCloudAudio: vi.fn(async () => ({
      processed: { pcm: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
      tune: null,
    })),
    getGradioClient: vi.fn(async () => gradioClient),
    gradioClient,
    uploadCloudFile: vi.fn(async () => "/tmp/uploaded.wav"),
    normalizeFileData: vi.fn((value: unknown) => value),
    submitWithProgress: vi.fn(async () => ({
      data: ["Texte", null, null, "1\n00:00:00,000 --> 00:00:01,000\nBonjour"],
      progressSeen: true,
    })),
    parseSrtToSegments: vi.fn(() => [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        chunkId: "cloud",
        strategy: "chunks",
      },
    ]),
    summarizeSegments: vi.fn((segments: Array<unknown>) => ({
      count: segments.length,
      totalDurationSec: 1,
      textChars: 7,
      tokenCount: 1,
    })),
    buildBatchPlan: vi.fn(() => [{ index: 0, start: 0, end: 10 }]),
    offsetSegments: vi.fn((segments: Array<Record<string, unknown>>) => segments),
    makeSafeFilename: vi.fn((value: string) => value),
    getWhisperClient: vi.fn(async () => ({
      automaticSpeechRecognition: vi.fn(async () => ({ text: "ok" })),
    })),
    buildWhisperParameters: vi.fn(() => ({})),
    parseWhisperOutput: vi.fn(() => []),
    transcribeWithMistral: vi.fn(async () => ({ text: "ok" })),
    parseMistralOutput: vi.fn(() => []),
    extractSegmentBlob: vi.fn(async () => ({
      blob: new Blob(["a"], { type: "audio/wav" }),
      mimeType: "audio/wav",
      name: "segment.wav",
    })),
  };
});

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/audio", () => ({
  probeAudioMetadata: mocks.probeAudioMetadata,
  encodeWavBuffer: mocks.encodeWavBuffer,
}));

vi.mock("@/lib/cloud/preprocessCloudAudio", () => ({
  preprocessCloudAudio: mocks.preprocessCloudAudio,
}));

vi.mock("@/lib/cloud/gradioClient", () => ({
  getGradioClient: mocks.getGradioClient,
}));

vi.mock("@/lib/cloud/fileUpload", () => ({
  uploadCloudFile: mocks.uploadCloudFile,
  makeSafeFilename: mocks.makeSafeFilename,
}));

vi.mock("@/lib/cloud/fileData", () => ({
  normalizeFileData: mocks.normalizeFileData,
}));

vi.mock("@/lib/cloud/gradioSubmit", () => ({
  submitWithProgress: mocks.submitWithProgress,
}));

vi.mock("@/lib/cloud/parseSrt", () => ({
  parseSrtToSegments: mocks.parseSrtToSegments,
}));

vi.mock("@/lib/cloud/segmentSummary", () => ({
  summarizeSegments: mocks.summarizeSegments,
}));

vi.mock("@/lib/cloud/batchPlan", () => ({
  DEFAULT_BATCH_DURATION_SEC: 60,
  buildBatchPlan: mocks.buildBatchPlan,
}));

vi.mock("@/lib/cloud/segmentOffsets", () => ({
  offsetSegments: mocks.offsetSegments,
}));

vi.mock("@/lib/cloud/segmentExtraction", () => ({
  extractSegmentBlob: mocks.extractSegmentBlob,
}));

vi.mock("@/lib/cloud/whisperClient", () => ({
  getWhisperClient: mocks.getWhisperClient,
}));

vi.mock("@/lib/cloud/whisperParams", () => ({
  buildWhisperParameters: mocks.buildWhisperParameters,
}));

vi.mock("@/lib/cloud/whisperSegments", () => ({
  parseWhisperOutput: mocks.parseWhisperOutput,
}));

vi.mock("@/lib/cloud/mistralClient", () => ({
  transcribeWithMistral: mocks.transcribeWithMistral,
}));

vi.mock("@/lib/cloud/mistralSegments", () => ({
  parseMistralOutput: mocks.parseMistralOutput,
}));

function HookHarness({
  provider,
  onReady,
}: {
  provider: "gradio" | "whisper" | "mistral";
  onReady: (api: ReturnType<typeof useCloudTranscription>) => void;
}) {
  const api = useCloudTranscription(provider);
  useEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

describe("useCloudTranscription", () => {
  beforeEach(() => {
    useAsrStore.getState().resetApp();
    useAsrStore.setState({
      cloudApiUrl: "https://api.example.com",
      cloudHfToken: "",
      cloudMistralApiKey: "",
      cloudMistralApiUrl: "https://mistral.example.com",
      cloudMistralModel: "voxtral-mini-latest",
      cloudMistralDiarizationEnabled: true,
    } as never);
    vi.clearAllMocks();
  });

  it("shows toast when transcription starts without selected file", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);

    await act(async () => {
      await api.startTranscription();
    });

    expect(mocks.toast).toHaveBeenCalledWith("Sélectionnez un fichier audio avant de lancer.");
  });

  it("completes a gradio transcription run", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.segments.length).toBeGreaterThan(0);
    });
  });

  it("fails whisper run when token is missing", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="whisper" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("error");
      expect(api.statusDetail).toContain("Token Hugging Face manquant");
    });
  });

  it("fails mistral run when API token is missing", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="mistral" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("error");
      expect(api.statusDetail).toContain("Token API Mistral manquant");
    });
  });

  it("completes a whisper transcription run with chunked segments", async () => {
    useAsrStore.setState({
      cloudHfToken: "hf_token",
      cloudWhisperChunkDurationSec: 5,
      cloudWhisperOverlapSec: 0,
      cloudEnableWordTimestamps: true,
    } as never);
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 12, sampleRate: 16000 });
    mocks.parseWhisperOutput.mockImplementation((_output, args) => [
      {
        index: args.startIndex,
        start: args.offsetSec,
        end: args.offsetSec + 1,
        text: `whisper-${args.startIndex}`,
        chunkId: args.chunkId,
        strategy: "chunks",
      },
    ]);

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="whisper" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.segments.length).toBeGreaterThan(1);
    });
    expect(mocks.getWhisperClient).toHaveBeenCalledWith("hf_token", expect.any(Object));
    expect(mocks.buildWhisperParameters).toHaveBeenCalled();
    expect(mocks.parseWhisperOutput).toHaveBeenCalled();
  });

  it("completes a mistral transcription run and forwards diarization", async () => {
    useAsrStore.setState({
      cloudMistralApiKey: "mistral_secret",
      cloudMistralApiUrl: "https://mistral.example.com",
      cloudMistralModel: "voxtral-mini-latest",
      cloudMistralChunkDurationSec: 5,
      cloudMistralOverlapSec: 0,
      cloudEnableWordTimestamps: true,
      cloudMistralDiarizationEnabled: true,
    } as never);
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 11, sampleRate: 16000 });
    mocks.parseMistralOutput.mockImplementation((_output, args) => [
      {
        index: args.startIndex,
        start: args.offsetSec,
        end: args.offsetSec + 1,
        text: `mistral-${args.startIndex}`,
        chunkId: args.chunkId,
        strategy: "chunks",
      },
    ]);

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="mistral" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.segments.length).toBeGreaterThan(0);
    });
    expect(mocks.transcribeWithMistral).toHaveBeenCalled();
    expect(mocks.transcribeWithMistral.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        diarize: true,
        apiKey: "mistral_secret",
      })
    );
  });

  it("completes a progressive gradio run with multi-batch fallback text", async () => {
    mocks.buildBatchPlan.mockReturnValueOnce([
      { index: 0, start: 0, end: 6 },
      { index: 1, start: 6, end: 12 },
    ]);
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 12, sampleRate: 16000 });
    mocks.submitWithProgress
      .mockResolvedValueOnce({
        data: ["Premier batch texte", null, null, null],
        progressSeen: false,
      })
      .mockResolvedValueOnce({
        data: [null, null, null, "1\n00:00:00,000 --> 00:00:01,000\nBatch 2"],
        progressSeen: true,
      });
    mocks.parseSrtToSegments.mockReturnValue([
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Batch 2",
        chunkId: "cloud",
        strategy: "chunks",
      },
    ]);

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.segments.length).toBeGreaterThan(1);
    });
    expect(mocks.extractSegmentBlob).toHaveBeenCalled();
    expect(mocks.submitWithProgress).toHaveBeenCalledTimes(2);
  });
});
