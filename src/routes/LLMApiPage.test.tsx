/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { formatTokenCount } from "@/lib/llm/modelCatalog";
import { useAsrStore } from "@/store/asr-store";
import LLMApiPage from "@/routes/LLMApiPage";
import { DEMETER_SANTE_MAX_TOKENS } from "@/lib/llm/providerSettings";

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

function createDataTransfer() {
  const store: Record<string, string> = {};
  return {
    effectAllowed: "all",
    dropEffect: "move",
    setData: (type: string, value: string) => {
      store[type] = value;
    },
    getData: (type: string) => store[type] ?? "",
  } as DataTransfer;
}

vi.mock("@/hooks/useLlmReports", () => ({
  useLlmReports: () => hookState,
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@/lib/transcript/parseTranscriptFile", () => ({
  parseTranscriptFile: (...args: unknown[]) => parseTranscriptFileMock(...args),
}));

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
      llmApiStatusDetail: undefined,
      llmApiResults: {},
      llmApiReportDrafts: {},
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

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(generateAll).toHaveBeenCalledWith({ source: "transcription", transcriptMode: "upload" });
  });

  it("emits cloud page view telemetry on mount", () => {
    renderPage();
    expect(emitLlmEventMock).toHaveBeenCalledWith("LLM_CLOUD_PAGE_VIEW", {
      route: "/llmapi",
      mode: "cloud",
    });
  });

  it("shows cloud external api note with local equivalent", () => {
    renderPage();
    expect(screen.getByText(/module utilise une api externe/i)).toBeInTheDocument();
    expect(screen.getByText(/llm local \(\/llmlocal\)/i)).toBeInTheDocument();
  });

  it("requires an imported file when source is texte libre", async () => {
    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: /choisir un fichier/i })).toBeInTheDocument();
    expect(screen.getByText(/importez un fichier pour lancer la generation/i)).toBeInTheDocument();
  });

  it("enables download buttons when results exist", async () => {
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

    const downloadCri = screen.getByRole("button", { name: /telecharger cri/i });
    expect(downloadCri).not.toBeDisabled();

    await userEvent.click(downloadCri);
    expect(downloadDocx).toHaveBeenCalledWith("cri");
  });

  it("updates the draft after editing a generated report and resets to the cloud version", async () => {
    const generatedResult = {
      format: "CRI",
      report: {
        format: "CRI",
        title: "Titre initial",
        subtitle: "Sous titre initial",
        sections: [{ heading: "Contexte", paragraphs: ["Paragraphe initial"] }],
        key_points: ["Point initial"],
        action_items: ["Action initial"],
        caveats: ["Vigilance initial"],
      },
      rawResponse: "{}",
      modelId: "openai/gpt-oss-20b",
      generatedAt: new Date().toISOString(),
      sourceMode: "text",
      sourceTokenCount: 50,
      pipelinePasses: 1,
      strategy: "chatCompletion",
    } as const;

    hookState.results = { cri: generatedResult } as any;
    useAsrStore.setState({
      llmApiStatus: "done",
      llmApiResults: { cri: generatedResult },
      llmApiReportDrafts: {},
    } as any);

    renderPage();

    const editor = screen.getByTestId("report-editor-cri");
    const titleInput = within(editor).getByLabelText("Titre");

    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Titre modifie");

    await waitFor(() => {
      expect(within(editor).getByDisplayValue("Titre modifie")).toBeInTheDocument();
    });
    expect(screen.getAllByText("Modifie").length).toBeGreaterThan(0);

    await userEvent.click(within(editor).getByRole("button", { name: /reinitialiser ce format/i }));

    await waitFor(() => {
      expect(within(editor).getByDisplayValue("Titre initial")).toBeInTheDocument();
    });
    expect(useAsrStore.getState().llmApiReportDrafts.cri).toBeUndefined();
  });

  it("reorders sections with drag and drop", async () => {
    const generatedResult = {
      format: "CRI",
      report: {
        format: "CRI",
        title: "Titre",
        sections: [
          { heading: "Premier bloc", paragraphs: ["P1"] },
          { heading: "Deuxieme bloc", paragraphs: ["P2"] },
        ],
      },
      rawResponse: "{}",
      modelId: "openai/gpt-oss-20b",
      generatedAt: new Date().toISOString(),
      sourceMode: "text",
      sourceTokenCount: 50,
      pipelinePasses: 1,
      strategy: "chatCompletion",
    } as const;

    hookState.results = { cri: generatedResult } as any;
    useAsrStore.setState({
      llmApiStatus: "done",
      llmApiResults: { cri: generatedResult },
      llmApiReportDrafts: {},
    } as any);

    renderPage();

    const editor = screen.getByTestId("report-editor-cri");
    const sectionCards = [screen.getByTestId("cri-section-card-0"), screen.getByTestId("cri-section-card-1")];
    const dragHandle = within(sectionCards[1]!).getByLabelText("Déplacer Section 2");
    const dataTransfer = createDataTransfer();

    fireEvent.dragStart(dragHandle, { dataTransfer });
    fireEvent.dragOver(sectionCards[0]!, { dataTransfer });
    fireEvent.drop(sectionCards[0]!, { dataTransfer });

    await waitFor(() => {
      const orderedHeadings = within(editor).getAllByLabelText("Titre de section") as HTMLInputElement[];
      expect(orderedHeadings[0]?.value).toBe("Deuxieme bloc");
      expect(orderedHeadings[1]?.value).toBe("Premier bloc");
    });
  });

  it("reorders paragraphs and list items with fallback buttons", async () => {
    const generatedResult = {
      format: "CRI",
      report: {
        format: "CRI",
        title: "Titre",
        sections: [{ heading: "Premier bloc", paragraphs: ["Paragraphe 1", "Paragraphe 2"] }],
        key_points: ["Point 1", "Point 2"],
      },
      rawResponse: "{}",
      modelId: "openai/gpt-oss-20b",
      generatedAt: new Date().toISOString(),
      sourceMode: "text",
      sourceTokenCount: 50,
      pipelinePasses: 1,
      strategy: "chatCompletion",
    } as const;

    hookState.results = { cri: generatedResult } as any;
    useAsrStore.setState({
      llmApiStatus: "done",
      llmApiResults: { cri: generatedResult },
      llmApiReportDrafts: {},
    } as any);

    renderPage();

    const paragraphCard = screen.getByTestId("cri-section-0-paragraphs-item-0");
    const paragraphMoveDown = within(paragraphCard).getByRole("button", { name: /descendre/i });
    await userEvent.click(paragraphMoveDown);

    await waitFor(() => {
      const paragraphInputs = within(screen.getByTestId("report-editor-cri")).getAllByLabelText(/Paragraphe \d+/);
      expect((paragraphInputs[0] as HTMLTextAreaElement)?.value).toBe("Paragraphe 2");
      expect((paragraphInputs[1] as HTMLTextAreaElement)?.value).toBe("Paragraphe 1");
    });

    const keyPointCard = screen.getByTestId("cri-key-points-item-0");
    const keyPointMoveDown = within(keyPointCard).getByRole("button", { name: /descendre/i });
    await userEvent.click(keyPointMoveDown);

    await waitFor(() => {
      const keyPointInputs = within(screen.getByTestId("report-editor-cri")).getAllByLabelText(/Point clé \d+/);
      expect((keyPointInputs[0] as HTMLTextAreaElement)?.value).toBe("Point 2");
      expect((keyPointInputs[1] as HTMLTextAreaElement)?.value).toBe("Point 1");
    });
  });

  it("shows inline alert when llm token is missing", () => {
    useAsrStore.setState({ hfApiToken: "" } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans cle api hugging face/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when llm token is missing", async () => {
    useAsrStore.setState({ hfApiToken: "" } as any);

    renderPage();

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);

    expect(toastMock).toHaveBeenCalledWith("Ce module ne peut pas fonctionner sans cle API Hugging Face.");
    expect(generateAll).not.toHaveBeenCalled();
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_GENERATION_BLOCKED",
      expect.objectContaining({ reason: "missing_token" })
    );
  });

  it("switches to mistral provider and keeps mistral pipeline config", async () => {
    renderPage();

    const providerSelect = screen.getByLabelText("Provider LLM", { selector: "button#llm-provider" });
    fireEvent.click(providerSelect);
    fireEvent.click(await screen.findByText("Mistral"));

    expect(useAsrStore.getState().llmApiProvider).toBe("mistral");
    expect(screen.getByLabelText("Cle API Mistral", { selector: "input#llm-mistral-api-key" })).toBeInTheDocument();
    expect(screen.queryByLabelText("URL API Mistral")).not.toBeInTheDocument();
    expect(screen.getByText(/Model ID:/i)).toBeInTheDocument();
    expect(screen.getByText("mistral-medium-latest")).toBeInTheDocument();
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_PROVIDER_CHANGE",
      expect.objectContaining({ previousProvider: "huggingface", nextProvider: "mistral" })
    );
  });

  it("shows hardcoded demeter max tokens in pipeline config", async () => {
    useAsrStore.setState({
      llmApiProvider: "demeter_sante",
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralMaxTokens: 8192,
    } as any);

    renderPage();

    expect(
      screen.getByText((_, element) =>
        element?.tagName === "P" &&
        (element.textContent ?? "").includes(`Max tokens: ${formatTokenCount(DEMETER_SANTE_MAX_TOKENS)}`)
      )
    ).toBeInTheDocument();
  });

  it("hides settings links when feature.settings is forbidden", () => {
    backendPermissionMocks.canAccessFeature.mockImplementation((permission: string) =>
      permission === "feature.settings" ? false : true
    );

    renderPage();

    expect(screen.queryByRole("link", { name: /ouvrir parametres llm/i })).toBeNull();
  });

  it("blocks generation when no llm provider is authorized", () => {
    backendPermissionMocks.canUseLlmProvider.mockReturnValue(false);

    renderPage();

    expect(screen.getByText(/aucun provider llm cloud autorisé/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generer les 3 formats/i })).toBeDisabled();
  });

  it("shows inline alert when mistral token is missing", () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      mistralApiKey: "",
      llmApiMistralModelId: "mistral-medium-latest",
    } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans cle api mistral/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when mistral token is missing", async () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      mistralApiKey: "",
      llmApiMistralModelId: "mistral-medium-latest",
    } as any);

    renderPage();

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(toastMock).toHaveBeenCalledWith("Ce module ne peut pas fonctionner sans cle API Mistral.");
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

    await userEvent.click(screen.getByRole("button", { name: /generer les 3 formats/i }));
    expect(generateAll).toHaveBeenCalledWith({ source: "transcription", transcriptMode: "upload" });
  });

  it("imports txt file and enables generation", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = await screen.findByLabelText("Importer un fichier transcription", {
      selector: "input#llm-source-file",
    });
    const file = new File(["dummy"], "source.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      expect(screen.getAllByText("source.txt").length).toBeGreaterThan(0);
    });
    const generateButton = screen.getByRole("button", { name: /generer les 3 formats/i });
    await waitFor(() => expect(generateButton).not.toBeDisabled());
    expect(parseTranscriptFileMock).toHaveBeenCalled();
    expect(screen.getByText(/tokens du fichier importe approx/i)).toBeInTheDocument();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining("Fichier importe: source.txt"));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_IMPORT_START",
      expect.objectContaining({ fileName: "source.txt" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_IMPORT_SUCCESS",
      expect.objectContaining({ fileName: "source.txt" })
    );
    expect(useAsrStore.getState().sessionTranscriptMemories.upload?.label).toBe("Locale · demo.wav");
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

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = await screen.findByLabelText("Importer un fichier transcription", {
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

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = await screen.findByLabelText("Importer un fichier transcription", {
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
    const generateButton = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(generateButton).not.toBeDisabled();
    await userEvent.click(generateButton);
    expect(generateAll).toHaveBeenCalledWith({ source: "text", text: "Texte manuel conserve" });
  });

  it("shows clear toast when imported file is too large", async () => {
    parseTranscriptFileMock.mockRejectedValue(new Error("Fichier trop volumineux (max 50 Mo)."));

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = await screen.findByLabelText("Importer un fichier transcription", {
      selector: "input#llm-source-file",
    });
    fireEvent.change(fileInput, { target: { files: [new File(["x"], "huge.txt", { type: "text/plain" })] } });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("Fichier trop volumineux (max 50 Mo).");
    });
  });

  it("keeps only provider and token controls on llm page", () => {
    renderPage();

    expect(screen.getByLabelText("Provider LLM", { selector: "button#llm-provider" })).toBeInTheDocument();
    expect(screen.getByLabelText("Token Hugging Face", { selector: "input#llm-api-token" })).toBeInTheDocument();

    expect(screen.queryByLabelText("Model ID")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Temperature")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Max tokens")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("URL API Mistral")).not.toBeInTheDocument();

    const settingsLink = screen.getByRole("link", { name: /ouvrir parametres llm/i });
    expect(settingsLink).toHaveAttribute("href", "/settings?tab=llm");
  });

  it("shows blocking config message when model id is missing", () => {
    useAsrStore.setState({ llmApiHfModelId: "" } as any);

    renderPage();

    expect(screen.getByText(/configuration pipeline incomplete/i)).toBeInTheDocument();
    expect(screen.getByText(/ne peut pas fonctionner sans model id/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /generer les 3 formats/i })).toBeDisabled();
    expect(screen.getAllByRole("link", { name: /ouvrir parametres llm/i })[0]).toHaveAttribute(
      "href",
      "/settings?tab=llm"
    );
  });

  it("emits reset and download telemetry events", async () => {
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

    await userEvent.click(screen.getByRole("button", { name: /reinitialiser session llm/i }));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_RESET_REQUESTED",
      expect.objectContaining({ sourceMode: "transcription" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_RESET_DONE",
      expect.objectContaining({ sourceMode: "transcription" })
    );

    await userEvent.click(screen.getByRole("button", { name: /telecharger cri/i }));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_REQUESTED",
      expect.objectContaining({ format: "cri" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_DONE",
      expect.objectContaining({ format: "cri" })
    );
  });

  it("renders editable content with subtitle, optional lists and paragraph blocks", async () => {
    useAsrStore.setState({
      llmApiResults: {
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
      },
    } as any);

    renderPage();

    await userEvent.click(screen.getByRole("tab", { name: "CRO" }));
    const editor = screen.getByTestId("report-editor-cro");
    expect(within(editor).getByDisplayValue("Compte rendu CRO")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Sous titre")).toBeInTheDocument();
    expect(within(editor).getByText("Points cles")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Point 1")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Point 2")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Action A")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Risque X")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Bloc A")).toBeInTheDocument();
    expect(within(editor).getByDisplayValue("Bloc B")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: /telecharger cri/i }));

    expect(toastMock).toHaveBeenCalledWith("download boom");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_CLOUD_DOWNLOAD_FAILED",
      expect.objectContaining({ format: "cri", message: "download boom" })
    );
  });

  it("triggers the hidden file picker button in text source mode", async () => {
    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    await userEvent.click(screen.getByRole("button", { name: /choisir un fichier/i }));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("updates mistral token from provider controls", async () => {
    useAsrStore.setState({ llmApiProvider: "mistral", mistralApiKey: "" } as any);
    renderPage();

    expect(screen.getByText(/session en cours du navigateur/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Cle API Mistral", { selector: "input#llm-mistral-api-key" }), {
      target: { value: "mistral_token_ui" },
    });
    expect(useAsrStore.getState().mistralApiKey).toBe("mistral_token_ui");
  });
});
