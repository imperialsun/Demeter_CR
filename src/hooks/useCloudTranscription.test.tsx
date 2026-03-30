import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";

import { useAsrStore } from "@/store/asr-store";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  probeAudioMetadata: vi.fn(async () => ({ durationSec: 10, sampleRate: 16000 })),
  encodeWavBuffer: vi.fn(() => new ArrayBuffer(8)),
  buildFixedSegments: vi.fn(() => [{ start: 0, end: 10 }]),
  preprocessCloudAudio: vi.fn(async () => ({
    processed: { pcm: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
    tune: null,
  })),
  summarizeSegments: vi.fn((segments: Array<unknown>) => ({
    count: segments.length,
    totalDurationSec: 10,
    textChars: 7,
    tokenCount: 2,
  })),
  extractSegmentBlob: vi.fn(async () => ({
    blob: new Blob(["a"], { type: "audio/wav" }),
    mimeType: "audio/wav",
    name: "segment.wav",
  })),
  getWhisperClient: vi.fn(async () => ({
    automaticSpeechRecognition: vi.fn(async () => ({ text: "ok" })),
  })),
  buildWhisperParameters: vi.fn(() => ({})),
  parseWhisperOutput: vi.fn(() => [
    {
      index: 0,
      start: 0,
      end: 1,
      text: "Bonjour",
      chunkId: "whisper-1",
      strategy: "chunks",
    },
  ]),
  transcribeWithMistral: vi.fn(async () => ({ text: "ok" })),
  transcribeWithDemeterSante: vi.fn(async () => ({ text: "ok" })),
  parseMistralOutput: vi.fn(() => [
    {
      index: 0,
      start: 0,
      end: 1,
      text: "Bonjour",
      chunkId: "mistral-1",
      strategy: "chunks",
      speaker: "SPEAKER_00",
    },
  ]),
  trackBackendActivityEvent: vi.fn(),
  releaseFfmpeg: vi.fn(async () => {}),
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/audio", () => ({
  probeAudioMetadata: mocks.probeAudioMetadata,
  encodeWavBuffer: mocks.encodeWavBuffer,
}));

vi.mock("@/lib/chunking", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chunking")>("@/lib/chunking");
  return {
    ...actual,
    buildFixedSegments: mocks.buildFixedSegments,
  };
});

vi.mock("@/lib/cloud/preprocessCloudAudio", () => ({
  preprocessCloudAudio: mocks.preprocessCloudAudio,
}));

vi.mock("@/lib/cloud/segmentSummary", () => ({
  summarizeSegments: mocks.summarizeSegments,
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
  MISTRAL_MAX_UPLOAD_BYTES: 500 * 1024 * 1024,
  transcribeWithMistral: mocks.transcribeWithMistral,
}));

vi.mock("@/lib/cloud/mistralSegments", () => ({
  parseMistralOutput: mocks.parseMistralOutput,
}));

vi.mock("@/lib/cloud/demeterClient", () => ({
  transcribeWithDemeterSante: mocks.transcribeWithDemeterSante,
}));

vi.mock("@/lib/backend-activity-sync", () => ({
  trackBackendActivityEvent: mocks.trackBackendActivityEvent,
}));

vi.mock("@/lib/ffmpeg-loader", () => ({
  releaseFfmpeg: mocks.releaseFfmpeg,
}));

function HookHarness({
  provider,
  onReady,
}: {
  provider: "whisper" | "mistral" | "demeter_sante";
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
      hfApiToken: "",
      mistralApiKey: "",
      cloudMistralApiUrl: "https://mistral.example.com",
      cloudMistralModel: "voxtral-mistral-latest",
      cloudMistralDiarizationEnabled: true,
      cloudDemeterModel: "voxtral-demeter-latest",
      cloudDemeterDiarizationEnabled: false,
    } as never);
    vi.clearAllMocks();
  });

  it("shows toast when transcription starts without selected file", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="whisper" onReady={(value) => (api = value)} />);

    await act(async () => {
      await api.startTranscription();
    });

    expect(mocks.toast).toHaveBeenCalledWith("Sélectionnez un fichier audio avant de lancer.");
  });

  it("completes a whisper transcription run", async () => {
    useAsrStore.setState({ hfApiToken: "hf_token" } as never);

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
      expect(api.segments.length).toBeGreaterThan(0);
    });
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.provider).toBe("whisper");
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.segmentCount).toBe(api.segments.length);
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Bonjour");
    expect((useAsrStore.getState().sessionTranscriptMemories.cloud as any)?.segments).toBeUndefined();
    expect(useAsrStore.getState().telemetryCollector).toBeNull();
    expect(mocks.releaseFfmpeg).toHaveBeenCalledTimes(1);
  });

  it("updates cloud session memory when a segment text is edited", async () => {
    useAsrStore.setState({ hfApiToken: "hf_token" } as never);

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
      expect(api.segments[0]?.text).toBe("Bonjour");
    });

    await act(async () => {
      api.updateSegmentText(0, "Bonjour modifié");
    });

    await waitFor(() => {
      expect(api.segments[0]?.text).toBe("Bonjour modifié");
      expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Bonjour modifié");
    });
  });

  it("clears the shared cloud transcript memory on session reset", async () => {
    useAsrStore.setState({ hfApiToken: "hf_token" } as never);

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
      expect(useAsrStore.getState().sessionTranscriptMemories.cloud).not.toBeNull();
    });

    await act(async () => {
      await api.resetTranscriptionSession();
    });

    expect(useAsrStore.getState().sessionTranscriptMemories.cloud).toBeNull();
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

  it("surfaces mistral api errors to status detail and toast", async () => {
    useAsrStore.setState({
      mistralApiKey: "mistral_secret",
      cloudMistralApiUrl: "https://mistral.example.com",
      cloudMistralModel: "voxtral-mini-latest",
    } as never);
    mocks.transcribeWithMistral.mockRejectedValueOnce(new Error("Mistral API (401): Unauthorized"));

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
      expect(api.statusDetail).toContain("Mistral API (401): Unauthorized");
    });
    expect(mocks.transcribeWithMistral).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "voxtral-mini-latest",
        diarize: true,
      }),
      expect.anything()
    );
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.stringContaining("Échec de la transcription cloud : Mistral API (401): Unauthorized")
    );
  });

  it("splits mistral uploads using the configured duration plan", async () => {
    useAsrStore.setState({
      mistralApiKey: "mistral_secret",
      cloudMistralApiUrl: "https://mistral.example.com",
      cloudMistralModel: "voxtral-mini-latest",
      cloudMistralChunkDurationSec: 5,
      cloudMistralOverlapSec: 1,
    } as never);
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 11, sampleRate: 16000 });
    mocks.buildFixedSegments.mockReturnValueOnce([
      { start: 0, end: 5 },
      { start: 4, end: 9 },
      { start: 8, end: 11 },
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
    });
    expect(mocks.buildFixedSegments).toHaveBeenCalledWith({
      durationSec: 11,
      segmentDurationSec: 5,
      overlapSec: 1,
    });
    expect(mocks.transcribeWithMistral).toHaveBeenCalledTimes(3);
  });

  it("completes a demeter sante transcription run", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.segments[0]?.speaker).toBe("SPEAKER_00");
    });
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledWith(
      expect.objectContaining({
        diarize: false,
      }),
      expect.anything()
    );
  });

  it("splits demeter chunks and retries after an upstream timeout", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 10, sampleRate: 16000 });
    mocks.buildFixedSegments.mockReturnValueOnce([{ start: 0, end: 10 }]);
    mocks.transcribeWithDemeterSante
      .mockRejectedValueOnce(new Error("The upstream server is timing out"))
      .mockResolvedValue({ text: "ok" });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
    });
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(3);
    expect(mocks.extractSegmentBlob).toHaveBeenCalled();
  });
});
