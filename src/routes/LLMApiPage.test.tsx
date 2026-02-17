/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { useAsrStore } from "@/store/asr-store";
import LLMApiPage from "@/routes/LLMApiPage";

const generateAll = vi.fn(async () => undefined);
const downloadDocx = vi.fn(async () => undefined);
const { toastMock, parseTranscriptFileMock, emitLlmEventMock } = vi.hoisted(() => ({
  toastMock: vi.fn(),
  parseTranscriptFileMock: vi.fn(),
  emitLlmEventMock: vi.fn(),
}));

const hookState = {
  status: "idle",
  progress: 0,
  results: {},
  generateAll,
  downloadDocx,
};

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

describe("LLMApiPage", () => {
  beforeEach(() => {
    generateAll.mockClear();
    downloadDocx.mockClear();
    toastMock.mockClear();
    parseTranscriptFileMock.mockReset();
    emitLlmEventMock.mockReset();
    hookState.status = "idle";
    hookState.progress = 0;
    hookState.results = {};

    useAsrStore.setState({
      llmApiProvider: "huggingface",
      llmApiHfToken: "hf_test",
      llmApiHfModelId: "openai/gpt-oss-20b",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 1024,
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      llmApiStatusDetail: undefined,
      llmApiResults: {},
      cloudMistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      segments: [{ text: "Segment 1" }, { text: "Segment 2" }],
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
    expect(generateAll).toHaveBeenCalledWith({ source: "transcription", text: undefined });
  });

  it("emits cloud page view telemetry on mount", () => {
    renderPage();
    expect(emitLlmEventMock).toHaveBeenCalledWith("LLM_CLOUD_PAGE_VIEW", {
      route: "/llmapi",
      mode: "cloud",
    });
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

  it("shows inline alert when llm token is missing", () => {
    useAsrStore.setState({ llmApiHfToken: "" } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans cle api hugging face/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when llm token is missing", async () => {
    useAsrStore.setState({ llmApiHfToken: "" } as any);

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

  it("shows inline alert when mistral token is missing", () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      cloudMistralApiKey: "",
      llmApiMistralModelId: "mistral-medium-latest",
    } as any);

    renderPage();

    expect(screen.getByText(/ne peut pas fonctionner sans cle api mistral/i)).toBeInTheDocument();
  });

  it("shows toast and blocks generation when mistral token is missing", async () => {
    useAsrStore.setState({
      llmApiProvider: "mistral",
      cloudMistralApiKey: "",
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
});
