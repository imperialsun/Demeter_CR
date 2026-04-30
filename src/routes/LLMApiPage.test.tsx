/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY } from "@/lib/sessionTranscriptMemory";
import { useAsrStore } from "@/store/asr-store";
import LLMApiPage from "@/routes/LLMApiPage";

const generateAll = vi.fn(async () => undefined);
const downloadDocx = vi.fn(async () => undefined);
const { toastMock, parseTranscriptFileMock, emitLlmEventMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  parseTranscriptFileMock: vi.fn(),
  emitLlmEventMock: vi.fn(),
}));

const backendPermissionMocks = vi.hoisted(() => ({
  canUseLlmProvider: vi.fn(() => true),
  canAccessFeature: vi.fn(() => true),
}));

const hookState = {
  status: "idle",
  progress: 0,
  results: {},
  generateAll,
  downloadDocx,
};

function buildGeneratedResult(format: "CRI" | "CRO" | "CRS", title: string) {
  return {
    format,
    report: {
      format,
      title,
      sections: [{ heading: "Contexte", paragraphs: ["P1"] }],
    },
    rawResponse: "{}",
    modelId: "openai/gpt-oss-20b",
    generatedAt: new Date().toISOString(),
    sourceMode: "text",
    sourceTokenCount: 50,
    pipelinePasses: 1,
    strategy: "chatCompletion",
  } as const;
}

vi.mock("@/hooks/useLlmReports", () => ({
  useLlmReports: () => hookState,
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@/lib/transcript/parseTranscriptFile", async () => {
  const actual = await vi.importActual<typeof import("@/lib/transcript/parseTranscriptFile")>(
    "@/lib/transcript/parseTranscriptFile"
  );
  return {
    ...actual,
    parseTranscriptFile: (...args: unknown[]) => parseTranscriptFileMock(...args),
  };
});

vi.mock("@/lib/llm/telemetrySession", () => ({
  emitLlmEvent: (...args: unknown[]) => emitLlmEventMock(...args),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canUseLlmProvider: (...args: unknown[]) => backendPermissionMocks.canUseLlmProvider(...args),
  canAccessFeature: (...args: unknown[]) => backendPermissionMocks.canAccessFeature(...args),
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

describe("LLMApiPage", () => {
  beforeEach(() => {
    generateAll.mockClear();
    downloadDocx.mockClear();
    toastMock.mockClear();
    parseTranscriptFileMock.mockReset();
    emitLlmEventMock.mockReset();
    window.sessionStorage.clear();
    backendPermissionMocks.canUseLlmProvider.mockReset();
    backendPermissionMocks.canUseLlmProvider.mockReturnValue(true);
    backendPermissionMocks.canAccessFeature.mockReset();
    backendPermissionMocks.canAccessFeature.mockReturnValue(true);
    hookState.status = "idle";
    hookState.progress = 0;
    hookState.results = {};

    useAsrStore.setState({
      llmApiStatus: "idle",
      llmApiProgress: 0,
      llmApiProvider: "huggingface",
      hfApiToken: "hf_test",
      llmApiHfModelId: "openai/gpt-oss-20b",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 1024,
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      llmApiReportDetailLevels: {
        CRI: "standard",
        CRO: "standard",
        CRS: "standard",
        CRN: "standard",
      },
      llmApiStatusDetail: undefined,
      llmApiResults: {},
      mistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      sessionTranscriptMemories: {
        upload: {
          mode: "upload",
          provider: "upload",
          label: "Locale · demo.wav",
          segments: [{ text: "Segment 1" }, { text: "Segment 2" }],
          audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:00:00.000Z",
        },
        mic: null,
        cloud: null,
      },
    } as any);
  });

  function renderPage() {
    return render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <LLMApiPage />
      </ThemeProvider>
    );
  }

  it("triggers generation from transcription source", async () => {
    renderPage();

    await userEvent.click(screen.getByTestId("llm-memory-source-panel"));
    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "upload",
        sourceText: "Segment 1\nSegment 2",
      })
    );
  });

  it("hydrates the latest transcription from sessionStorage before generating", async () => {
    useAsrStore.setState({
      sessionTranscriptMemories: {
        upload: null,
        mic: null,
        cloud: null,
      },
    } as any);
    window.sessionStorage.setItem(
      SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY,
      JSON.stringify({
        upload: {
          mode: "upload",
          provider: "upload",
          label: "Locale · demo.wav",
          transcriptText: "Segment 1\nSegment 2",
          segmentCount: 2,
          audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:00:00.000Z",
        },
        mic: null,
        cloud: null,
      })
    );
    useAsrStore.getState().hydrateFromStorage();

    renderPage();

    expect(screen.getByText(/transcription disponible :/i)).toHaveTextContent("Locale · demo.wav");
    expect(screen.queryByText(/aucune transcription disponible en mémoire/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer les comptes rendus/i })).not.toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: /générer les comptes rendus/i }));
    expect(generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "upload",
        sourceText: "Segment 1\nSegment 2",
      })
    );
  });

  it("emits cloud page view telemetry on mount", () => {
    renderPage();
    expect(emitLlmEventMock).toHaveBeenCalledWith("LLM_CLOUD_PAGE_VIEW", {
      route: "/llmapi",
      mode: "cloud",
    });
  });

  it("shows rédaction title and configuration guidance", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Rédaction" })).toBeInTheDocument();
    expect(screen.getByText(/configuration du provider/i)).toBeInTheDocument();
    expect(screen.getByText(/paramètres > llm cloud/i)).toBeInTheDocument();
  });

  it("renders the llm workflow in one clear column", () => {
    renderPage();

    expect(screen.queryByRole("heading", { name: "Configuration API" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Provider LLM", { selector: "button#llm-provider" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Mode d'entrée", { selector: "button#llm-source" })).not.toBeInTheDocument();

    const source = screen.getByRole("heading", { name: "Source" });
    const formats = screen.getByRole("heading", { name: "Formats de compte rendu" });
    const generationActions = screen.getByTestId("llm-generation-actions");
    const progress = screen.getByRole("heading", { name: "Progression" });
    const results = screen.getByRole("heading", { name: "Résultats des comptes rendus" });

    expect(source.compareDocumentPosition(formats) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(formats.compareDocumentPosition(generationActions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(generationActions).toHaveClass("justify-center");
    expect(generationActions.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(formats.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(progress.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders the two visible source choices", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Charger depuis la transcription en mémoire" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Charger depuis un document de transcription ou une prise de note" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /charger depuis la transcription en mémoire/i })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choisir un fichier/i })).toBeInTheDocument();
    expect(within(screen.getByTestId("llm-memory-source-panel")).getByText("Source active")).toBeInTheDocument();
    expect(within(screen.getByTestId("llm-source-card")).queryByRole("button", { name: /générer les comptes rendus/i })).toBeNull();
    expect(within(screen.getByTestId("llm-source-card")).queryByRole("button", { name: /réinitialiser la session llm/i })).toBeNull();
  });

  it("renders report detail sliders and updates the store", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Formats de compte rendu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replier" })).toHaveAttribute("aria-expanded", "true");

    let criFormatBlock = screen.getByTestId("report-format-switch-cri");
    fireEvent.change(within(criFormatBlock).getByLabelText("Compte rendu détaillé", { selector: "input#report-detail-cri" }), {
      target: { value: "1" },
    });

    expect(useAsrStore.getState().llmApiReportDetailLevels.CRI).toBe("verbose");

    fireEvent.click(within(criFormatBlock).getByRole("switch", { name: "Compte rendu détaillé activé" }));
    criFormatBlock = screen.getByTestId("report-format-switch-cri");
    expect(within(criFormatBlock).getByRole("switch", { name: "Compte rendu détaillé désactivé" })).toBeInTheDocument();
    expect(within(criFormatBlock).queryByLabelText("Compte rendu détaillé", { selector: "input#report-detail-cri" })).not.toBeInTheDocument();

    fireEvent.click(within(criFormatBlock).getByRole("switch", { name: "Compte rendu détaillé désactivé" }));
    criFormatBlock = screen.getByTestId("report-format-switch-cri");
    expect(within(criFormatBlock).getByLabelText("Compte rendu détaillé", { selector: "input#report-detail-cri" })).toHaveValue("1");
  });

  it("collapses and expands the whole report format section", () => {
    renderPage();

    expect(screen.getByTestId("report-format-switch-cri")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replier" }));
    expect(screen.queryByTestId("report-format-switch-cri")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Déplier" })).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByRole("button", { name: "Déplier" }));
    expect(screen.getByTestId("report-format-switch-cri")).toBeInTheDocument();
  });

  it("disables memory source when no transcript is available", () => {
    useAsrStore.setState({
      sessionTranscriptMemories: {
        upload: null,
        mic: null,
        cloud: null,
      },
    } as any);

    renderPage();

    expect(screen.getByRole("button", { name: /charger depuis la transcription en mémoire/i })).toHaveAttribute(
      "aria-disabled",
      "true"
    );
    expect(screen.getByText(/aucune transcription disponible en mémoire/i)).toBeInTheDocument();
    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).toBeDisabled();
  });

  it("selects the document source by clicking the document panel", async () => {
    renderPage();

    const documentPanel = screen.getByTestId("llm-document-source-panel");
    await userEvent.click(documentPanel);

    expect(within(documentPanel).getByText("Source active")).toBeInTheDocument();
    expect(within(screen.getByTestId("llm-memory-source-panel")).queryByText("Source active")).toBeNull();
    expect(screen.getByText(/importez un fichier pour lancer la génération/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer les comptes rendus/i })).toBeDisabled();
  });

  it("shows the assistant-style empty results panel before generation", () => {
    renderPage();

    expect(screen.getByRole("heading", { name: "Résultats des comptes rendus" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Édition des formats" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-editor-cri")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /téléchargements docx/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /télécharger le compte rendu détaillé/i })).not.toBeInTheDocument();
    expect(screen.getByText(/les comptes rendus apparaîtront ici au fil de leur réception/i)).toBeInTheDocument();
  });

  it("shows assistant-style report cards and downloads generated formats", async () => {
    hookState.results = {
      cri: buildGeneratedResult("CRI", "Titre CRI"),
    } as any;

    renderPage();

    expect(screen.queryByRole("region", { name: /téléchargements docx/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("report-editor-cri")).not.toBeInTheDocument();
    const card = screen.getByTestId("report-result-card-cri");
    expect(within(card).getByText("Titre CRI")).toBeInTheDocument();
    expect(within(card).getByText("Reçu")).toBeInTheDocument();

    const downloadCri = screen.getByRole("button", { name: /télécharger le compte rendu détaillé/i });
    expect(downloadCri).not.toBeDisabled();
    expect(screen.getByRole("button", { name: /télécharger le compte rendu opérationnel/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /télécharger le compte rendu synthétique/i })).toBeDisabled();

    await userEvent.click(downloadCri);
    expect(downloadDocx).toHaveBeenCalledWith("cri");
  });

  it("enables all generated DOCX downloads", () => {
    hookState.results = {
      cri: buildGeneratedResult("CRI", "Titre CRI"),
      cro: buildGeneratedResult("CRO", "Titre CRO"),
      crs: buildGeneratedResult("CRS", "Titre CRS"),
    } as any;

    renderPage();

    expect(screen.getByRole("button", { name: /télécharger le compte rendu détaillé/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /télécharger le compte rendu opérationnel/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /télécharger le compte rendu synthétique/i })).toBeInTheDocument();
  });

  it("shows inline alert when llm token is missing", () => {
    useAsrStore.setState({ hfApiToken: "" } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans clé api hugging face/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when llm token is missing", async () => {
    useAsrStore.setState({ hfApiToken: "" } as any);

    renderPage();

    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);

    expect(toastMock).toHaveBeenCalledWith("Ce module ne peut pas fonctionner sans clé API Hugging Face.");
    expect(generateAll).not.toHaveBeenCalled();
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_GENERATION_BLOCKED",
      expect.objectContaining({ reason: "missing_token" })
    );
  });

  it("hides settings links when feature.settings is forbidden", () => {
    backendPermissionMocks.canAccessFeature.mockImplementation((permission: string) =>
      permission === "feature.settings" ? false : true
    );

    renderPage();

    expect(screen.queryByRole("link", { name: /ouvrir paramètres llm/i })).toBeNull();
  });

  it("blocks generation when no llm provider is authorized", () => {
    backendPermissionMocks.canUseLlmProvider.mockReturnValue(false);

    renderPage();

    expect(screen.getByText(/aucun provider llm cloud n'est activé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer les comptes rendus/i })).toBeDisabled();
  });

  it("shows inline alert when mistral token is missing", () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      mistralApiKey: "",
      llmApiMistralModelId: "mistral-medium-latest",
    } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans clé api mistral/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when mistral token is missing", async () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      mistralApiKey: "",
      llmApiMistralModelId: "mistral-medium-latest",
    } as any);

    renderPage();

    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(toastMock).toHaveBeenCalledWith("Ce module ne peut pas fonctionner sans clé API Mistral.");
    expect(generateAll).not.toHaveBeenCalled();
  });

  it("shows estimated tokens for transcription source", () => {
    renderPage();
    expect(screen.getByText(/tokens source approx/i)).toBeInTheDocument();
  });

  it("lets the user choose explicitly between stored local and cloud transcriptions", async () => {
    useAsrStore.setState({
      sessionTranscriptMemories: {
        upload: {
          mode: "upload",
          provider: "upload",
          label: "Locale · demo.wav",
          segments: [{ text: "Texte local" }],
          audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:00:00.000Z",
        },
        mic: null,
        cloud: {
          mode: "cloud",
          provider: "mistral",
          label: "Cloud Mistral · demo.wav",
          segments: [{ text: "Texte cloud" }],
          audioSource: { id: "cloud-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:05:00.000Z",
        },
      },
    } as any);

    renderPage();

    expect(screen.getByLabelText("Transcription à utiliser", { selector: "button#llm-session-transcript" })).toBeInTheDocument();
    expect(screen.getAllByText(/Cloud Mistral · demo.wav/i).length).toBeGreaterThan(0);

    const transcriptSelect = screen.getByLabelText("Transcription à utiliser", {
      selector: "button#llm-session-transcript",
    });
    fireEvent.click(transcriptSelect);
    fireEvent.click(await screen.findByText("Locale · demo.wav"));

    await userEvent.click(screen.getByRole("button", { name: /générer les comptes rendus/i }));
    expect(generateAll).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "transcription",
        transcriptMode: "upload",
        sourceText: "Texte local",
      })
    );
  });

  it("imports txt file and enables generation", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const fileInput = await screen.findByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-source-file",
    });
    const file = new File(["dummy"], "source.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getAllByText("source.txt").length).toBeGreaterThan(0);
    });
    expect(within(screen.getByTestId("llm-document-source-panel")).getByText("Source active")).toBeInTheDocument();
    const generateButton = screen.getByRole("button", { name: /générer les comptes rendus/i });
    await waitFor(() => expect(generateButton).not.toBeDisabled());
    expect(parseTranscriptFileMock).toHaveBeenCalled();
    expect(screen.getByText(/tokens du fichier importé approx/i)).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Fichier importé: source.txt"));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_IMPORT_START",
      expect.objectContaining({ fileName: "source.txt" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_IMPORT_SUCCESS",
      expect.objectContaining({ fileName: "source.txt" })
    );
    expect(useAsrStore.getState().sessionTranscriptMemories.upload?.label).toBe("Locale · demo.wav");

    await userEvent.click(generateButton);
    expect(generateAll).toHaveBeenCalledWith({ source: "text", text: "Texte importe depuis fichier" });
  });

  it("accepts docx imports in free text mode", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis docx",
      format: "docx",
      extraction: "plain",
    });

    renderPage();

    const fileInput = screen.getByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-source-file",
    });
    expect(fileInput.getAttribute("accept")).toContain(".docx");

    const file = new File(["dummy"], "source.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getAllByText("source.docx").length).toBeGreaterThan(0);
    });
    expect(parseTranscriptFileMock).toHaveBeenCalled();
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_IMPORT_SUCCESS",
      expect.objectContaining({ fileName: "source.docx", format: "docx" })
    );
  });

  it("imports srt and json file outputs into free text source", async () => {
    parseTranscriptFileMock
      .mockResolvedValueOnce({
        text: "Ligne srt 1\nLigne srt 2",
        format: "srt",
        extraction: "segments",
        segmentCount: 2,
      })
      .mockResolvedValueOnce({
        text: "Ligne json",
        format: "json",
        extraction: "results",
        segmentCount: 1,
      });

    renderPage();

    const fileInput = await screen.findByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-source-file",
    });

    fireEvent.change(fileInput, { target: { files: [new File(["srt"], "transcription.srt", { type: "text/plain" })] } });
    await waitFor(() => {
      expect(screen.getAllByText("transcription.srt").length).toBeGreaterThan(0);
    });

    fireEvent.change(fileInput, { target: { files: [new File(["json"], "segments.json", { type: "application/json" })] } });
    await waitFor(() => {
      expect(screen.getAllByText("segments.json").length).toBeGreaterThan(0);
    });
    expect(parseTranscriptFileMock).toHaveBeenCalledTimes(2);
  });

  it("keeps existing text and shows toast when import is invalid", async () => {
    parseTranscriptFileMock
      .mockResolvedValueOnce({
        text: "Texte manuel conserve",
        format: "txt",
        extraction: "plain",
      })
      .mockRejectedValueOnce(new Error("Fichier non interpretable: aucun texte de transcription detecte."));

    renderPage();

    const fileInput = await screen.findByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-source-file",
    });
    fireEvent.change(fileInput, { target: { files: [new File(["ok"], "source.txt", { type: "text/plain" })] } });
    await waitFor(() => {
      expect(screen.getAllByText("source.txt").length).toBeGreaterThan(0);
    });

    fireEvent.change(fileInput, { target: { files: [new File(["bad"], "telemetry.json", { type: "application/json" })] } });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Fichier non interpretable: aucun texte de transcription detecte.");
    });
    const generateButton = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(generateButton).not.toBeDisabled();
    await userEvent.click(generateButton);
    expect(generateAll).toHaveBeenCalledWith({ source: "text", text: "Texte manuel conserve" });
  });

  it("shows clear toast when imported file is too large", async () => {
    parseTranscriptFileMock.mockRejectedValue(new Error("Fichier trop volumineux (max 50 Mo)."));

    renderPage();

    const fileInput = await screen.findByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-source-file",
    });
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "huge.txt", { type: "text/plain" })] } });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Fichier trop volumineux (max 50 Mo).");
    });
  });

  it("keeps provider and token controls out of the rédaction page", () => {
    renderPage();

    expect(screen.queryByLabelText("Provider LLM", { selector: "button#llm-provider" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Token Hugging Face", { selector: "input#llm-api-token" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Clé API Mistral", { selector: "input#llm-mistral-api-key" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Formats de compte rendu" })).toBeInTheDocument();
    expect(within(screen.getByTestId("report-format-switch-cri")).getByLabelText("Compte rendu détaillé", {
      selector: "input#report-detail-cri",
    })).toBeInTheDocument();

    expect(screen.queryByLabelText("ID du modèle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Température")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Nombre max de tokens")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URL API Mistral")).not.toBeInTheDocument();
  });

  it("shows blocking config message when model id is missing", () => {
    useAsrStore.setState({ llmApiHfModelId: "" } as any);

    renderPage();

    expect(screen.getByText(/configuration du pipeline incomplète/i)).toBeInTheDocument();
    expect(screen.getByText(/renseignez l'id du modèle dans paramètres > llm cloud/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer les comptes rendus/i })).toBeDisabled();
    expect(screen.getAllByRole("link", { name: /ouvrir paramètres llm/i })[0]).toHaveAttribute(
      "href",
      "/settings?tab=llm"
    );
  });

  it("emits download telemetry events", async () => {
    hookState.results = {
      cri: {
        format: "CRI",
        report: {
          format: "CRI",
          title: "Titre CRI",
          sections: [{ heading: "Contexte", paragraphs: ["P1"] }],
        },
        rawResponse: "{}",
        modelId: "openai/gpt-oss-20b",
        generatedAt: new Date().toISOString(),
        sourceMode: "text",
        sourceTokenCount: 50,
        pipelinePasses: 1,
        strategy: "chatCompletion",
      },
    } as any;

    renderPage();
    expect(screen.queryByRole("button", { name: /réinitialiser la session llm/i })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: /télécharger le compte rendu détaillé/i }));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_REQUESTED",
      expect.objectContaining({ format: "cri" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_DONE",
      expect.objectContaining({ format: "cri" })
    );
  });

  it("renders generated report preview content in the results panel", () => {
    hookState.results = {
      cro: {
        format: "CRO",
        report: {
          format: "CRO",
          title: "Compte rendu CRO",
          subtitle: "Sous titre",
          sections: [{ heading: "Synthese", paragraphs: ["Bloc A", "Bloc B"] }],
          key_points: ["Point 1", "Point 2"],
          action_items: ["Action A"],
          caveats: ["Risque X"],
        },
        rawResponse: "{}",
        modelId: "openai/gpt-oss-20b",
        generatedAt: new Date().toISOString(),
        sourceMode: "transcription",
        sourceTokenCount: 42,
        pipelinePasses: 2,
        strategy: "chatCompletion",
      },
    } as any;

    renderPage();

    const card = screen.getByTestId("report-result-card-cro");
    expect(within(card).getByText("Compte rendu CRO")).toBeInTheDocument();
    expect(within(card).getByText("Sous titre")).toBeInTheDocument();
    expect(within(card).getByText("Synthese")).toBeInTheDocument();
    expect(within(card).getByText("Bloc A")).toBeInTheDocument();
    expect(screen.queryByText(/apercu live/i)).toBeNull();
  });

  it("handles download failure with toast and telemetry event", async () => {
    const criResult = {
      format: "CRI",
      report: { format: "CRI", title: "CRI", sections: [{ heading: "H", paragraphs: ["p"] }] },
      rawResponse: "{}",
      modelId: "openai/gpt-oss-20b",
      generatedAt: new Date().toISOString(),
      sourceMode: "transcription",
      sourceTokenCount: 20,
      pipelinePasses: 1,
      strategy: "chatCompletion",
    };
    hookState.results = { cri: criResult } as any;
    useAsrStore.setState({
      llmApiResults: {
        cri: criResult,
      },
    } as any);
    downloadDocx.mockRejectedValueOnce(new Error("download boom"));

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /télécharger le compte rendu détaillé/i }));

    expect(toastMock).toHaveBeenCalledWith("download boom");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_FAILED",
      expect.objectContaining({ format: "cri", message: "download boom" })
    );
  });

  it("triggers the hidden file picker button in text source mode", async () => {
    renderPage();

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    await userEvent.click(screen.getByRole("button", { name: /choisir un fichier/i }));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

});
