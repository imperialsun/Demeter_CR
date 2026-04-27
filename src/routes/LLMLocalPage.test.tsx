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
const { emitLlmEventMock, parseTranscriptFileMock, toastMock } = vi.hoisted(() => ({
  emitLlmEventMock: vi.fn(),
  parseTranscriptFileMock: vi.fn(),
  toastMock: vi.fn(),
}));

const backendPermissionMocks = vi.hoisted(() => ({
  canAccessFeature: vi.fn(() => true),
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

vi.mock("@/lib/transcript/parseTranscriptFile", async () => {
  const actual = await vi.importActual<typeof import("@/lib/transcript/parseTranscriptFile")>(
    "@/lib/transcript/parseTranscriptFile"
  );
  return {
    ...actual,
    parseTranscriptFile: (...args: unknown[]) => parseTranscriptFileMock(...args),
  };
});

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canAccessFeature: (...args: unknown[]) => backendPermissionMocks.canAccessFeature(...args),
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

describe("LLMLocalPage", () => {
  beforeEach(() => {
    generateAll.mockClear();
    resetSession.mockClear();
    downloadDocx.mockClear();
    emitLlmEventMock.mockReset();
    parseTranscriptFileMock.mockReset();
    toastMock.mockReset();
    window.sessionStorage.clear();
    backendPermissionMocks.canAccessFeature.mockReset();
    backendPermissionMocks.canAccessFeature.mockReturnValue(true);
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

    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).not.toBeDisabled();

    fireEvent.click(button);
    expect(generateAll).toHaveBeenCalledWith({ source: "transcription", text: undefined });
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_GENERATION_REQUESTED",
      expect.objectContaining({ sourceMode: "transcription" })
    );
  }, 10000);

  it("emits local page view telemetry on mount", () => {
    renderPage();
    expect(emitLlmEventMock).toHaveBeenCalledWith("LLM_LOCAL_PAGE_VIEW", {
      route: "/llmlocal",
      mode: "local",
    });
  });

  it("shows local privacy notice for llm local mode", () => {
    renderPage();
    expect(screen.getByText(/traitement 100 ?% local sur ce poste/i)).toBeInTheDocument();
    expect(screen.getByText(/aucune donnée n'est partagée en dehors de ce poste/i)).toBeInTheDocument();
  });

  it("renders local model profile selector", () => {
    renderPage();
    expect(screen.getByLabelText("Profil modèle", { selector: "button#llm-local-profile" })).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Nombre max de tokens", { selector: "input#llm-local-max-tokens" })
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dtype WebGPU", { selector: "button#llm-local-dtype-webgpu" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Dtype WASM", { selector: "button#llm-local-dtype-wasm" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Temperature", { selector: "input#llm-local-temperature" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /ouvrir paramètres llm local/i })).toHaveAttribute(
      "href",
      "/settings?tab=llmlocal"
    );
  });

  it("hides settings link when feature.settings is forbidden", () => {
    backendPermissionMocks.canAccessFeature.mockImplementation((permission: string) =>
      permission === "feature.settings" ? false : true
    );

    renderPage();

    expect(screen.queryByRole("link", { name: /ouvrir paramètres llm local/i })).toBeNull();
  });

  it("resets local llm session via hook", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /réinitialiser la session locale/i }));
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

    const profileSelect = screen.getByLabelText("Profil modèle", { selector: "button#llm-local-profile" });
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

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const button = screen.getByRole("button", { name: /générer les comptes rendus/i });
    expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: /choisir un fichier/i })).toBeInTheDocument();
    expect(screen.getByText(/importez un fichier pour lancer la génération/i)).toBeInTheDocument();
  });

  it("emits import telemetry events", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier de transcription", {
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
    expect(screen.getByText(/fichier importé\s*:/i)).toBeInTheDocument();
    expect(screen.getAllByText("source.txt").length).toBeGreaterThan(0);
    expect(screen.getByText(/tokens du fichier importé approx/i)).toBeInTheDocument();
  });

  it("accepts docx imports in free text mode", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis docx",
      format: "docx",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-local-source-file",
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
      "LLM_LOCAL_IMPORT_SUCCESS",
      expect.objectContaining({ fileName: "source.docx", format: "docx" })
    );
  });

  it("generates from imported file in texte libre mode", async () => {
    parseTranscriptFileMock.mockResolvedValue({
      text: "Texte importe depuis fichier",
      format: "txt",
      extraction: "plain",
    });

    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-local-source-file",
    });
    const file = new File(["dummy"], "source.txt", { type: "text/plain" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    const generateButton = screen.getByRole("button", { name: /générer les comptes rendus/i });
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
    await userEvent.click(screen.getByRole("button", { name: /télécharger compte rendu détaillé/i }));
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
        title: "Modèle local trop gros",
        description: "Impossible de charger le modèle sur ce poste.",
        severity: "error",
        signature: "llmlocal:test:error",
      },
    } as any);

    renderPage();

    expect(screen.getByRole("dialog", { name: "Modèle local trop gros" })).toBeInTheDocument();
    expect(screen.getByText("Impossible de charger le modèle sur ce poste.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /compris/i }));

    await waitFor(() => {
      expect(useAsrStore.getState().llmLocalModelSizeAlert).toBeNull();
    });
  });

  it("confirms heavy profile selection and updates store", async () => {
    renderPage();

    const profileSelect = screen.getByLabelText("Profil modèle", { selector: "button#llm-local-profile" });
    fireEvent.click(profileSelect);
    fireEvent.click(await screen.findByText(/Ministral 3 3B/i));
    await userEvent.click(screen.getByRole("button", { name: /confirmer/i }));

    expect(useAsrStore.getState().llmLocalModelProfile).toBe("ministral_3_3b");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_HEAVY_PROFILE_CONFIRMED",
      expect.objectContaining({ nextProfile: "ministral_3_3b" })
    );
  });

  it("shows backend unavailable warning when no local backend is available", () => {
    useAsrStore.setState({
      webGpuSupported: false,
      wasmAvailable: false,
    } as any);
    renderPage();

    expect(screen.getByText(/aucun backend local disponible/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /générer les comptes rendus/i })).toBeDisabled();
  });

  it("handles local download failure with toast and telemetry", async () => {
    const criResult = {
      format: "CRI",
      report: { format: "CRI", title: "CRI", sections: [{ heading: "h", paragraphs: ["p"] }] },
      rawResponse: "{}",
      modelId: "onnx-community/Qwen3-1.7B-ONNX",
      generatedAt: new Date().toISOString(),
      sourceMode: "transcription",
      sourceTokenCount: 12,
      pipelinePasses: 1,
      strategy: "localTextGeneration",
    };
    hookState.results = { cri: criResult } as any;
    useAsrStore.setState({
      llmLocalResults: {
        cri: criResult,
      },
    } as any);
    downloadDocx.mockRejectedValueOnce(new Error("local download fail"));

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /télécharger compte rendu détaillé/i }));

    expect(toastMock).toHaveBeenCalledWith("local download fail");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_DOWNLOAD_FAILED",
      expect.objectContaining({ format: "cri", message: "local download fail" })
    );
  });

  it("handles local reset failure with toast and telemetry", async () => {
    resetSession.mockRejectedValueOnce(new Error("reset failed"));
    renderPage();

    await userEvent.click(screen.getByRole("button", { name: /réinitialiser la session locale/i }));

    expect(toastMock).toHaveBeenCalledWith("reset failed");
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_RESET_FAILED",
      expect.objectContaining({ message: "reset failed" })
    );
  });

  it("renders local preview blocks with optional lists", async () => {
    useAsrStore.setState({
      llmLocalResults: {
        crs: {
          format: "CRS",
          report: {
            format: "CRS",
            title: "Resume local",
            subtitle: "Sous titre local",
            sections: [{ heading: "Bloc", paragraphs: ["Paragraphe 1\n\nParagraphe 2"] }],
            key_points: ["KP1"],
            action_items: ["Act1"],
            caveats: ["Cv1"],
          },
          rawResponse: "{}",
          modelId: "onnx-community/Qwen3-1.7B-ONNX",
          generatedAt: new Date().toISOString(),
          sourceMode: "transcription",
          sourceTokenCount: 25,
          pipelinePasses: 1,
          strategy: "localTextGeneration",
        },
      },
    } as any);

    renderPage();
    await userEvent.click(screen.getByRole("tab", { name: "Compte rendu synthétique" }));

    expect(screen.getByText("Resume local")).toBeInTheDocument();
    expect(screen.getByText("Sous titre local")).toBeInTheDocument();
    expect(screen.getByText("Points clés")).toBeInTheDocument();
    expect(screen.getByText("Act1")).toBeInTheDocument();
    expect(screen.getByText("Cv1")).toBeInTheDocument();
    expect(screen.getByText("Paragraphe 1")).toBeInTheDocument();
    expect(screen.getByText("Paragraphe 2")).toBeInTheDocument();
  });

  it("triggers local hidden file picker button", async () => {
    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click");
    await userEvent.click(screen.getByRole("button", { name: /choisir un fichier/i }));
    expect(clickSpy).toHaveBeenCalled();
    clickSpy.mockRestore();
  });

  it("shows import failure toast and telemetry", async () => {
    parseTranscriptFileMock.mockRejectedValueOnce(new Error("import local impossible"));
    renderPage();

    const sourceSelect = screen.getByLabelText("Mode d'entrée", { selector: "button#llm-local-source" });
    fireEvent.click(sourceSelect);
    fireEvent.click(await screen.findByText("Texte libre"));

    const fileInput = screen.getByLabelText("Importer un fichier de transcription", {
      selector: "input#llm-local-source-file",
    });
    fireEvent.change(fileInput, { target: { files: [new File(["bad"], "bad.txt", { type: "text/plain" })] } });

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith("import local impossible");
    });
    expect(emitLlmEventMock).toHaveBeenCalledWith(
      "LLM_LOCAL_IMPORT_FAILED",
      expect.objectContaining({ fileName: "bad.txt", message: "import local impossible" })
    );
  });
});
