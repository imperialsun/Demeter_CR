import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { renderWithStore } from "@/test/utils";
import { useAsrStore } from "@/store/asr-store";
import CloudUploadPage from "./CloudUploadPage";
import * as cloudHook from "@/hooks/useCloudTranscription";
import type { AudioMetadata } from "@/lib/audio";
import { groupCloudTranscriptionSegments } from "@/lib/cloud/transcriptionChunks";

const backendPermissionMocks = vi.hoisted(() => ({
  canUseCloudProvider: vi.fn(() => true),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canUseCloudProvider: (...args: unknown[]) => backendPermissionMocks.canUseCloudProvider(...args),
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

function createHookValue(overrides: Partial<ReturnType<typeof cloudHook.useCloudTranscription>> = {}) {
  const segments = overrides.segments ?? [];
  const chunkSummaries = overrides.chunkSummaries ?? groupCloudTranscriptionSegments(segments);
  return {
    selectedFile: null,
    previewUrl: null,
    audioMetadata: null,
    segments,
    chunkSummaries,
    chunkGroups: chunkSummaries,
    telemetrySummary: null,
    status: "idle" as const,
    statusDetail: null,
    progress: 0,
    preparedUpload: null,
    isTranscribing: false,
    isResettingSession: false,
    stopRequested: false,
    resolvedSettings: {
      maxTokens: 32768,
      temperature: 0,
      topP: 1,
      doSample: false,
      sources: {
        maxTokens: "settings" as const,
        temperature: "settings" as const,
        topP: "settings" as const,
        doSample: "settings" as const,
      },
    },
    handleFileSelected: vi.fn(),
    startTranscription: vi.fn(),
    stopTranscription: vi.fn(),
    resetTranscriptionSession: vi.fn(),
    updateSegmentText: vi.fn(),
    updateSegmentSpeaker: vi.fn(),
    ...overrides,
  } satisfies ReturnType<typeof cloudHook.useCloudTranscription>;
}

describe("CloudUploadPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    backendPermissionMocks.canUseCloudProvider.mockReset();
    backendPermissionMocks.canUseCloudProvider.mockReturnValue(true);
    useAsrStore.getState().resetApp();
  });

  it("shows cloud export defaults (VTT/SRT/JSON enabled, Telemetry disabled)", () => {
    useAsrStore.getState().resetApp();
    renderWithStore(<CloudUploadPage />);

    expect(screen.getByRole("button", { name: /VTT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SRT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /JSON/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Telemetry/i })).toBeNull();
  });

  it("renders the cloud upload UI with remaining providers", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudMaxTokens: 2048,
      cloudTemperature: 0.4,
      cloudTopP: 0.8,
      cloudDoSample: true,
    });

    expect(screen.getByText("Transcription cloud")).toBeTruthy();
    expect(screen.getByText(/basse RAM/i)).toBeInTheDocument();
    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    expect(providerSelect.textContent).toContain("Whisper");

    fireEvent.click(providerSelect);
    expect(screen.queryByText("Gradio")).toBeNull();
    expect(screen.getAllByText("Whisper").length).toBeGreaterThan(0);
    expect(screen.getByText("Mistral")).toBeTruthy();
  });

  it("shows inline alert when whisper token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      hfApiToken: "",
      mistralApiKey: "mistral_secret",
    });

    expect(screen.getByText(/ne peut pas fonctionner sans cle api hugging face/i)).toBeInTheDocument();
    expect(screen.getByText(/session en cours du navigateur/i)).toBeInTheDocument();
  });

  it("shows inline alert when mistral token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      hfApiToken: "hf_token",
      mistralApiKey: "",
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.getByText(/ne peut pas fonctionner sans cle api mistral/i)).toBeInTheDocument();
    expect(screen.getByText(/session en cours du navigateur/i)).toBeInTheDocument();
  });

  it("shows diarization switch when provider is mistral", () => {
    renderWithStore(<CloudUploadPage />, {
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: true,
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.getByText("Diarization")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Diarization" })).toBeInTheDocument();
  });

  it("does not show diarization switch when provider is whisper", () => {
    renderWithStore(<CloudUploadPage />, {
      hfApiToken: "hf_token",
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: true,
    });

    expect(screen.queryByText("Diarization")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Diarization" })).toBeNull();
  });

  it("renders summary cards by default and mounts one detail panel on demand", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(
      createHookValue({
        selectedFile: new File(["audio"], "session.wav", { type: "audio/wav" }),
        previewUrl: "blob:mock-session",
        audioMetadata: {
          name: "session.wav",
          durationSec: 24,
          sampleRate: 16000,
        } satisfies AudioMetadata,
        segments: [
          {
            index: 0,
            start: 0,
            end: 5,
            text: "Bonjour",
            speaker: "SPEAKER_00",
            chunkId: "mistral-1",
            strategy: "chunks",
          },
          {
            index: 1,
            start: 5,
            end: 9,
            text: "Suite",
            speaker: "SPEAKER_01",
            chunkId: "mistral-1",
            strategy: "chunks",
          },
          {
            index: 2,
            start: 9,
            end: 14,
            text: "Segment suivant",
            speaker: "SPEAKER_00",
            chunkId: "mistral-2",
            strategy: "chunks",
          },
        ],
      })
    );

    const { container } = renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    const firstChunkCard = screen.getByTestId("cloud-chunk-card-mistral-1");
    const secondChunkCard = screen.getByTestId("cloud-chunk-card-mistral-2");
    const initialCardOrder = Array.from(container.querySelectorAll('[data-testid^="cloud-chunk-card-"]')).map((node) =>
      node.getAttribute("data-testid")
    );

    expect(initialCardOrder).toEqual(["cloud-chunk-card-mistral-1", "cloud-chunk-card-mistral-2"]);
    expect(within(firstChunkCard).getByText("Partie 1")).toBeInTheDocument();
    expect(within(secondChunkCard).getByText("Partie 2")).toBeInTheDocument();
    expect(within(firstChunkCard).getByText("00:00 - 00:09")).toBeInTheDocument();
    expect(within(secondChunkCard).getByText("00:09 - 00:14")).toBeInTheDocument();

    expect(screen.queryByRole("button", { name: /Lecture/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assigner les speakers de la partie/i })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: /speaker/i })).toBeNull();

    fireEvent.click(within(firstChunkCard).getByRole("button", { name: /Ouvrir/i }));

    const detailsPanel = screen.getByTestId("cloud-chunk-details-mistral-1");
    expect(within(detailsPanel).getByRole("button", { name: /Lecture/i })).toBeInTheDocument();
    expect(within(detailsPanel).getByRole("button", { name: /Assigner les speakers de la partie/i })).toBeInTheDocument();
    expect(within(detailsPanel).getByRole("columnheader", { name: /speaker/i })).toBeInTheDocument();
    expect(Array.from(container.querySelectorAll('[data-testid^="cloud-chunk-card-"]')).map((node) => node.getAttribute("data-testid"))).toEqual([
      "cloud-chunk-card-mistral-1",
      "cloud-chunk-card-mistral-2",
    ]);
    expect(screen.getAllByRole("button", { name: /Lecture/i })).toHaveLength(1);
    hookSpy.mockRestore();
  });

  it("virtualizes long cloud chunk lists while preserving the summary order", () => {
    const segments = Array.from({ length: 18 }, (_, index) => ({
      index,
      start: index * 10,
      end: index * 10 + 5,
      text: `Segment ${index + 1}`,
      speaker: index % 2 === 0 ? "SPEAKER_00" : "SPEAKER_01",
      chunkId: `mistral-${index + 1}`,
      strategy: "chunks" as const,
    }));
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(createHookValue({ segments }));

    const { container } = renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    const renderedCards = Array.from(container.querySelectorAll('[data-testid^="cloud-chunk-card-"]')).map((node) =>
      node.getAttribute("data-testid")
    );

    expect(renderedCards.length).toBeLessThan(18);
    expect(renderedCards[0]).toBe("cloud-chunk-card-mistral-1");
    expect(renderedCards).not.toContain("cloud-chunk-card-mistral-18");
    expect(screen.getByText("Partie 1")).toBeInTheDocument();
    hookSpy.mockRestore();
  });

  it("does not expose global speaker assignment in cloud mode", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(
      createHookValue({
        segments: [
          {
            index: 0,
            start: 0,
            end: 2,
            text: "Bonjour",
            speaker: "SPEAKER_00",
            chunkId: "mistral-1",
            strategy: "chunks",
          },
          {
            index: 1,
            start: 3,
            end: 5,
            text: "Salut",
            speaker: "SPEAKER_00",
            chunkId: "mistral-2",
            strategy: "chunks",
          },
        ],
      })
    );

    renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    expect(screen.queryByRole("button", { name: /^Assigner speakers$/i })).toBeNull();
    const firstChunkCard = screen.getByTestId("cloud-chunk-card-mistral-1");
    expect(within(firstChunkCard).queryByRole("button", { name: /Assigner les speakers de la partie/i })).toBeNull();
    fireEvent.click(within(firstChunkCard).getByRole("button", { name: /Ouvrir/i }));
    expect(screen.getByRole("button", { name: /Assigner les speakers de la partie/i })).toBeInTheDocument();
    hookSpy.mockRestore();
  });

  it("updates only the local chunk speaker assignments from a chunk card", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(
      createHookValue({
        selectedFile: new File(["audio"], "session.wav", { type: "audio/wav" }),
        previewUrl: "blob:mock-session",
        audioMetadata: {
          name: "session.wav",
          durationSec: 24,
          sampleRate: 16000,
        } satisfies AudioMetadata,
        segments: [
          {
            index: 0,
            start: 0,
            end: 4,
            text: "Bonjour",
            speaker: "SPEAKER_00",
            chunkId: "mistral-1",
            strategy: "chunks",
          },
          {
            index: 1,
            start: 4,
            end: 8,
            text: "Suite",
            speaker: "SPEAKER_00",
            chunkId: "mistral-2",
            strategy: "chunks",
          },
        ],
      })
    );

    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          "mistral-2::SPEAKER_00": {
            firstName: "Jean",
            lastName: "Dupont",
          },
        },
      },
    });

    renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    const firstChunkCard = screen.getByTestId("cloud-chunk-card-mistral-1");
    fireEvent.click(within(firstChunkCard).getByRole("button", { name: /Ouvrir/i }));
    fireEvent.click(screen.getByRole("button", { name: /Assigner les speakers de la partie/i }));

    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Nom Partie 1 SPEAKER_00"), {
      target: { value: "Martin" },
    });
    fireEvent.change(within(dialog).getByLabelText("Prénom Partie 1 SPEAKER_00"), {
      target: { value: "Alice" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Appliquer" }));

    expect(useAsrStore.getState().speakerAssignments.cloud["mistral-1::SPEAKER_00"]).toEqual({
      firstName: "Alice",
      lastName: "Martin",
    });
    expect(useAsrStore.getState().speakerAssignments.cloud["mistral-2::SPEAKER_00"]).toEqual({
      firstName: "Jean",
      lastName: "Dupont",
    });

    hookSpy.mockRestore();
  });

  it("lets cloud users reassign a segment speaker from the chunk table", async () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockImplementation(() => {
      const [segments, setSegments] = useState([
        {
          index: 0,
          start: 0,
          end: 4,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId: "cloud-1",
          strategy: "chunks" as const,
        },
        {
          index: 1,
          start: 4,
          end: 8,
          text: "Suite",
          speaker: "SPEAKER_00",
          chunkId: "cloud-1",
          strategy: "chunks" as const,
        },
        {
          index: 2,
          start: 8,
          end: 12,
          text: "Réponse",
          speaker: "SPEAKER_01",
          chunkId: "cloud-1",
          strategy: "chunks" as const,
        },
      ]);

      return createHookValue({
        selectedFile: new File(["audio"], "session.wav", { type: "audio/wav" }),
        previewUrl: "blob:mock-session",
        audioMetadata: {
          name: "session.wav",
          durationSec: 24,
          sampleRate: 16000,
        } satisfies AudioMetadata,
        segments,
        updateSegmentSpeaker: (segmentIndex: number, speakerId: string) => {
          setSegments((current) =>
            current.map((segment) => (segment.index === segmentIndex ? { ...segment, speaker: speakerId.trim() } : segment))
          );
        },
      });
    });

    useAsrStore.setState({
      speakerAssignments: {
        upload: {},
        mic: {},
        cloud: {
          "cloud-1::SPEAKER_00": {
            firstName: "Alice",
            lastName: "Dupont",
          },
          "cloud-1::SPEAKER_01": {
            firstName: "Bob",
            lastName: "Martin",
          },
        },
      },
    });

    renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    const chunkCard = screen.getByTestId("cloud-chunk-card-cloud-1");
    fireEvent.click(within(chunkCard).getByRole("button", { name: /Ouvrir/i }));

    const detailsPanel = screen.getByTestId("cloud-chunk-details-cloud-1");
    const firstSpeakerSelect = within(detailsPanel).getByRole("combobox", { name: /speaker du segment 1/i });
    const secondSpeakerSelect = within(detailsPanel).getByRole("combobox", { name: /speaker du segment 2/i });

    expect(firstSpeakerSelect).toHaveTextContent("Dupont Alice · SPEAKER_00");
    expect(secondSpeakerSelect).toHaveTextContent("Dupont Alice · SPEAKER_00");

    fireEvent.click(firstSpeakerSelect);
    fireEvent.click(screen.getByRole("option", { name: "Martin Bob · SPEAKER_01" }));

    await waitFor(() => {
      expect(within(detailsPanel).getByRole("combobox", { name: /speaker du segment 1/i })).toHaveTextContent(
        "Martin Bob · SPEAKER_01"
      );
      expect(within(detailsPanel).getByRole("combobox", { name: /speaker du segment 2/i })).toHaveTextContent(
        "Dupont Alice · SPEAKER_00"
      );
    });

    hookSpy.mockRestore();
  });

  it("shows reset session button in cloud status card", () => {
    renderWithStore(<CloudUploadPage />);
    expect(screen.getByRole("button", { name: /Réinitialiser la session/i })).toBeInTheDocument();
  });

  it("blocks cloud controls when no provider is authorized", () => {
    backendPermissionMocks.canUseCloudProvider.mockReturnValue(false);

    renderWithStore(<CloudUploadPage />);

    expect(screen.getByText(/aucun provider cloud n'est autorisé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lancer la transcription/i })).toBeDisabled();
  });

  it("shows mistral error detail in status card", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(
      createHookValue({
        status: "error",
        statusDetail: "Mistral API (401): Unauthorized",
      })
    );

    renderWithStore(<CloudUploadPage />);

    expect(screen.getByText("Erreur")).toBeInTheDocument();
    expect(screen.getByText("Mistral API (401): Unauthorized")).toBeInTheDocument();
    hookSpy.mockRestore();
  });

  it("renders long prepared upload metadata without dropping the file name", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue(
      createHookValue({
        preparedUpload: {
          provider: "demeter_sante",
          chunkIndex: 1,
          totalChunks: 2,
          fileName: "consultation_super_longue_avec_un_nom_de_fichier_extremement_verbeux_2026_03_12_version_finale_prepared_chunk_01.wav",
          sizeBytes: 21313456,
        },
      })
    );

    renderWithStore(<CloudUploadPage />);

    expect(screen.getByText(/dernier fichier préparé avant envoi/i)).toBeInTheDocument();
    expect(screen.getByText(/consultation_super_longue_avec_un_nom_de_fichier_extremement_verbeux/i)).toBeInTheDocument();
    expect(screen.getByText(/21313456 octets/i)).toBeInTheDocument();
    hookSpy.mockRestore();
  });

  it("allows editing a cloud segment from the table", async () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockImplementation(() => {
      const [segments, setSegments] = useState([
        {
          index: 0,
          start: 0,
          end: 1,
          text: "Bonjour",
          chunkId: "cloud-1",
          strategy: "chunks" as const,
        },
      ]);

      return createHookValue({
        segments,
        updateSegmentText: (segmentIndex: number, text: string) => {
          setSegments((current) =>
            current.map((segment) => (segment.index === segmentIndex ? { ...segment, text: text.trim() } : segment))
          );
        },
      });
    });

    renderWithStore(<CloudUploadPage />, { cloudShowSegments: true });

    const chunkCard = screen.getByTestId("cloud-chunk-card-cloud-1");
    fireEvent.click(within(chunkCard).getByRole("button", { name: /Ouvrir/i }));
    expect(screen.getByTestId("cloud-chunk-details-cloud-1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /modifier le segment 1/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/texte du segment/i), {
      target: { value: "Texte cloud modifié" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enregistrer/i }));

    await waitFor(() => {
      expect(screen.getByText("Texte cloud modifié")).toBeInTheDocument();
    });
    expect(screen.queryByText("Bonjour")).toBeNull();
    hookSpy.mockRestore();
  });
});
