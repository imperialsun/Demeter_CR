import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import AssistantPage from "./AssistantPage";
import { ASSISTANT_JOKES, buildRandomJokeOrder } from "./assistantPageContent";
import { renderWithStore } from "../test/utils";
import { useAsrStore } from "@/store/asr-store";
import { groupCloudTranscriptionSegments } from "@/lib/cloud/transcriptionChunks";
import type { AudioMetadata } from "@/lib/audio";
import type { TranscriptionSegment } from "@/lib/export";

const transcriptDocxMocks = vi.hoisted(() => ({
  buildTranscriptDocx: vi.fn(async () => new Blob(["docx"], { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })),
  downloadDocxBlob: vi.fn(),
  formatTranscriptDocxFilename: vi.fn(() => "transcription-brute-2026-04-06-1000.docx"),
}));

const pageHooks = vi.hoisted(() => ({
  cloudState: {} as Record<string, unknown>,
  llmState: {} as Record<string, unknown>,
  cloudHookCalls: [] as Array<[
    string,
    {
      forceDemeterBackendDirect?: boolean;
    } | undefined
  ]>,
}));

vi.mock("@/components/audio/AudioUploader", () => ({
  AudioUploader: ({
    onFileSelected,
    metadata,
    hideDropZoneWhenMetadata,
  }: {
    onFileSelected: (file: File) => void;
    metadata?: AudioMetadata | null;
    hideDropZoneWhenMetadata?: boolean;
  }) => (
    <div>
      {!(hideDropZoneWhenMetadata && metadata) ? (
        <button
          type="button"
          onClick={() => {
            onFileSelected(new File(["audio"], "assistant-session.wav", { type: "audio/wav" }));
          }}
        >
          Importer
        </button>
      ) : null}
      {metadata ? <button type="button">Changer de fichier</button> : null}
    </div>
  ),
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

vi.mock("@/hooks/useCloudTranscription", () => ({
  useCloudTranscription: (
    provider: string,
    options?: {
      forceDemeterBackendDirect?: boolean;
    }
  ) => {
    pageHooks.cloudHookCalls.push([provider, options]);
    return pageHooks.cloudState;
  },
}));

vi.mock("@/hooks/useLlmReports", () => ({
  useLlmReports: () => pageHooks.llmState,
}));

vi.mock("@/lib/docx/transcriptDocx", () => ({
  buildTranscriptDocx: (...args: unknown[]) => transcriptDocxMocks.buildTranscriptDocx(...args),
  downloadDocxBlob: (...args: unknown[]) => transcriptDocxMocks.downloadDocxBlob(...args),
  formatTranscriptDocxFilename: (...args: unknown[]) => transcriptDocxMocks.formatTranscriptDocxFilename(...args),
}));

type CloudHookValue = {
  selectedFile: File | null;
  previewUrl: string | null;
  audioMetadata: AudioMetadata | null;
  chunkSummaries: ReturnType<typeof groupCloudTranscriptionSegments>;
  status: "idle" | "preprocessing" | "uploading" | "transcribing" | "stopping" | "done" | "error";
  statusDetail: string | null;
  progress: number;
  preparedUpload: null;
  isTranscribing: boolean;
  isResettingSession: boolean;
  handleFileSelected: (file: File) => void;
  startTranscription: () => Promise<void>;
  resetTranscriptionSession: () => Promise<void>;
  loadChunkSegments: (chunkId: string) => Promise<TranscriptionSegment[]>;
  loadAllSegmentsForExport: () => Promise<TranscriptionSegment[]>;
  updateSegmentText: (chunkId: string, segmentIndex: number, text: string) => Promise<void>;
  updateSegmentSpeaker: (chunkId: string, segmentIndex: number, speakerId: string) => Promise<void>;
  stopRequested?: boolean;
};

type LlmHookValue = {
  status: "idle" | "preparing" | "generating" | "formatting" | "done" | "error";
  progress: number;
  results: {
    cri?: unknown;
    cro?: unknown;
    crs?: unknown;
  };
  generateAll: (input: { source: "transcription"; transcriptMode: "cloud" }) => Promise<void>;
  downloadDocx: (format: "cri" | "cro" | "crs") => Promise<void>;
};

function createCloudHookValue(overrides: Partial<CloudHookValue> & { segments?: TranscriptionSegment[] } = {}) {
  const {
    segments = [],
    chunkSummaries: providedChunkSummaries,
    loadChunkSegments: providedLoadChunkSegments,
    ...rest
  } = overrides;
  const chunkSummaries = providedChunkSummaries ?? groupCloudTranscriptionSegments(segments);
    const loadChunkSegments =
    providedLoadChunkSegments ?? vi.fn(async (chunkId: string) => segments.filter((segment) => segment.chunkId === chunkId));
  const loadAllSegmentsForExport =
    overrides.loadAllSegmentsForExport ?? vi.fn(async () => segments);

  return {
    selectedFile: null,
    previewUrl: null,
    audioMetadata: null,
    chunkSummaries,
    status: "idle" as const,
    statusDetail: null,
    progress: 0,
    preparedUpload: null,
    isTranscribing: false,
    isResettingSession: false,
    stopRequested: false,
    handleFileSelected: vi.fn(),
    startTranscription: vi.fn(),
    resetTranscriptionSession: vi.fn(),
    loadChunkSegments,
    loadAllSegmentsForExport,
    updateSegmentText: vi.fn(),
    updateSegmentSpeaker: vi.fn(),
    ...rest,
  } satisfies CloudHookValue;
}

function createLlmHookValue(overrides: Partial<LlmHookValue> = {}) {
  return {
    status: "idle" as const,
    progress: 0,
    results: {},
    generateAll: vi.fn(),
    downloadDocx: vi.fn(),
    ...overrides,
  } satisfies LlmHookValue;
}

function resetMutableObject(target: Record<string, unknown>) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
}

describe("AssistantPage", () => {
  beforeEach(() => {
    useAsrStore.getState().resetApp();
    resetMutableObject(pageHooks.cloudState);
    resetMutableObject(pageHooks.llmState);
    pageHooks.cloudHookCalls.length = 0;
    transcriptDocxMocks.buildTranscriptDocx.mockClear();
    transcriptDocxMocks.downloadDocxBlob.mockClear();
    transcriptDocxMocks.formatTranscriptDocxFilename.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    useAsrStore.getState().resetApp();
  });

  it("shows the workflow step labels without truncation", () => {
    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    renderWithStore(<AssistantPage />);

    const statusHeading = screen.getByRole("heading", { name: "Statut" });
    const importHeading = screen.getByRole("heading", { name: "Import" });
    expect(statusHeading.compareDocumentPosition(importHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const label of ["Fichier", "Diarization", "Transcription", "Rapports"]) {
      const labelNode = screen.getByText(label, { selector: "span" });
      expect(labelNode).toHaveClass("whitespace-normal", "break-normal");
      expect(labelNode).not.toHaveClass("truncate", "wrap-break-word");
      expect(labelNode.parentElement).toHaveClass("items-start");
    }
  });

  it("forces Demeter backend direct mode from the Assistant page", () => {
    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    renderWithStore(<AssistantPage />);

    const [provider, options] = pageHooks.cloudHookCalls[0] ?? [];
    expect(provider).toBe("demeter_sante");
    expect(options).toEqual(expect.objectContaining({ forceDemeterBackendDirect: true }));
  });

  it("builds a shuffled joke order from an injected RNG", () => {
    expect(buildRandomJokeOrder(5, () => 0)).toEqual([1, 2, 3, 4, 0]);
  });

  it("hides the status body until the process starts", () => {
    expect(ASSISTANT_JOKES.length).toBeGreaterThanOrEqual(50);

    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    renderWithStore(<AssistantPage />);

    expect(screen.queryByTestId("assistant-status-body")).toBeNull();
    expect(screen.queryByText("En attente d'un fichier")).toBeNull();
  });

  it("opens and closes the guided help sections", async () => {
    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    const user = userEvent.setup();
    renderWithStore(<AssistantPage />);

    expect(screen.queryByTestId("assistant-help-panel")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Aide" }));

    const panel = screen.getByTestId("assistant-help-panel");
    const fileSection = screen.getByTestId("assistant-help-section-file");
    const fileSectionButton = within(fileSection).getByRole("button", { name: /Fichier/i });
    const fileSectionContent = document.getElementById("assistant-help-section-file-content");
    if (!fileSectionContent) {
      throw new Error("Missing file help section content");
    }

    expect(panel).toBeInTheDocument();
    expect(fileSectionButton).toHaveAttribute("aria-expanded", "false");
    expect(fileSectionContent).toHaveClass("hidden");

    await user.click(fileSectionButton);

    expect(fileSectionButton).toHaveAttribute("aria-expanded", "true");
    expect(fileSectionContent).not.toHaveClass("hidden");
    expect(fileSectionContent).toHaveTextContent(/Déposez un MP3, WAV ou M4A/i);

    const diarizationSection = screen.getByTestId("assistant-help-section-diarization");
    const diarizationSectionButton = within(diarizationSection).getByRole("button", { name: /Diarization/i });
    const diarizationSectionContent = document.getElementById("assistant-help-section-diarization-content");
    if (!diarizationSectionContent) {
      throw new Error("Missing diarization help section content");
    }

    await user.click(diarizationSectionButton);

    expect(diarizationSectionButton).toHaveAttribute("aria-expanded", "true");
    expect(diarizationSectionContent).not.toHaveClass("hidden");
    expect(diarizationSectionContent).toHaveTextContent(/parties de la réunion/i);

    await user.click(fileSectionButton);

    expect(fileSectionButton).toHaveAttribute("aria-expanded", "false");
    expect(fileSectionContent).toHaveClass("hidden");
  });

  it("lets diarization runs pause for manual review before generating reports", async () => {
    const segments: TranscriptionSegment[] = [
      {
        index: 0,
        start: 0,
        end: 4,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        speakerLabel: "Dupont Alice",
        chunkId: "assistant-1",
        strategy: "chunks",
      },
      {
        index: 1,
        start: 4,
        end: 8,
        text: "Suite",
        speaker: "SPEAKER_01",
        speakerLabel: "Martin Jean",
        chunkId: "assistant-1",
        strategy: "chunks",
      },
      {
        index: 2,
        start: 8,
        end: 12,
        text: "Encore",
        speaker: "SPEAKER_00",
        speakerLabel: "Dupont Alice",
        chunkId: "assistant-2",
        strategy: "chunks",
      },
    ];
    const chunkSummaries = groupCloudTranscriptionSegments(segments);
    const loadChunkSegments = vi.fn(async (chunkId: string) => segments.filter((segment) => segment.chunkId === chunkId));
    const expectedJokeOrder = buildRandomJokeOrder(ASSISTANT_JOKES.length, () => 0);

    vi.spyOn(Math, "random").mockReturnValue(0);

    Object.assign(
      pageHooks.cloudState,
      createCloudHookValue({
        segments,
        loadChunkSegments,
      })
    );
    Object.assign(
      pageHooks.cloudState,
      {
        handleFileSelected: vi.fn((file: File) => {
          pageHooks.cloudState.selectedFile = file;
          pageHooks.cloudState.audioMetadata = {
            name: file.name,
            durationSec: 12,
            sizeBytes: file.size,
            mimeType: file.type,
            sampleRate: 16000,
          } satisfies AudioMetadata;
          pageHooks.cloudState.status = "idle";
          pageHooks.cloudState.statusDetail = "Fichier chargé, prêt à lancer";
        }),
        startTranscription: vi.fn(async () => {
          pageHooks.cloudState.isTranscribing = true;
          pageHooks.cloudState.status = "transcribing";
          pageHooks.cloudState.statusDetail = "Transcription cloud";
        }),
        resetTranscriptionSession: vi.fn(async () => {
          pageHooks.cloudState.selectedFile = null;
          pageHooks.cloudState.audioMetadata = null;
          pageHooks.cloudState.chunkSummaries = [];
          pageHooks.cloudState.status = "idle";
          pageHooks.cloudState.statusDetail = null;
          pageHooks.cloudState.isTranscribing = false;
        }),
        loadAllSegmentsForExport: vi.fn(async () => segments),
      } satisfies Partial<CloudHookValue>
    );

    Object.assign(
      pageHooks.llmState,
      createLlmHookValue({
        generateAll: vi.fn(async () => {
          pageHooks.llmState.status = "preparing";
          pageHooks.llmState.progress = 0.1;
        }),
      })
    );

    const { rerender } = renderWithStore(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "Importer" }));

    await waitFor(() => {
      expect(pageHooks.cloudState.handleFileSelected).toHaveBeenCalledTimes(1);
    });

    rerender(<AssistantPage />);

    expect(screen.getByRole("heading", { name: "Diarization" })).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-status-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Importer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Changer de fichier" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Oui, avec morceaux/i }));

    await waitFor(() => {
      expect(pageHooks.cloudState.startTranscription).toHaveBeenCalledTimes(1);
    });

    fireEvent(document, new Event("visibilitychange"));

    expect(pageHooks.cloudState.resetTranscriptionSession).not.toHaveBeenCalled();

    pageHooks.cloudState.status = "done";
    pageHooks.cloudState.statusDetail = "Transcription terminée";
    pageHooks.cloudState.isTranscribing = false;
    pageHooks.cloudState.progress = 1;
    pageHooks.cloudState.chunkSummaries = chunkSummaries;
    rerender(<AssistantPage />);

    expect(screen.getByTestId("assistant-chunk-list")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-chunk-card-assistant-1")).toBeInTheDocument();
    expect(pageHooks.llmState.generateAll).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.hover(screen.getByRole("button", { name: "Aide morceaux audio" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Chaque carte correspond à un morceau audio\. Ouvrez-la pour éditer les segments et les speakers\./i
    );

    const reviewButton = screen.getByRole("button", { name: "La transcription est ok continuer" });
    fireEvent.click(reviewButton);

    await waitFor(() => {
      expect(pageHooks.llmState.generateAll).toHaveBeenCalledTimes(1);
    });

    rerender(<AssistantPage />);

    const processingBody = screen.getByTestId("assistant-status-body");
    expect(processingBody).toHaveTextContent(ASSISTANT_JOKES[expectedJokeOrder[0] ?? 0]);
    expect(within(processingBody).queryByRole("button", { name: "La transcription est ok continuer" })).toBeNull();
    expect(screen.queryByTestId("assistant-chunk-list")).toBeNull();

    pageHooks.llmState.status = "done";
    pageHooks.llmState.progress = 1;
    pageHooks.llmState.results = {
      cri: { ok: true },
      cro: { ok: true },
      crs: { ok: true },
    };
    rerender(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: /Télécharger la transcription/i }));

    await waitFor(() => {
      expect(pageHooks.cloudState.loadAllSegmentsForExport).toHaveBeenCalledTimes(1);
      expect(transcriptDocxMocks.buildTranscriptDocx).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ speakerLabel: "Dupont Alice" }),
          expect.objectContaining({ speakerLabel: "Martin Jean" }),
        ]),
        expect.objectContaining({
          sourceMode: "cloud",
          sourceLabel: "assistant-session.wav",
          generatedAt: expect.any(String),
        })
      );
      expect(transcriptDocxMocks.downloadDocxBlob).toHaveBeenCalledTimes(1);
      expect(transcriptDocxMocks.formatTranscriptDocxFilename).toHaveBeenCalledTimes(1);
    });

    const readyBody = screen.getByTestId("assistant-status-body");
    expect(within(readyBody).getByRole("button", { name: /Télécharger la transcription/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRI/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRO/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRS/i })).toBeInTheDocument();
    expect(within(readyBody).queryByRole("button", { name: /La transcription est ok continuer/i })).toBeNull();

    const importFooterActions = screen.getByTestId("assistant-import-footer-actions");
    expect(within(importFooterActions).queryByRole("button", { name: /Télécharger la transcription/i })).toBeNull();
    expect(within(importFooterActions).getByRole("button", { name: /Nouveau fichier/i })).toBeInTheDocument();
    expect(screen.getByText(/Assistant cloud Demeter/i)).toBeInTheDocument();
  });

  it("keeps the workflow simple when diarization is disabled", async () => {
    const segments: TranscriptionSegment[] = [
      {
        index: 0,
        start: 0,
        end: 5,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        chunkId: "assistant-simple",
        strategy: "chunks",
      },
    ];
    const chunkSummaries = groupCloudTranscriptionSegments(segments);

    Object.assign(
      pageHooks.cloudState,
      createCloudHookValue({
        segments,
      })
    );
    Object.assign(
      pageHooks.cloudState,
      {
        handleFileSelected: vi.fn((file: File) => {
          pageHooks.cloudState.selectedFile = file;
          pageHooks.cloudState.audioMetadata = {
            name: file.name,
            durationSec: 5,
            sizeBytes: file.size,
            mimeType: file.type,
            sampleRate: 16000,
          } satisfies AudioMetadata;
          pageHooks.cloudState.status = "idle";
          pageHooks.cloudState.statusDetail = "Fichier chargé, prêt à lancer";
        }),
        startTranscription: vi.fn(async () => {
          pageHooks.cloudState.isTranscribing = true;
          pageHooks.cloudState.status = "transcribing";
          pageHooks.cloudState.statusDetail = "Transcription cloud";
        }),
        resetTranscriptionSession: vi.fn(async () => {
          pageHooks.cloudState.selectedFile = null;
          pageHooks.cloudState.audioMetadata = null;
          pageHooks.cloudState.chunkSummaries = [];
          pageHooks.cloudState.status = "idle";
          pageHooks.cloudState.statusDetail = null;
          pageHooks.cloudState.isTranscribing = false;
        }),
        loadAllSegmentsForExport: vi.fn(async () => segments),
      } satisfies Partial<CloudHookValue>
    );

    Object.assign(
      pageHooks.llmState,
      createLlmHookValue({
        generateAll: vi.fn(async () => {
          pageHooks.llmState.status = "preparing";
        }),
      })
    );

    const { rerender } = renderWithStore(<AssistantPage />);

    fireEvent.click(screen.getByRole("button", { name: "Importer" }));

    await waitFor(() => {
      expect(pageHooks.cloudState.handleFileSelected).toHaveBeenCalledTimes(1);
    });

    rerender(<AssistantPage />);
    fireEvent.click(screen.getByRole("button", { name: /Non, version simple/i }));

    await waitFor(() => {
      expect(pageHooks.cloudState.startTranscription).toHaveBeenCalledTimes(1);
    });

    pageHooks.cloudState.status = "done";
    pageHooks.cloudState.statusDetail = "Transcription terminée";
    pageHooks.cloudState.isTranscribing = false;
    pageHooks.cloudState.progress = 1;
    pageHooks.cloudState.chunkSummaries = chunkSummaries;
    rerender(<AssistantPage />);

    await waitFor(() => {
      expect(pageHooks.llmState.generateAll).toHaveBeenCalledTimes(1);
    });

    pageHooks.llmState.status = "done";
    pageHooks.llmState.progress = 1;
    pageHooks.llmState.results = {
      cri: { ok: true },
      cro: { ok: true },
      crs: { ok: true },
    };
    rerender(<AssistantPage />);

    const readyBody = screen.getByTestId("assistant-status-body");
    expect(within(readyBody).getByRole("button", { name: /Télécharger la transcription/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRI/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRO/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger CRS/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("assistant-import-footer-actions")).queryByRole("button", { name: /Télécharger la transcription/i })).toBeNull();
    expect(screen.queryByTestId("assistant-chunk-list")).toBeNull();
  });
});
