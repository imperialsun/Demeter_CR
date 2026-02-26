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
  MISTRAL_MAX_UPLOAD_BYTES: 500 * 1024 * 1024,
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
      hfApiToken: "",
      mistralApiKey: "",
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
      expect(api.statusDetail).toBe("Mistral API (401): Unauthorized");
    });
    expect(api.status).not.toBe("done");
    expect(mocks.toast).toHaveBeenCalledWith("Échec de la transcription cloud : Mistral API (401): Unauthorized");
  });

  it("completes a whisper transcription run with chunked segments", async () => {
    useAsrStore.setState({
      hfApiToken: "hf_token",
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
    const whisperHeader = useAsrStore.getState().runExportHeaders.cloud;
    expect(whisperHeader?.mode).toBe("cloud");
    expect(whisperHeader?.settings.cloud).toMatchObject({
      provider: "whisper",
      model: "openai/whisper-large-v3-turbo",
      includeWordTimestamps: true,
      chunkDurationSec: 5,
      overlapSec: 0,
    });
    expect(whisperHeader?.settings.cloud).not.toHaveProperty("mistralDiarizationRequested");
  });

  it("completes a mistral transcription run and forwards diarization", async () => {
    useAsrStore.setState({
      mistralApiKey: "mistral_secret",
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
    mocks.transcribeWithMistral.mockImplementation(async (args: Record<string, unknown>) => {
      const callback = args.onDiarizationResolved as
        | ((value: { requestedDiarize: boolean; effectiveDiarize: boolean; fallbackApplied: boolean }) => void)
        | undefined;
      callback?.({
        requestedDiarize: true,
        effectiveDiarize: false,
        fallbackApplied: true,
      });
      return { text: "ok" };
    });

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
    const mistralHeader = useAsrStore.getState().runExportHeaders.cloud;
    expect(mistralHeader?.mode).toBe("cloud");
    expect(mistralHeader?.settings.cloud).toMatchObject({
      provider: "mistral",
      apiUrl: "https://mistral.example.com",
      model: "voxtral-mini-latest",
      mistralDiarizationRequested: true,
      mistralDiarizationEffective: false,
    });
    expect(Number((mistralHeader?.settings.cloud as Record<string, unknown>)?.mistralDiarizationFallbackChunks ?? 0)).toBeGreaterThan(0);
    expect(mistralHeader?.settings.cloud).not.toHaveProperty("maxTokens");
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

  it("sets error status when metadata probing fails on file selection", async () => {
    mocks.probeAudioMetadata.mockRejectedValueOnce(new Error("metadata fail"));
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "broken.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });

    await waitFor(() => {
      expect(api.status).toBe("error");
      expect(api.statusDetail).toBe("Impossible de lire les métadonnées audio");
    });
  });

  it("handles stop on non-gradio providers without calling /set_stop_flag", async () => {
    useAsrStore.setState({
      hfApiToken: "hf_token",
      cloudWhisperChunkDurationSec: 10,
      cloudWhisperOverlapSec: 0,
    } as never);
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 20, sampleRate: 16000 });

    let releasePreprocess!: () => void;
    mocks.preprocessCloudAudio.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releasePreprocess = () =>
            resolve({
              processed: { pcm: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
              tune: null,
            });
        })
    );

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="whisper" onReady={(value) => (api = value)} />);
    await waitFor(() => {
      expect(api).toBeDefined();
    });
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = api.startTranscription();
    });

    await waitFor(() => {
      expect(api.isTranscribing).toBe(true);
    });

    await act(async () => {
      await api.stopTranscription();
    });

    releasePreprocess();
    await startPromise;
    expect(mocks.gradioClient.predict).not.toHaveBeenCalledWith("/set_stop_flag", {});
  });

  it("handles stop flag failure and ends in idle/Arrêté after abort", async () => {
    let resolveSubmit!: (value: { data: unknown[]; progressSeen: boolean }) => void;
    mocks.submitWithProgress.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveSubmit = resolve;
        })
    );
    mocks.gradioClient.predict.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/set_stop_flag") {
        throw new Error("stop flag failed");
      }
      if (endpoint === "/update_media_preview") {
        return { data: [null, null] };
      }
      return { data: [] };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    await waitFor(() => {
      expect(api).toBeDefined();
    });
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = api.startTranscription();
    });

    await waitFor(() => {
      expect(api.isTranscribing).toBe(true);
    });

    await act(async () => {
      await api.stopTranscription();
    });

    resolveSubmit({
      data: ["Texte", null, null, null],
      progressSeen: false,
    });
    await startPromise;

    await waitFor(() => {
      expect(api.status).toBe("idle");
      expect(api.statusDetail).toBe("Arrêté");
      expect(api.progress).toBe(0);
    });
    expect(mocks.gradioClient.predict).toHaveBeenCalledWith("/set_stop_flag", {});
  });

  it.skip("resets session while a run is active", async () => {
    let releasePreprocess!: () => void;
    mocks.preprocessCloudAudio.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          releasePreprocess = () =>
            resolve({
              processed: { pcm: new Float32Array([0.1, 0.2]), sampleRate: 16000 },
              tune: null,
            });
        })
    );

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    await waitFor(() => {
      expect(api).toBeDefined();
    });
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = api.startTranscription();
    });

    await waitFor(() => {
      expect(api.isTranscribing).toBe(true);
    });

    const resetPromise = api.resetTranscriptionSession();
    releasePreprocess();
    await act(async () => {
      await resetPromise;
    });

    await startPromise;

    expect(api.selectedFile).toBeNull();
    expect(api.previewFile).toBeNull();
    expect(api.segments).toEqual([]);
    expect(api.status).toBe("idle");
    expect(api.statusDetail).toBe("Session réinitialisée");
    expect(api.isResettingSession).toBe(false);
  });

  it("continues transcription when preview update fails", async () => {
    mocks.gradioClient.predict.mockImplementation(async (endpoint: string) => {
      if (endpoint === "/update_media_preview") {
        throw new Error("preview failed");
      }
      return { data: [] };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    await waitFor(() => {
      expect(api).toBeDefined();
    });
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
  });

  it("handles queue pending and progress callbacks from submitWithProgress", async () => {
    let releaseSubmit!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSubmit = resolve;
    });
    mocks.submitWithProgress.mockImplementationOnce(async (_client, _endpoint, _payload, options) => {
      options.onStatus({
        stage: "pending",
        queue: true,
        position: 2,
        size: 5,
      });
      options.onProgress({
        progress: 0.5,
        desc: "Serveur en cours",
        eta: 3,
      });
      await gate;
      return { data: ["Texte", null, null, null], progressSeen: true };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="gradio" onReady={(value) => (api = value)} />);
    await waitFor(() => {
      expect(api).toBeDefined();
    });
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    let startPromise!: Promise<void>;
    await act(async () => {
      startPromise = api.startTranscription();
    });

    await waitFor(() => {
      expect(
        api.statusDetail?.includes("En file d'attente") || api.statusDetail?.includes("Serveur en cours")
      ).toBe(true);
      expect(api.progress).toBeGreaterThan(0.6);
    });

    releaseSubmit();
    await startPromise;
    await waitFor(() => {
      expect(api.status).toBe("done");
    });
  });
});
