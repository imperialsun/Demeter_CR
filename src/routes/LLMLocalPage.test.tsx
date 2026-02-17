/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/components/theme-provider";
import { useAsrStore } from "@/store/asr-store";
import LLMLocalPage from "@/routes/LLMLocalPage";

const generateAll = vi.fn(async () => undefined);
const resetSession = vi.fn(async () => undefined);
const downloadDocx = vi.fn(async () => undefined);
const { emitLlmEventMock, parseTranscriptFileMock } = vi.hoisted(() => ({
  emitLlmEventMock: vi.fn(),
  parseTranscriptFileMock: vi.fn(),
}));

const hookState = {
  status: "idle",
  progress: 0,
  results: {},
  isResettingSession: false,
  generateAll,
  resetSession,
  downloadDocx,
};

vi.mock("@/hooks/useLlmLocalReports", () => ({
  useLlmLocalReports: () => hookState,
}));

vi.mock("@/lib/llm/telemetrySession", () => ({
  emitLlmEvent: (...args: unknown[]) => emitLlmEventMock(...args),
}));

vi.mock("@/lib/transcript/parseTranscriptFile", () => ({
  parseTranscriptFile: (...args: unknown[]) => parseTranscriptFileMock(...args),
}));

describe("LLMLocalPage", () => {
  beforeEach(() => {
    generateAll.mockClear();
    resetSession.mockClear();
    downloadDocx.mockClear();
    emitLlmEventMock.mockReset();
    parseTranscriptFileMock.mockReset();
    hookState.status = "idle";
    hookState.progress = 0;
    hookState.results = {};
    hookState.isResettingSession = false;

    useAsrStore.setState({
      webGpuSupported: true,
      wasmAvailable: true,
      llmLocalModelProfile: "qwen_1_7b",
      llmLocalModelId: "onnx-community/Qwen3-1.7B-ONNX",
      llmLocalTemperature: 0.2,
      llmLocalMaxTokens: 1024,
      llmLocalBackendPreference: "webgpu",
      llmLocalDtypeWebgpu: "q4f16",
      llmLocalDtypeWasm: "q8",
      llmLocalStatusDetail: undefined,
      llmLocalResults: {},
      segments: [{ text: "Segment 1" }, { text: "Segment 2" }],
    } as any);
  });

  function renderPage() {
    return render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <LLMLocalPage />
      </ThemeProvider>
    );
  }

  it("triggers local generation from transcription source", async () => {
    renderPage();

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).not.toBeDisabled();

    await userEvent.click(button);
    expect(generateAll).toHaveBeenCalledWith({ source: "transcription", text: undefined });
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_GENERATION_REQUESTED",
      expect.objectContaining({ sourceMode: "transcription" })
    );
  });

  it("emits local page view telemetry on mount", () => {
    renderPage();
    expect(emitLlmEventMock).toHaveBeenCalledWith("LLM_LOCAL_PAGE_VIEW", {
      route: "/llmlocal",
      mode: "local",
    });
  });

  it("renders local model profile selector", () => {
    renderPage();
    expect(screen.getByLabelText("Profil modele", { selector: "button#llm-local-profile" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Max tokens", { selector: "input#llm-local-max-tokens" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dtype WebGPU", { selector: "button#llm-local-dtype-webgpu" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dtype WASM", { selector: "button#llm-local-dtype-wasm" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Temperature", { selector: "input#llm-local-temperature" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ouvrir parametres llm local/i })).toHaveAttribute(
      "href",
      "/settings?tab=llmlocal"
    );
  });

  it("resets local llm session via hook", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /reinitialiser session locale/i }));
    expect(resetSession).toHaveBeenCalledTimes(1);
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_RESET_REQUESTED",
      expect.objectContaining({ sourceMode: "transcription" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_RESET_DONE",
      expect.objectContaining({ sourceMode: "transcription" })
    );
  });

  it("emits heavy profile telemetry when opening and cancelling confirmation", async () => {
    renderPage();

    const profileSelect = screen.getByLabelText("Profil modele", { selector: "button#llm-local-profile" });
    fireEvent.click(profileSelect);
    fireEvent.click(await screen.findByText(/Ministral 3 3B/i));

    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_HEAVY_PROFILE_PROMPT_OPEN",
      expect.objectContaining({ nextProfile: "ministral_3_3b" })
    );

    await userEvent.click(screen.getByRole("button", { name: /annuler/i }));
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_HEAVY_PROFILE_CANCELLED",
      expect.objectContaining({ pendingProfile: "ministral_3_3b" })
    );
  });

  it("requires an imported file when source is texte libre", async () => {
    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const button = screen.getByRole("button", { name: /generer les 3 formats/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: /choisir un fichier/i })).toBeInTheDocument();
    expect(screen.getByText(/importez un fichier pour lancer la generation/i)).toBeInTheDocument();
  });

  it("emits import telemetry events", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier transcription", {
      selector: "input#llm-local-source-file",
    });
    const file = new File(["dummy"], "source.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => {
      expect(emitLlmEventMock).toHaveBeenCalledWith(
        "LLM_LOCAL_IMPORT_START",
        expect.objectContaining({ fileName: "source.txt" })
      );
      expect(emitLlmEventMock).toHaveBeenCalledWith(
        "LLM_LOCAL_IMPORT_SUCCESS",
        expect.objectContaining({ fileName: "source.txt" })
      );
    });
    expect(screen.getByText(/fichier importe:/i)).toBeInTheDocument();
    expect(screen.getAllByText("source.txt").length).toBeGreaterThan(0);
    expect(screen.getByText(/tokens du fichier importe approx/i)).toBeInTheDocument();
  });

  it("generates from imported file in texte libre mode", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entree", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier transcription", {
      selector: "input#llm-local-source-file",
    });
    const file = new File(["dummy"], "source.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const generateButton = screen.getByRole("button", { name: /generer les 3 formats/i });
    await waitFor(() => {
      expect(generateButton).not.toBeDisabled();
    });

    await userEvent.click(generateButton);
    expect(generateAll).toHaveBeenCalledWith({ source: "text", text: "Texte importe depuis fichier" });
  });

  it("emits local download telemetry events", async () => {
    hookState.results = {
      cri: {
        format: "CRI",
        report: {
          format: "CRI",
          title: "Titre CRI",
          sections: [{ heading: "Contexte", paragraphs: ["P1"] }],
        },
        rawResponse: "{}",
        modelId: "onnx-community/Qwen3-1.7B-ONNX",
        generatedAt: new Date().toISOString(),
        sourceMode: "text",
        sourceTokenCount: 40,
        pipelinePasses: 1,
        strategy: "localTextGeneration",
      },
    } as any;

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /telecharger cri/i }));
    expect(downloadDocx).toHaveBeenCalledWith("cri");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_DOWNLOAD_REQUESTED",
      expect.objectContaining({ format: "cri" })
    );
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_DOWNLOAD_DONE",
      expect.objectContaining({ format: "cri" })
    );
  });

  it("shows and closes llm-local model-size foreground alert", async () => {
    useAsrStore.setState({
      llmLocalModelSizeAlert: {
        title: "Modele local trop gros",
        description: "Impossible de charger le modele sur ce poste.",
        severity: "error",
        signature: "llmlocal:test:error",
      },
    } as any);

    renderPage();

    expect(screen.getByRole("dialog", { name: "Modele local trop gros" })).toBeInTheDocument();
    expect(screen.getByText("Impossible de charger le modele sur ce poste.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /compris/i }));

    await waitFor(() => {
      expect(useAsrStore.getState().llmLocalModelSizeAlert).toBeNull();
    });
  });
});
