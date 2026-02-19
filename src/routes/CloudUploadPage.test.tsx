import { afterEach, describe, it, expect, vi } from "vitest";
import { renderWithStore } from "@/test/utils";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { useAsrStore } from "@/store/asr-store";
import CloudUploadPage from "./CloudUploadPage";
import * as cloudHook from "@/hooks/useCloudTranscription";

describe("CloudUploadPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows cloud export defaults (VTT/SRT/JSON enabled, Telemetry disabled)", () => {
    useAsrStore.getState().resetApp();
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
    });

    expect(screen.getByRole("button", { name: /VTT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SRT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /JSON/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Telemetry/i })).toBeNull();
  });

  it("renders export buttons above the segments area", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudShowSegments: true,
      segments: [],
      cloudShowExportVtt: true,
      cloudShowExportSrt: true,
      cloudShowExportJson: true,
      cloudShowExportTelemetry: false,
    });

    const vttButton = screen.getByRole("button", { name: /VTT/i });
    const placeholder = screen.getByText(/Les segments apparaîtront ici dès que la transcription aura démarré\./i);
    expect(vttButton.compareDocumentPosition(placeholder) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses cloud export toggles independently from local export toggles", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      showExportVtt: false,
      showExportSrt: false,
      showExportJson: false,
      showExportTelemetry: true,
      cloudShowExportVtt: true,
      cloudShowExportSrt: true,
      cloudShowExportJson: true,
      cloudShowExportTelemetry: false,
    });

    expect(screen.getByRole("button", { name: /VTT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /SRT/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /JSON/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Telemetry/i })).toBeNull();
  });

  it("renders the cloud upload UI with all providers", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudMaxTokens: 2048,
      cloudTemperature: 0.4,
      cloudTopP: 0.8,
      cloudDoSample: true,
    });
    expect(screen.getByText("Transcription cloud")).toBeTruthy();
    expect(screen.getByText("Provider")).toBeTruthy();
    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    expect(providerSelect.textContent).toContain("Gradio");
    expect(screen.getByText(/Afficher le contexte/i)).toBeTruthy();
    expect(screen.getByText("Importer un fichier audio")).toBeTruthy();
    expect(screen.getByText("Lancer la transcription")).toBeTruthy();

    fireEvent.click(providerSelect);
    expect(screen.getByText("Whisper")).toBeTruthy();
    expect(screen.getByText("Mistral")).toBeTruthy();
  });

  it("shows inline alert when whisper token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      hfApiToken: "",
      mistralApiKey: "mistral_secret",
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Whisper"));

    expect(screen.getByText(/ne peut pas fonctionner sans cle api hugging face/i)).toBeInTheDocument();
  });

  it("shows inline alert when mistral token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      hfApiToken: "hf_token",
      mistralApiKey: "",
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.getByText(/ne peut pas fonctionner sans cle api mistral/i)).toBeInTheDocument();
  });

  it("shows diarization switch when provider is mistral", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
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
      cloudApiUrl: "https://cloud.example",
      hfApiToken: "hf_token",
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: true,
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Whisper"));

    expect(screen.queryByText("Diarization")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Diarization" })).toBeNull();
  });

  it("updates store when toggling mistral diarization switch", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: true,
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    const diarizationSwitch = screen.getByRole("switch", { name: "Diarization" });
    expect(useAsrStore.getState().cloudMistralDiarizationEnabled).toBe(true);

    fireEvent.click(diarizationSwitch);
    expect(useAsrStore.getState().cloudMistralDiarizationEnabled).toBe(false);

    fireEvent.click(diarizationSwitch);
    expect(useAsrStore.getState().cloudMistralDiarizationEnabled).toBe(true);
  });

  it("shows speaker column only when mistral diarization is enabled", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue({
      selectedFile: null,
      previewFile: null,
      previewUrl: null,
      audioMetadata: null,
      segments: [
        {
          index: 0,
          start: 0,
          end: 1,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId: "mistral-1",
          strategy: "chunks",
        },
      ],
      telemetrySummary: null,
      status: "idle",
      statusDetail: null,
      progress: 0,
      isTranscribing: false,
      isResettingSession: false,
      stopRequested: false,
      sessionContext: "",
      setSessionContext: vi.fn(),
      combinedContext: "",
      handleFileSelected: vi.fn(),
      startTranscription: vi.fn(),
      stopTranscription: vi.fn(),
      resetTranscriptionSession: vi.fn(),
    });
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: true,
      cloudShowSegments: true,
    });

    expect(screen.queryByRole("columnheader", { name: /speaker/i })).toBeNull();
    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.getByRole("columnheader", { name: /speaker/i })).toBeInTheDocument();
    hookSpy.mockRestore();
  });

  it("hides speaker column when mistral diarization is disabled", () => {
    const hookSpy = vi.spyOn(cloudHook, "useCloudTranscription").mockReturnValue({
      selectedFile: null,
      previewFile: null,
      previewUrl: null,
      audioMetadata: null,
      segments: [
        {
          index: 0,
          start: 0,
          end: 1,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId: "mistral-1",
          strategy: "chunks",
        },
      ],
      telemetrySummary: null,
      status: "idle",
      statusDetail: null,
      progress: 0,
      isTranscribing: false,
      isResettingSession: false,
      stopRequested: false,
      sessionContext: "",
      setSessionContext: vi.fn(),
      combinedContext: "",
      handleFileSelected: vi.fn(),
      startTranscription: vi.fn(),
      stopTranscription: vi.fn(),
      resetTranscriptionSession: vi.fn(),
    });
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      mistralApiKey: "mistral_secret",
      cloudMistralDiarizationEnabled: false,
      cloudShowSegments: true,
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.queryByRole("columnheader", { name: /speaker/i })).toBeNull();
    hookSpy.mockRestore();
  });

  it("shows reset session button in cloud status card", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
    });
    expect(screen.getByRole("button", { name: /Réinitialiser la session/i })).toBeInTheDocument();
  });

  it("resets cloud session context when clicking reset session", async () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudContextPreset: "Preset",
    });

    fireEvent.click(screen.getByRole("button", { name: /Afficher le contexte/i }));
    const textarea = screen.getByLabelText(/Contexte de session \(prioritaire\)/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Contexte temporaire" } });
    expect(textarea.value).toBe("Contexte temporaire");

    fireEvent.click(screen.getByRole("button", { name: /Réinitialiser la session/i }));

    await waitFor(() => {
      const nextTextarea = screen.getByLabelText(/Contexte de session \(prioritaire\)/i) as HTMLTextAreaElement;
      expect(nextTextarea.value).toBe("");
    });
  });
});
