import { act, render, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLayoutEffect } from "react";
import { IDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";

import { useAsrStore } from "@/store/asr-store";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import type { StageCloudSegmentsOptions } from "@/lib/cloud/cloudStaging";
import { BackendHttpError } from "@/lib/backend-api";
import { clearAllCloudTranscriptCache } from "@/lib/cloud/cloudTranscriptCache";
import { BACKGROUND_RESUME_MESSAGE } from "@/lib/transcriptionVisibility";

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  probeAudioMetadata: vi.fn(async () => ({ durationSec: 10, sampleRate: 16000 })),
  buildFixedSegments: vi.fn(() => [{ start: 0, end: 10 }]),
  stagedSegments: new Map<number, {
    key: string;
    sessionId: string;
    index: number;
    startSec: number;
    endSec: number;
    blob: Blob;
    name: string;
    rawBlob: Blob;
    rawName: string;
    rawMimeType: string;
  }>(),
  stageCloudSegments: vi.fn(async ({ segments, startIndex = 0, sessionId }: StageCloudSegmentsOptions) => {
    let nextIndex = startIndex;
    const stagedSegments = segments.map((segment) => {
      const index = nextIndex++;
      const record = {
        key: `${sessionId}:${index}`,
        sessionId,
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        fileName: `segment_${index}-cloud.wav`,
        mimeType: "audio/wav",
        sizeBytes: 1024,
      };
      mocks.stagedSegments.set(index, {
        key: record.key,
        sessionId,
        index,
        startSec: segment.startSec,
        endSec: segment.endSec,
        blob: new Blob([`segment-${index}`], { type: "audio/wav" }),
        name: record.fileName,
        rawBlob: new Blob([`raw-segment-${index}`], { type: "audio/webm" }),
        rawName: `segment_${index}.webm`,
        rawMimeType: "audio/webm",
      });
      return record;
    });
    return { stagedSegments, nextIndex, aborted: false, tune: null };
  }),
  summarizeSegments: vi.fn((segments: Array<unknown>) => ({
    count: segments.length,
    totalDurationSec: 10,
    textChars: 7,
    tokenCount: 2,
  })),
  getSegment: vi.fn(async (sessionId: string, index: number) => {
    void sessionId;
    return mocks.stagedSegments.get(index) ?? null;
  }),
  deleteSegment: vi.fn(async (sessionId: string, index: number) => {
    void sessionId;
    mocks.stagedSegments.delete(index);
  }),
  deleteSessionSegments: vi.fn(async (sessionId: string) => {
    void sessionId;
    mocks.stagedSegments.clear();
  }),
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
      speaker: "SPEAKER_00",
    },
  ]),
  transcribeWithMistral: vi.fn(async () => ({ text: "ok" })),
  transcribeWithDemeterSante: vi.fn(async () => ({
    text: "Bonjour",
    chunks: [
      {
        chunkId: "demeter-default-001",
        index: 0,
        startSec: 0,
        endSec: 1,
        durationSec: 1,
        segmentCount: 1,
        text: "Bonjour",
        segments: [
          {
            index: 0,
            start: 0,
            end: 1,
            text: "Bonjour",
            speaker: "SPEAKER_00",
            chunkId: "demeter-default-001",
          },
        ],
      },
    ],
  })),
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
  sendFrontendAudioErrorReport: vi.fn(async () => true),
  trackBackendActivityEvent: vi.fn(),
  releaseFfmpeg: vi.fn(async () => {}),
  backendRefresh: vi.fn(async () => "failed" as const),
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/audio", () => ({
  probeAudioMetadata: mocks.probeAudioMetadata,
}));

vi.mock("@/lib/chunking", async () => {
  const actual = await vi.importActual<typeof import("@/lib/chunking")>("@/lib/chunking");
  return {
    ...actual,
    buildFixedSegments: mocks.buildFixedSegments,
  };
});

vi.mock("@/lib/cloud/cloudStaging", () => ({
  stageCloudSegments: mocks.stageCloudSegments,
}));

vi.mock("@/lib/cloud/segmentSummary", () => ({
  summarizeSegments: mocks.summarizeSegments,
}));

vi.mock("@/lib/segment-cache", () => ({
  getSegment: mocks.getSegment,
  deleteSegment: mocks.deleteSegment,
  deleteSessionSegments: mocks.deleteSessionSegments,
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

vi.mock("@/lib/cloud/audioErrorReport", async () => {
  const actual = await vi.importActual<typeof import("@/lib/cloud/audioErrorReport")>(
    "@/lib/cloud/audioErrorReport"
  );
  return {
    ...actual,
    sendFrontendAudioErrorReport: mocks.sendFrontendAudioErrorReport,
  };
});

vi.mock("@/lib/backend-activity-sync", () => ({
  trackBackendActivityEvent: mocks.trackBackendActivityEvent,
}));

vi.mock("@/lib/backend-auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-auth")>("@/lib/backend-auth");
  return {
    ...actual,
    backendRefresh: mocks.backendRefresh,
  };
});

vi.mock("@/lib/ffmpeg-loader", () => ({
  releaseFfmpeg: mocks.releaseFfmpeg,
}));

function HookHarness({
  provider,
  onReady,
  options,
}: {
  provider: "whisper" | "mistral" | "demeter_sante";
  onReady: (api: ReturnType<typeof useCloudTranscription>) => void;
  options?: Parameters<typeof useCloudTranscription>[1];
}) {
  const api = useCloudTranscription(provider, options);
  useLayoutEffect(() => {
    onReady(api);
  }, [api, onReady]);
  return null;
}

function installVisibilityState(state: "visible" | "hidden") {
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

  const applyState = (next: "visible" | "hidden") => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: next === "hidden",
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: next,
    });
  };

  applyState(state);

  return () => {
    if (originalHidden) {
      Object.defineProperty(document, "hidden", originalHidden);
    } else {
      Reflect.deleteProperty(document, "hidden");
    }
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useCloudTranscription", () => {
  beforeEach(async () => {
    (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = fakeIndexedDB;
    (globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange;
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
    await clearAllCloudTranscriptCache();
    mocks.stagedSegments.clear();
    vi.clearAllMocks();
    mocks.backendRefresh.mockResolvedValue("failed");
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
    expect(api.previewUrl).toBeNull();
    expect(useAsrStore.getState().audioSource).toEqual(
      expect.objectContaining({
        id: "whisper:audio.wav:1",
        label: "audio.wav",
        type: "file",
      })
    );
    expect(useAsrStore.getState().audioMetadata).toEqual(
      expect.objectContaining({
        durationSec: 10,
        sampleRate: 16000,
      })
    );
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
    });
    const exportedSegments = await api.loadAllSegmentsForExport();
    expect(exportedSegments.length).toBeGreaterThan(0);
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.provider).toBe("whisper");
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.segmentCount).toBe(exportedSegments.length);
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Bonjour");
    expect(Object.prototype.hasOwnProperty.call(useAsrStore.getState().sessionTranscriptMemories.cloud ?? {}, "segments")).toBe(false);
    expect(
      useAsrStore
        .getState()
        .telemetrySummary?.events.some((event) => event.type === "CLOUD_TRANSCRIBE_START")
    ).toBe(true);
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
    });
    const initialSegments = await api.loadChunkSegments("whisper-1");
    expect(initialSegments[0]?.text).toBe("Bonjour");

    await act(async () => {
      await api.updateSegmentText("whisper-1", 0, "Bonjour modifié");
    });

    await waitFor(() => {
      expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Bonjour modifié");
    });
    const updatedSegments = await api.loadChunkSegments("whisper-1");
    expect(updatedSegments[0]?.text).toBe("Bonjour modifié");
  });

  it("restarts the cloud run automatically after a hidden tab interruption", async () => {
    useAsrStore.setState({ mistralApiKey: "mistral_secret" } as never);

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="mistral" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    const firstDeferred = (() => {
      let resolve!: (value: { text: string }) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<{ text: string }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    })();
    const secondDeferred = (() => {
      let resolve!: (value: { text: string }) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<{ text: string }>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    })();

    const restoreVisibility = installVisibilityState("visible");
    try {
      await act(async () => {
        await api.handleFileSelected(file);
      });

      mocks.transcribeWithMistral
        .mockImplementationOnce(() => firstDeferred.promise as never)
        .mockImplementationOnce(() => secondDeferred.promise as never);

      let firstRunPromise: Promise<void>;
      await act(async () => {
        firstRunPromise = api.startTranscription();
      });

      await waitFor(() => {
        expect(api.status).toBe("transcribing");
      });

      await act(async () => {
        installVisibilityState("hidden");
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => {
        expect(api.statusDetail).toBe(BACKGROUND_RESUME_MESSAGE);
      });

      await act(async () => {
        firstDeferred.reject(new DOMException("Run aborted", "AbortError"));
      });

      await waitFor(() => {
        expect(api.status).toBe("idle");
      });

      await act(async () => {
        installVisibilityState("visible");
        document.dispatchEvent(new Event("visibilitychange"));
      });

      await waitFor(() => {
        expect(mocks.transcribeWithMistral).toHaveBeenCalledTimes(2);
      });

      await waitFor(() => {
        expect(api.isTranscribing).toBe(true);
      });

      await act(async () => {
        secondDeferred.resolve({ text: "Bonjour" });
      });

      await waitFor(() => {
        expect(api.status).toBe("done");
      });
      await waitFor(() => {
        expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Bonjour");
      });

      await act(async () => {
        await firstRunPromise!;
      });
    } finally {
      restoreVisibility();
    }
  });

  it("rebuilds cloud chunk speaker ids when a segment speaker changes", async () => {
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
      expect(api.chunkGroups[0]?.speakerIds).toEqual(["SPEAKER_00"]);
    });

    const chunkId = api.chunkGroups[0]?.chunkId;
    expect(chunkId).toBe("demeter-default-001");

    await act(async () => {
      await api.updateSegmentSpeaker(chunkId ?? "demeter-default-001", 0, "SPEAKER_01");
    });

    await waitFor(() => {
      expect(api.chunkGroups[0]?.speakerIds).toEqual(["SPEAKER_01"]);
    });
    const updatedSegments = await api.loadChunkSegments(chunkId ?? "demeter-default-001");
    expect(updatedSegments[0]?.speaker).toBe("SPEAKER_01");
  });

  it("persists cloud chunk speaker assignments with labels for exports and reports", async () => {
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
    });

    const exportedSegments = await api.loadAllSegmentsForExport();
    const chunkId = exportedSegments[0]?.chunkId ?? "whisper-1";
    const assignmentKey = `${chunkId}::SPEAKER_00`;

    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          [assignmentKey]: {
            firstName: "Alice",
            lastName: "Dupont",
          },
        },
      },
    } as never);

    await act(async () => {
      await api.applyChunkSpeakerAssignments(chunkId, {
        [assignmentKey]: {
          firstName: "Alice",
          lastName: "Dupont",
        },
      });
    });

    await waitFor(async () => {
      const updatedSegments = await api.loadChunkSegments(chunkId);
      expect(updatedSegments).toHaveLength(1);
      expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.transcriptText).toContain("Dupont Alice: Bonjour");
      expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.segmentCount).toBe(exportedSegments.length);
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

  it("keeps the shared cloud session alive across unmount and remount", async () => {
    useAsrStore.setState({ mistralApiKey: "mistral_secret" } as never);

    const transcriptionDeferred = createDeferred<{ text: string }>();
    mocks.transcribeWithMistral.mockImplementationOnce((request: { signal?: AbortSignal }) => {
      return new Promise<{ text: string }>((resolve, reject) => {
        const abortHandler = () => reject(new DOMException("Aborted", "AbortError"));
        request.signal?.addEventListener("abort", abortHandler, { once: true });
        transcriptionDeferred.promise.then(resolve, reject).finally(() => {
          request.signal?.removeEventListener("abort", abortHandler);
        });
      }) as never;
    });

    const first = renderHook(() => useCloudTranscription("mistral"));
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await first.result.current.handleFileSelected(file);
    });

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = first.result.current.startTranscription();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useAsrStore.getState().cloudTranscriptionSession.isTranscribing).toBe(true);
    });
    expect(useAsrStore.getState().cloudTranscriptionSession.selectedFile?.name).toBe("audio.wav");
    expect(useAsrStore.getState().cloudTranscriptionSession.progress).toBeGreaterThan(0);
    expect(useAsrStore.getState().cloudTranscriptionSession.preparedUpload).toEqual(
      expect.objectContaining({ provider: "mistral" })
    );

    first.unmount();

    const second = renderHook(() => useCloudTranscription("mistral"));
    expect(second.result.current.selectedFile?.name).toBe("audio.wav");
    expect(second.result.current.isTranscribing).toBe(true);
    expect(second.result.current.progress).toBeGreaterThan(0);
    expect(second.result.current.status).toBe("transcribing");

    await act(async () => {
      transcriptionDeferred.resolve({ text: "Bonjour" });
      await Promise.resolve();
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(second.result.current.status).toBe("done");
      expect(second.result.current.chunkSummaries).toHaveLength(1);
    });

    const exportedSegments = await second.result.current.loadAllSegmentsForExport();
    expect(exportedSegments).toHaveLength(1);
    expect(useAsrStore.getState().cloudTranscriptionSession.chunkSummaries).toHaveLength(1);

    await act(async () => {
      await second.result.current.resetTranscriptionSession();
    });

    expect(useAsrStore.getState().cloudTranscriptionSession.selectedFile).toBeNull();
    expect(useAsrStore.getState().cloudTranscriptionSession.chunkSummaries).toEqual([]);
  });

  it("can stop an active cloud run after remounting the hook", async () => {
    useAsrStore.setState({ mistralApiKey: "mistral_secret" } as never);

    const transcriptionDeferred = createDeferred<{ text: string }>();
    mocks.transcribeWithMistral.mockImplementationOnce((request: { signal?: AbortSignal }) => {
      return new Promise<{ text: string }>((resolve, reject) => {
        const abortHandler = () => reject(new DOMException("Aborted", "AbortError"));
        request.signal?.addEventListener("abort", abortHandler, { once: true });
        transcriptionDeferred.promise.then(resolve, reject).finally(() => {
          request.signal?.removeEventListener("abort", abortHandler);
        });
      }) as never;
    });

    const first = renderHook(() => useCloudTranscription("mistral"));
    const file = new File(["a"], "audio.wav", { type: "audio/wav" });

    await act(async () => {
      await first.result.current.handleFileSelected(file);
    });

    let runPromise!: Promise<void>;
    await act(async () => {
      runPromise = first.result.current.startTranscription();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useAsrStore.getState().cloudTranscriptionSession.isTranscribing).toBe(true);
    });

    first.unmount();

    const second = renderHook(() => useCloudTranscription("mistral"));
    await act(async () => {
      await second.result.current.stopTranscription();
    });

    await act(async () => {
      transcriptionDeferred.resolve({ text: "Bonjour" });
      await Promise.resolve();
    });

    await act(async () => {
      await runPromise;
    });

    await waitFor(() => {
      expect(second.result.current.status).toBe("idle");
      expect(useAsrStore.getState().cloudTranscriptionSession.isTranscribing).toBe(false);
      expect(useAsrStore.getState().cloudTranscriptionSession.stopRequested).toBe(false);
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
    });
    expect(mocks.stageCloudSegments).toHaveBeenCalledTimes(1);
    const exportedSegments = await api.loadAllSegmentsForExport();
    expect(exportedSegments[0]?.speaker).toBe("SPEAKER_00");
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledWith(
      expect.objectContaining({
        diarize: false,
      }),
      expect.anything()
    );
  });

  it("forces demeter backend direct in assistant mode even for short files", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(
      <HookHarness
        provider="demeter_sante"
        options={{ forceDemeterBackendDirect: true }}
        onReady={(value) => (api = value)}
      />
    );
    const file = new File(["a"], "short-audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
    });

    expect(mocks.stageCloudSegments).not.toHaveBeenCalled();
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledWith(
      expect.objectContaining({
        backendDirect: true,
        durationSec: 10,
        diarize: false,
        model: "voxtral-demeter-latest",
      }),
      expect.anything()
    );
  });

  it("routes long demeter audio directly to the backend without local staging", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 7201, sampleRate: 16000 });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "long-audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
    });

    expect(mocks.stageCloudSegments).not.toHaveBeenCalled();
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(1);
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledWith(
      expect.objectContaining({
        backendDirect: true,
        durationSec: 7201,
        diarize: false,
        model: "voxtral-demeter-latest",
      }),
      expect.anything()
    );
    expect(api.preparedUpload).toBeNull();
  });

  it("appends only unseen backend chunks from cumulative demeter snapshots", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 7201, sampleRate: 16000 });
    const firstChunk = {
      chunkId: "demeter-backend-001",
      index: 0,
      startSec: 0,
      endSec: 5,
      durationSec: 5,
      segmentCount: 2,
      text: "Premier segment A\nPremier segment B",
      segments: [
        {
          index: 0,
          start: 0,
          end: 2,
          text: "Premier segment A",
          chunkId: "demeter-backend-001",
          speaker: "SPEAKER_00",
        },
        {
          index: 1,
          start: 2,
          end: 5,
          text: "Premier segment B",
          chunkId: "demeter-backend-001",
          speaker: "SPEAKER_01",
        },
      ],
    };
    const secondChunk = {
      chunkId: "demeter-backend-002",
      index: 1,
      startSec: 5,
      endSec: 10,
      durationSec: 5,
      segmentCount: 2,
      text: "Second segment A\nSecond segment B",
      segments: [
        {
          index: 2,
          start: 5,
          end: 7,
          text: "Second segment A",
          chunkId: "demeter-backend-002",
          speaker: "SPEAKER_00",
        },
        {
          index: 3,
          start: 7,
          end: 10,
          text: "Second segment B",
          chunkId: "demeter-backend-002",
          speaker: "SPEAKER_01",
        },
      ],
    };
    mocks.transcribeWithDemeterSante.mockImplementationOnce(async (request: {
      onBackendOperationProgress?: (snapshot: unknown) => void;
    }) => {
      request.onBackendOperationProgress?.({
        operationId: "op-123",
        status: "running",
        stage: "chunk_completed",
        chunkIndex: 1,
        chunkCount: 2,
        progress: 0.5,
        response: {
          text: firstChunk.text,
          chunks: [firstChunk],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      request.onBackendOperationProgress?.({
        operationId: "op-123",
        status: "running",
        stage: "chunk_completed",
        chunkIndex: 2,
        chunkCount: 2,
        progress: 1,
        response: {
          text: `${firstChunk.text}\n${secondChunk.text}`,
          chunks: [firstChunk, secondChunk],
        },
      });
      return {
        text: `${firstChunk.text}\n${secondChunk.text}`,
        chunks: [firstChunk, secondChunk],
      };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "long-audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.chunkGroups).toHaveLength(2);
      expect(api.chunkGroups[0]?.segmentCount).toBe(2);
      expect(api.chunkGroups[1]?.segmentCount).toBe(2);
    });

    const exportedSegments = await api.loadAllSegmentsForExport();
    expect(exportedSegments.map((segment) => segment.text)).toEqual([
      "Premier segment A",
      "Premier segment B",
      "Second segment A",
      "Second segment B",
    ]);
    expect(api.chunkGroups[0]?.chunkId).toBe("demeter-backend-001");
    expect(api.chunkGroups[1]?.chunkId).toBe("demeter-backend-002");
    expect((await api.loadChunkSegments(api.chunkGroups[0]!.chunkId)).map((segment) => segment.text)).toEqual([
      "Premier segment A",
      "Premier segment B",
    ]);
    expect((await api.loadChunkSegments(api.chunkGroups[1]!.chunkId)).map((segment) => segment.text)).toEqual([
      "Second segment A",
      "Second segment B",
    ]);
    expect(mocks.parseMistralOutput).not.toHaveBeenCalled();
  });

  it("keeps chunk-specific segments inside each backend part", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 7201, sampleRate: 16000 });
    const firstChunk = [
      {
        chunkId: "demeter-backend-001",
        index: 0,
        startSec: 0,
        endSec: 5,
        durationSec: 5,
        segmentCount: 2,
        text: "Chunk 1A\nChunk 1B",
        segments: [
          {
            index: 0,
            start: 0,
            end: 2,
            text: "Chunk 1A",
            chunkId: "demeter-backend-001",
            speaker: "SPEAKER_00",
          },
          {
            index: 1,
            start: 2,
            end: 5,
            text: "Chunk 1B",
            chunkId: "demeter-backend-001",
            speaker: "SPEAKER_01",
          },
        ],
      },
      {
        chunkId: "demeter-backend-002",
        index: 1,
        startSec: 5,
        endSec: 10,
        durationSec: 5,
        segmentCount: 1,
        text: "Chunk 2",
        segments: [
          {
            index: 2,
            start: 5,
            end: 10,
            text: "Chunk 2",
            chunkId: "demeter-backend-002",
            speaker: "SPEAKER_02",
          },
        ],
      },
    ];
    mocks.transcribeWithDemeterSante.mockImplementationOnce(async (request: {
      onBackendOperationProgress?: (snapshot: unknown) => void;
    }) => {
      request.onBackendOperationProgress?.({
        operationId: "op-456",
        status: "running",
        stage: "chunk_completed",
        chunkIndex: 1,
        chunkCount: 2,
        progress: 0.5,
        response: {
          text: "Chunk 1A\nChunk 1B",
          chunks: [firstChunk[0]],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      request.onBackendOperationProgress?.({
        operationId: "op-456",
        status: "running",
        stage: "chunk_completed",
        chunkIndex: 2,
        chunkCount: 2,
        progress: 1,
        response: {
          text: "Chunk 1A\nChunk 1B\nChunk 2",
          chunks: firstChunk,
        },
      });
      return {
        text: "Chunk 1A\nChunk 1B\nChunk 2",
        chunks: firstChunk,
      };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "long-audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.chunkGroups).toHaveLength(2);
    });

    expect(api.chunkGroups[0]?.chunkId).toBe("demeter-backend-001");
    expect(api.chunkGroups[1]?.chunkId).toBe("demeter-backend-002");
    expect(api.chunkGroups[0]?.segmentCount).toBe(2);
    expect(api.chunkGroups[1]?.segmentCount).toBe(1);
    const firstChunkSegments = await api.loadChunkSegments(api.chunkGroups[0]!.chunkId);
    const secondChunkSegments = await api.loadChunkSegments(api.chunkGroups[1]!.chunkId);
    expect(firstChunkSegments.map((segment) => segment.text)).toEqual(["Chunk 1A", "Chunk 1B"]);
    expect(secondChunkSegments.map((segment) => segment.text)).toEqual(["Chunk 2"]);
  });

  it("keeps backend direct chunk groups distinct so the UI stays chunk-aware", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 7201, sampleRate: 16000 });
    const chunks = [
      {
        chunkId: "demeter-backend-001",
        index: 0,
        startSec: 0,
        endSec: 5,
        durationSec: 5,
        segmentCount: 1,
        text: "Chunk 1",
        segments: [
          {
            index: 0,
            start: 0,
            end: 5,
            text: "Chunk 1",
            chunkId: "demeter-backend-001",
            speaker: "SPEAKER_00",
          },
        ],
      },
      {
        chunkId: "demeter-backend-002",
        index: 1,
        startSec: 5,
        endSec: 10,
        durationSec: 5,
        segmentCount: 1,
        text: "Chunk 2",
        segments: [
          {
            index: 1,
            start: 5,
            end: 10,
            text: "Chunk 2",
            chunkId: "demeter-backend-002",
            speaker: "SPEAKER_01",
          },
        ],
      },
    ];
    mocks.transcribeWithDemeterSante.mockImplementationOnce(async (request: {
      onBackendOperationProgress?: (snapshot: unknown) => void;
    }) => {
      request.onBackendOperationProgress?.({
        operationId: "op-789",
        status: "running",
        stage: "chunk_completed",
        chunkIndex: 1,
        chunkCount: 2,
        progress: 0.5,
        response: {
          text: chunks[0].text,
          chunks: [chunks[0]],
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        text: "Chunk 1\nChunk 2",
        chunks,
      };
    });

    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File(["a"], "long-audio.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("done");
      expect(api.chunkGroups).toHaveLength(2);
    });
    expect(api.chunkGroups[0]?.chunkId).toBe("demeter-backend-001");
    expect(api.chunkGroups[1]?.chunkId).toBe("demeter-backend-002");
    expect(api.chunkGroups[0]?.segmentCount).toBe(1);
    expect(api.chunkGroups[1]?.segmentCount).toBe(1);
    expect((await api.loadChunkSegments("demeter-backend-001")).map((segment) => segment.text)).toEqual(["Chunk 1"]);
    expect((await api.loadChunkSegments("demeter-backend-002")).map((segment) => segment.text)).toEqual(["Chunk 2"]);
  });

  it("blocks an empty source file, logs it, and reports the error without retry", async () => {
    let api!: ReturnType<typeof useCloudTranscription>;
    render(<HookHarness provider="demeter_sante" onReady={(value) => (api = value)} />);
    const file = new File([], "empty.wav", { type: "audio/wav" });

    await act(async () => {
      await api.handleFileSelected(file);
    });
    await act(async () => {
      await api.startTranscription();
    });

    await waitFor(() => {
      expect(api.status).toBe("error");
      expect(api.statusDetail).toBe("Fichier audio vide");
    });
    expect(mocks.transcribeWithDemeterSante).not.toHaveBeenCalled();
    expect(mocks.sendFrontendAudioErrorReport).toHaveBeenCalledTimes(1);
    const reportInput = mocks.sendFrontendAudioErrorReport.mock.calls[0]?.[0] as {
      backendError: { code: string; status: number };
      retry: { attempted: boolean; succeeded: boolean; usedRawFile: boolean };
    };
    expect(reportInput.backendError.code).toBe("empty_audio_file");
    expect(reportInput.backendError.status).toBe(400);
    expect(reportInput.retry).toEqual({
      attempted: false,
      succeeded: false,
      usedRawFile: false,
    });
  });

  it("retries a backend audio validation failure with the raw chunk and reports recovery", async () => {
    useAsrStore.setState({
      cloudDemeterDiarizationEnabled: false,
    } as never);

    mocks.transcribeWithDemeterSante
      .mockRejectedValueOnce(
        new BackendHttpError({
          status: 400,
          code: "empty_audio_file",
          message: "Fichier audio vide.",
          path: "/providers/demeter-sante/audio/transcriptions",
          method: "POST",
          traceId: "trace-audio-1",
        })
      )
      .mockResolvedValueOnce({
        text: "ok",
        chunks: [
          {
            chunkId: "demeter-retry-001",
            index: 0,
            startSec: 0,
            endSec: 1,
            durationSec: 1,
            segmentCount: 1,
            text: "ok",
            segments: [
              {
                index: 0,
                start: 0,
                end: 1,
                text: "ok",
                chunkId: "demeter-retry-001",
              },
            ],
          },
        ],
      });

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
    expect(mocks.transcribeWithDemeterSante).toHaveBeenCalledTimes(2);
    const firstCallFile = mocks.transcribeWithDemeterSante.mock.calls[0]?.[0] as { file: File };
    const secondCallFile = mocks.transcribeWithDemeterSante.mock.calls[1]?.[0] as { file: File };
    expect(firstCallFile.file.name).toContain("cloud");
    expect(secondCallFile.file.name).toContain("segment_0.webm");
    expect(mocks.sendFrontendAudioErrorReport).toHaveBeenCalledTimes(1);
    const reportInput = mocks.sendFrontendAudioErrorReport.mock.calls[0]?.[0] as {
      backendError: { code: string; traceId?: string };
      retry: { attempted: boolean; succeeded: boolean; usedRawFile: boolean };
      rawFile?: { name: string; sizeBytes: number; mimeType: string; source: string } | null;
    };
    expect(reportInput.backendError.code).toBe("empty_audio_file");
    expect(reportInput.backendError.traceId).toBe("trace-audio-1");
    expect(reportInput.retry).toEqual({
      attempted: true,
      succeeded: true,
      usedRawFile: true,
    });
    expect(reportInput.rawFile?.source).toBe("raw");
  });

  it("splits demeter chunks and retries after an upstream timeout", async () => {
    mocks.probeAudioMetadata.mockResolvedValueOnce({ durationSec: 10, sampleRate: 16000 });
    mocks.buildFixedSegments.mockReturnValueOnce([{ start: 0, end: 10 }]);
    mocks.transcribeWithDemeterSante
      .mockRejectedValueOnce(new Error("The upstream server is timing out"))
      .mockResolvedValue({
        text: "ok",
        chunks: [
          {
            chunkId: "demeter-timeout-001",
            index: 0,
            startSec: 0,
            endSec: 10,
            durationSec: 10,
            segmentCount: 1,
            text: "ok",
            segments: [
              {
                index: 0,
                start: 0,
                end: 10,
                text: "ok",
                chunkId: "demeter-timeout-001",
              },
            ],
          },
        ],
      });

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
    expect(mocks.stageCloudSegments).toHaveBeenCalledTimes(2);
    expect(mocks.deleteSegment).toHaveBeenCalled();
  });
});
