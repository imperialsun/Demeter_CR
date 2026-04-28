import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";

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
  llmHookCalls: [] as Array<{
    providerOverride?: "huggingface" | "mistral" | "demeter_sante";
  } | undefined>,
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
  useLlmReports: (options?: {
    providerOverride?: "huggingface" | "mistral" | "demeter_sante";
  }) => {
    pageHooks.llmHookCalls.push(options);
    return pageHooks.llmState;
  },
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
    crn?: unknown;
  };
  generateAll: (
    input: { source: "transcription"; transcriptMode: "cloud" } | { source: "text"; text: string }
  ) => Promise<void>;
  downloadDocx: (format: "cri" | "cro" | "crs" | "crn") => Promise<void>;
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
    providedLoadChunkSegments ??
    vi.fn(async (chunkId: string) => segments.filter((segment) => segment.chunkId === chunkId));
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

function NavigationHarness() {
  const navigate = useNavigate();

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button type="button" onClick={() => navigate("/assistant")}>
          Assistant
        </button>
        <button type="button" onClick={() => navigate("/settings")}>
          Réglages
        </button>
      </div>
      <Routes>
        <Route path="/assistant" element={<AssistantPage />} />
        <Route path="/settings" element={<div data-testid="settings-page">Settings</div>} />
      </Routes>
    </div>
  );
}

describe("AssistantPage", () => {
  beforeEach(() => {
    useAsrStore.getState().resetApp();
    resetMutableObject(pageHooks.cloudState);
    resetMutableObject(pageHooks.llmState);
    pageHooks.cloudHookCalls.length = 0;
    pageHooks.llmHookCalls.length = 0;
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
    expect(importHeading.compareDocumentPosition(statusHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    for (const label of ["Fichier audio", "Diarisation", "Transcription", "Comptes rendus"]) {
      const labelNode = screen
        .getAllByText(label, { selector: "span" })
        .find((node) => node.parentElement?.classList.contains("items-start"));
      if (!labelNode) {
        throw new Error(`Missing workflow label: ${label}`);
      }
      expect(labelNode).toHaveClass("whitespace-normal", "break-normal");
      expect(labelNode).not.toHaveClass("truncate", "wrap-break-word");
      expect(labelNode.parentElement).toHaveClass("items-start");
    }

    expect(screen.getByRole("heading", { name: "Niveau de detail des comptes rendus" })).toBeInTheDocument();
  });

  it("forces Demeter backend direct mode from the Assistant page", () => {
    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    renderWithStore(<AssistantPage />);

    const [provider, options] = pageHooks.cloudHookCalls[0] ?? [];
    expect(provider).toBe("demeter_sante");
    expect(options).toEqual(expect.objectContaining({ forceDemeterBackendDirect: true }));
    expect(pageHooks.llmHookCalls[0]).toEqual(expect.objectContaining({ providerOverride: "demeter_sante" }));
  });

  it("preserves the assistant workflow and open chunk panel across settings navigation", async () => {
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
    ];
    const chunkSummaries = groupCloudTranscriptionSegments(segments);
    const loadChunkSegments = vi.fn(async (chunkId: string) => segments.filter((segment) => segment.chunkId === chunkId));

    Object.assign(
      pageHooks.cloudState,
      createCloudHookValue({
        segments,
        loadChunkSegments,
        handleFileSelected: vi.fn(async (file: File) => {
          pageHooks.cloudState.selectedFile = file;
          pageHooks.cloudState.audioMetadata = {
            name: file.name,
            durationSec: 8,
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
        resetTranscriptionSession: vi.fn(),
      })
    );
    Object.assign(
      pageHooks.llmState,
      createLlmHookValue({
        status: "idle",
        progress: 0,
      })
    );
    useAsrStore.setState({
      assistantWorkflow: {
        diarizationChoice: null,
        hasTriggeredTranscription: false,
        hasTriggeredGeneration: false,
        hasConfirmedDiarizationReview: false,
        activeChunkId: null,
      },
    } as never);

    const user = userEvent.setup();
    renderWithStore(
      <MemoryRouter initialEntries={["/assistant"]}>
        <NavigationHarness />
      </MemoryRouter>
    );

    await user.click(screen.getByRole("button", { name: "Importer" }));
    await waitFor(() => {
      expect(pageHooks.cloudState.handleFileSelected).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: /Oui, avec morceaux/i }));
    await waitFor(() => {
      expect(pageHooks.cloudState.startTranscription).toHaveBeenCalledTimes(1);
    });

    useAsrStore.setState({
      assistantWorkflow: {
        diarizationChoice: true,
        hasTriggeredTranscription: true,
        hasTriggeredGeneration: false,
        hasConfirmedDiarizationReview: false,
        activeChunkId: "assistant-1",
      },
    } as never);
    pageHooks.cloudState.status = "done";
    pageHooks.cloudState.statusDetail = "Transcription terminée";
    pageHooks.cloudState.isTranscribing = false;
    pageHooks.cloudState.progress = 1;
    pageHooks.cloudState.chunkSummaries = chunkSummaries;
    useAsrStore.setState({
      sessionTranscriptMemories: {
        ...useAsrStore.getState().sessionTranscriptMemories,
        cloud: {
          mode: "cloud",
          provider: "demeter_sante",
          label: "Cloud Demeter Santé · assistant-session.wav",
          transcriptText: "Dupont Alice: Bonjour\nMartin Jean: Suite\nDupont Alice: Encore",
          segmentCount: 3,
          audioSource: {
            id: "demeter_sante:assistant-session.wav:1024",
            label: "assistant-session.wav",
            type: "file",
          },
          audioMetadata: pageHooks.cloudState.audioMetadata,
          updatedAt: "2026-04-24T10:00:00.000Z",
        },
      },
    } as never);

    await waitFor(() => {
      expect(screen.getByTestId("assistant-chunk-list")).toBeInTheDocument();
      expect(screen.getByTestId("cloud-chunk-details-assistant-1")).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: "Réglages" }));
    expect(screen.getByTestId("settings-page")).toBeInTheDocument();
    expect(pageHooks.cloudState.resetTranscriptionSession).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Assistant" }));

    await waitFor(() => {
      expect(screen.getByTestId("assistant-chunk-list")).toBeInTheDocument();
      expect(screen.getByTestId("cloud-chunk-details-assistant-1")).toBeInTheDocument();
    });
    expect(useAsrStore.getState().assistantWorkflow.activeChunkId).toBe("assistant-1");
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

  it("keeps the reset CTAs hidden before the workflow is complete", () => {
    Object.assign(
      pageHooks.cloudState,
      createCloudHookValue({
        selectedFile: new File(["audio"], "assistant-session.wav", { type: "audio/wav" }),
        audioMetadata: {
          name: "assistant-session.wav",
          durationSec: 12,
          sizeBytes: 1024,
          mimeType: "audio/wav",
          sampleRate: 16000,
        },
        status: "done",
        statusDetail: "Transcription terminée",
      })
    );
    Object.assign(pageHooks.llmState, createLlmHookValue());

    renderWithStore(<AssistantPage />);

    expect(screen.queryByRole("button", { name: "Nouvelle transcription" })).toBeNull();
    expect(screen.queryByTestId("assistant-reset-workflow-top")).toBeNull();
    expect(screen.queryByTestId("assistant-reset-workflow-bottom")).toBeNull();
  });

  it("opens and closes the guided help sections", async () => {
    Object.assign(pageHooks.cloudState, createCloudHookValue());
    Object.assign(pageHooks.llmState, createLlmHookValue());

    const user = userEvent.setup();
    renderWithStore(<AssistantPage />);

    const panel = screen.getByTestId("assistant-help-panel");
    expect(panel).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Masquer l’aide" }));
    expect(screen.queryByTestId("assistant-help-panel")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Afficher l’aide" }));

    const reopenedPanel = screen.getByTestId("assistant-help-panel");
    const fileSection = screen.getByTestId("assistant-help-section-file");
    const fileSectionButton = within(fileSection).getByRole("button", { name: /Fichier/i });
    const fileSectionContent = document.getElementById("assistant-help-section-file-content");
    if (!fileSectionContent) {
      throw new Error("Missing file help section content");
    }

    expect(reopenedPanel).toBeInTheDocument();
    expect(fileSectionButton).toHaveAttribute("aria-expanded", "false");
    expect(fileSectionContent).toHaveClass("hidden");

    await user.click(fileSectionButton);

    expect(fileSectionButton).toHaveAttribute("aria-expanded", "true");
    expect(fileSectionContent).not.toHaveClass("hidden");
    expect(fileSectionContent).toHaveTextContent(/Déposez un MP3, WAV ou M4A/i);

    const diarizationSection = screen.getByTestId("assistant-help-section-diarization");
    const diarizationSectionButton = within(diarizationSection).getByRole("button", { name: /Diarisation/i });
    const diarizationSectionContent = document.getElementById("assistant-help-section-diarization-content");
    if (!diarizationSectionContent) {
      throw new Error("Missing diarization help section content");
    }

    await user.click(diarizationSectionButton);

    expect(diarizationSectionButton).toHaveAttribute("aria-expanded", "true");
    expect(diarizationSectionContent).not.toHaveClass("hidden");
    expect(diarizationSectionContent).toHaveTextContent(/associer chaque segment à un intervenant/i);

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
          pageHooks.llmState.status = "idle";
          pageHooks.llmState.progress = 0;
          pageHooks.llmState.results = {};
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

    expect(screen.getByRole("heading", { name: "Diarisation" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Niveau de detail des comptes rendus" })).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-status-body")).toBeNull();
    expect(screen.queryByRole("button", { name: "Importer" })).toBeNull();
    expect(screen.getByRole("button", { name: "Changer de fichier" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /déplier/i }));
    fireEvent.change(
      screen.getByLabelText("Compte rendu détaillé", { selector: "input#report-detail-cri" }),
      { target: { value: "2" } }
    );
    expect(useAsrStore.getState().llmApiReportDetailLevels.CRI).toBe("exhaustive");
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
    useAsrStore.setState({
      sessionTranscriptMemories: {
        ...useAsrStore.getState().sessionTranscriptMemories,
        cloud: {
          mode: "cloud",
          provider: "demeter_sante",
          label: "Cloud Demeter Santé · assistant-session.wav",
          transcriptText: "SPEAKER_00: Bonjour",
          segmentCount: 1,
          audioSource: {
            id: "demeter_sante:assistant-session.wav:5",
            label: "assistant-session.wav",
            type: "file",
          },
          audioMetadata: pageHooks.cloudState.audioMetadata,
          updatedAt: "2026-04-24T10:00:00.000Z",
        },
      },
    } as never);
    rerender(<AssistantPage />);

    expect(screen.getByTestId("assistant-chunk-list")).toBeInTheDocument();
    expect(screen.getByTestId("cloud-chunk-card-assistant-1")).toBeInTheDocument();
    expect(pageHooks.llmState.generateAll).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.hover(screen.getByRole("button", { name: "Aide relecture des morceaux" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      /Chaque carte correspond à une partie de l’audio\. Ouvrez-la pour relire les segments et les intervenants\./i
    );

    const reviewButton = screen.getByRole("button", { name: "Valider la transcription" });
    fireEvent.click(reviewButton);

    await waitFor(() => {
      expect(pageHooks.llmState.generateAll).toHaveBeenCalledTimes(1);
    });
    expect(pageHooks.llmState.generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "cloud",
        sourceText: "SPEAKER_00: Bonjour",
      })
    );

    rerender(<AssistantPage />);

    const processingBody = screen.getByTestId("assistant-status-body");
    expect(processingBody).toHaveTextContent(ASSISTANT_JOKES[expectedJokeOrder[0] ?? 0]);
    expect(within(processingBody).queryByRole("button", { name: "Valider la transcription" })).toBeNull();
    expect(screen.queryByTestId("assistant-chunk-list")).toBeNull();

    pageHooks.llmState.status = "done";
    pageHooks.llmState.progress = 1;
    pageHooks.llmState.results = {
      cri: { ok: true },
      cro: { ok: true },
      crs: { ok: true },
      crn: { ok: true },
    };
    rerender(<AssistantPage />);

    fireEvent.click(
      within(screen.getByTestId("assistant-status-body")).getByRole("button", {
        name: /^Télécharger la transcription \(\.docx\)$/i,
      })
    );

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
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu détaillé/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu opérationnel/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu synthétique/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu narratif/i })).toBeInTheDocument();
    expect(within(readyBody).queryByRole("button", { name: /Valider la transcription/i })).toBeNull();

    expect(screen.getByTestId("assistant-reset-workflow-top")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-reset-workflow-bottom")).toBeInTheDocument();

    await user.click(screen.getByTestId("assistant-reset-workflow-top"));

    const resetDialog = screen.getByRole("dialog", { name: /remettre l'assistant à zéro/i });
    expect(within(resetDialog).getByText(/vous êtes sur le point de lancer une nouvelle transcription/i)).toBeInTheDocument();
    expect(within(resetDialog).getByRole("button", { name: "Annuler" })).toBeInTheDocument();
    expect(within(resetDialog).getByRole("button", { name: "OK" })).toBeInTheDocument();

    await user.click(within(resetDialog).getByRole("button", { name: "Annuler" }));
    expect(pageHooks.cloudState.resetTranscriptionSession).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /remettre l'assistant à zéro/i })).toBeNull();
    expect(screen.getByTestId("assistant-reset-workflow-top")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-reset-workflow-bottom")).toBeInTheDocument();

    await user.click(screen.getByTestId("assistant-reset-workflow-bottom"));
    const confirmDialog = screen.getByRole("dialog", { name: /remettre l'assistant à zéro/i });
    await user.click(within(confirmDialog).getByRole("button", { name: "OK" }));

    await waitFor(() => {
      expect(pageHooks.cloudState.resetTranscriptionSession).toHaveBeenCalledTimes(1);
    });

    pageHooks.cloudState.selectedFile = null;
    pageHooks.cloudState.audioMetadata = null;
    pageHooks.cloudState.chunkSummaries = [];
    pageHooks.cloudState.status = "idle";
    pageHooks.cloudState.statusDetail = null;
    pageHooks.cloudState.isTranscribing = false;
    rerender(<AssistantPage />);

    expect(screen.queryByRole("dialog", { name: /remettre l'assistant à zéro/i })).toBeNull();
    expect(screen.queryByTestId("assistant-reset-workflow-top")).toBeNull();
    expect(screen.queryByTestId("assistant-reset-workflow-bottom")).toBeNull();
    expect(screen.getByRole("button", { name: "Importer" })).toBeInTheDocument();
    expect(screen.getByText(/Assistant cloud Demeter/i)).toBeInTheDocument();
  }, 15_000);

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
    useAsrStore.setState({
      sessionTranscriptMemories: {
        ...useAsrStore.getState().sessionTranscriptMemories,
        cloud: {
          mode: "cloud",
          provider: "demeter_sante",
          label: "Cloud Demeter Santé · assistant-session.wav",
          transcriptText: "SPEAKER_00: Bonjour",
          segmentCount: 1,
          audioSource: {
            id: "demeter_sante:assistant-session.wav:5",
            label: "assistant-session.wav",
            type: "file",
          },
          audioMetadata: pageHooks.cloudState.audioMetadata,
          updatedAt: "2026-04-24T10:00:00.000Z",
        },
      },
    } as never);
    rerender(<AssistantPage />);

    await waitFor(() => {
      expect(pageHooks.llmState.generateAll).toHaveBeenCalledTimes(1);
    });
    expect(pageHooks.llmState.generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "cloud",
        sourceText: "SPEAKER_00: Bonjour",
      })
    );

    pageHooks.llmState.status = "done";
    pageHooks.llmState.progress = 1;
    pageHooks.llmState.results = {
      cri: { ok: true },
      cro: { ok: true },
      crs: { ok: true },
      crn: { ok: true },
    };
    rerender(<AssistantPage />);

    const readyBody = screen.getByTestId("assistant-status-body");
    expect(within(readyBody).getByRole("button", { name: /Télécharger la transcription/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu détaillé/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu opérationnel/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu synthétique/i })).toBeInTheDocument();
    expect(within(readyBody).getByRole("button", { name: /Télécharger le Compte rendu narratif/i })).toBeInTheDocument();
    expect(screen.getByTestId("assistant-reset-workflow-top")).toBeInTheDocument();
    expect(screen.getByTestId("assistant-reset-workflow-bottom")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-chunk-list")).toBeNull();
  });

  it("uses fresh session transcript memory when assistant segments are not exportable yet", async () => {
    const file = new File(["audio"], "assistant-session.wav", { type: "audio/wav" });
    const audioMetadata = {
      name: "assistant-session.wav",
      durationSec: 5,
      sizeBytes: file.size,
      mimeType: file.type,
      sampleRate: 16000,
    } satisfies AudioMetadata;

    Object.assign(
      pageHooks.cloudState,
      createCloudHookValue({
        selectedFile: file,
        audioMetadata,
        status: "done",
        statusDetail: "Transcription terminée",
        progress: 1,
        loadAllSegmentsForExport: vi.fn(async () => []),
      })
    );
    Object.assign(
      pageHooks.llmState,
      createLlmHookValue({
        generateAll: vi.fn(async () => {
          pageHooks.llmState.status = "preparing";
        }),
      })
    );
    useAsrStore.setState({
      assistantWorkflow: {
        diarizationChoice: false,
        hasTriggeredTranscription: true,
        hasTriggeredGeneration: false,
        hasConfirmedDiarizationReview: false,
        activeChunkId: null,
      },
      sessionTranscriptMemories: {
        ...useAsrStore.getState().sessionTranscriptMemories,
        cloud: {
          mode: "cloud",
          provider: "demeter_sante",
          label: "Cloud Demeter Santé · assistant-session.wav",
          transcriptText: "Texte mémoire disponible",
          segmentCount: 1,
          audioSource: { id: "demeter_sante:assistant-session.wav:5", label: "assistant-session.wav", type: "file" },
          audioMetadata,
          updatedAt: "2026-04-24T10:00:00.000Z",
        },
      },
    } as never);

    renderWithStore(<AssistantPage />);

    await waitFor(() => {
      expect(pageHooks.llmState.generateAll).toHaveBeenCalledTimes(1);
    });
    expect(pageHooks.llmState.generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "cloud",
        sourceText: "Texte mémoire disponible",
      })
    );
  });
});
