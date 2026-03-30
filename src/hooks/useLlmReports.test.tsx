/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAsrStore } from "@/store/asr-store";
import { useLlmReports } from "@/hooks/useLlmReports";

const mocks = vi.hoisted(() => ({
  generateReportDetailedMock: vi.fn(),
  prepareLongInputForReportsMock: vi.fn(),
  getLlmHfClientMock: vi.fn(),
  generateWithChatThenFallbackTextMock: vi.fn(),
  buildReportDocxMock: vi.fn(async () => new Blob(["docx"])),
  downloadDocxBlobMock: vi.fn(),
}));

vi.mock("@/lib/llm/reportService", () => ({
  generateReportDetailed: mocks.generateReportDetailedMock,
}));

vi.mock("@/lib/llm/longInputPipeline", () => ({
  prepareLongInputForReports: mocks.prepareLongInputForReportsMock,
}));

vi.mock("@/lib/llm/hfClient", () => ({
  getLlmHfClient: mocks.getLlmHfClientMock,
  generateWithChatThenFallbackText: mocks.generateWithChatThenFallbackTextMock,
}));

vi.mock("@/lib/docx/reportDocx", () => ({
  buildReportDocx: mocks.buildReportDocxMock,
  downloadDocxBlob: mocks.downloadDocxBlobMock,
  formatReportDocxFilename: () => "report.docx",
}));

describe("useLlmReports telemetry", () => {
  beforeEach(() => {
    mocks.generateReportDetailedMock.mockReset();
    mocks.prepareLongInputForReportsMock.mockReset();
    mocks.getLlmHfClientMock.mockReset();
    mocks.generateWithChatThenFallbackTextMock.mockReset();
    mocks.buildReportDocxMock.mockReset();
    mocks.downloadDocxBlobMock.mockReset();

    useAsrStore.setState({
      llmApiProvider: "huggingface",
      hfApiToken: "hf_test_token",
      llmApiHfModelId: "openai/gpt-oss-20b",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 8192,
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      llmApiStatus: "idle",
      llmApiStatusDetail: undefined,
      llmApiProgress: 0,
      llmApiResults: {},
      llmApiReportDrafts: {},
      mistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      telemetryCollector: null,
      telemetrySummary: null,
      sessionTranscriptMemories: {
        upload: {
          mode: "upload",
          provider: "upload",
          label: "Locale · demo.wav",
          segments: [{ text: "Segment un" }, { text: "Segment deux" }],
          audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:00:00.000Z",
        },
        mic: null,
        cloud: null,
      },
    } as any);

    mocks.getLlmHfClientMock.mockResolvedValue({});
    mocks.prepareLongInputForReportsMock.mockResolvedValue({
      text: "Source preparee",
      sourceTokenCount: 16,
      chunkCount: 1,
      pipelinePasses: 1,
    });

    mocks.generateReportDetailedMock.mockImplementation(async (params: { format: string; modelId: string }) => ({
      report: {
        format: params.format,
        title: `${params.format} title`,
        sections: [{ heading: "Section", paragraphs: ["Paragraphe"] }],
      },
      rawResponse: JSON.stringify({ format: params.format, title: `${params.format} title`, sections: [] }),
      strategy: "chatCompletion",
    }));
  });

  it("emits LLM run start/stage/done telemetry events on success", async () => {
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "upload" });
    });

    const summary = useAsrStore.getState().telemetrySummary;
    expect(summary).toBeTruthy();

    const eventTypes = summary?.events.map((event) => event.type) ?? [];
    expect(eventTypes).toContain("LLM_RUN_START");
    expect(eventTypes).toContain("LLM_RUN_STAGE");
    expect(eventTypes).toContain("LLM_RUN_DONE");
    expect(mocks.generateReportDetailedMock).toHaveBeenCalledTimes(3);
  });

  it("emits LLM_RUN_ERROR telemetry event when generation fails", async () => {
    mocks.generateReportDetailedMock.mockRejectedValueOnce(new Error("Generation failed"));

    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "upload" });
    });

    const summary = useAsrStore.getState().telemetrySummary;
    expect(summary).toBeTruthy();

    const eventTypes = summary?.events.map((event) => event.type) ?? [];
    expect(eventTypes).toContain("LLM_RUN_START");
    expect(eventTypes).toContain("LLM_RUN_ERROR");
    expect(useAsrStore.getState().llmApiStatus).toBe("error");
  });

  it("emits LLM_DOCX_DOWNLOAD events on success", async () => {
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "upload" });
    });

    await act(async () => {
      await result.current.downloadDocx("cri");
    });

    expect(mocks.buildReportDocxMock).toHaveBeenCalled();
    expect(mocks.downloadDocxBlobMock).toHaveBeenCalled();

    const summary = useAsrStore.getState().telemetrySummary;
    const docxEvents = summary?.events.filter((event) => event.type === "LLM_DOCX_DOWNLOAD") ?? [];
    expect(docxEvents.some((event) => event.data?.status === "start")).toBe(true);
    expect(docxEvents.some((event) => event.data?.status === "done")).toBe(true);
  });

  it("uses the edited report draft when building a docx", async () => {
    const generatedResult = {
      format: "CRI",
      report: {
        format: "CRI",
        title: "Titre initial",
        sections: [
          { heading: "Section A", paragraphs: ["Paragraphe A"] },
          { heading: "Section B", paragraphs: ["Paragraphe B"] },
        ],
      },
      rawResponse: JSON.stringify({ format: "CRI", title: "Titre initial", sections: [] }),
      modelId: "openai/gpt-oss-20b",
      generatedAt: new Date().toISOString(),
      sourceMode: "text",
      sourceTokenCount: 16,
      pipelinePasses: 1,
      strategy: "chatCompletion",
    } as const;

    useAsrStore.setState({
      llmApiResults: { cri: generatedResult } as any,
      llmApiReportDrafts: {
        cri: {
          format: "CRI",
          title: "Titre modifie",
          sections: [
            { heading: "Section B", paragraphs: ["Paragraphe B"] },
            { heading: "Section A", paragraphs: ["Paragraphe A"] },
          ],
        },
      } as any,
    } as any);

    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.downloadDocx("cri");
    });

    expect(mocks.buildReportDocxMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Titre modifie",
        sections: [
          { heading: "Section B", paragraphs: ["Paragraphe B"] },
          { heading: "Section A", paragraphs: ["Paragraphe A"] },
        ],
      }),
      expect.objectContaining({
        format: "CRI",
        modelId: "openai/gpt-oss-20b",
      })
    );
  });

  it("emits LLM_DOCX_DOWNLOAD error event when formatting fails", async () => {
    mocks.buildReportDocxMock.mockRejectedValueOnce(new Error("docx failed"));
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "upload" });
    });

    await act(async () => {
      await expect(result.current.downloadDocx("cri")).rejects.toThrow("docx failed");
    });

    const summary = useAsrStore.getState().telemetrySummary;
    const docxEvents = summary?.events.filter((event) => event.type === "LLM_DOCX_DOWNLOAD") ?? [];
    expect(docxEvents.some((event) => event.data?.status === "error")).toBe(true);
  });

  it("rejects empty free-text source with a clear error status", async () => {
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "text", text: "   " });
    });

    expect(useAsrStore.getState().llmApiStatus).toBe("error");
    expect(useAsrStore.getState().llmApiStatusDetail).toContain("Saisissez un texte source");
  });

  it("generates from free-text source and keeps success flow", async () => {
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "text", text: "Compte-rendu libre" });
    });

    expect(useAsrStore.getState().llmApiStatus).toBe("done");
    expect(mocks.generateReportDetailedMock).toHaveBeenCalledTimes(3);
  });

  it("fails when downloadDocx is called without generated result", async () => {
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await expect(result.current.downloadDocx("cri")).rejects.toThrow("Aucun resultat disponible");
    });
  });

  it("returns an error when transcription source has no segment text", async () => {
    useAsrStore.setState({
      sessionTranscriptMemories: {
        upload: null,
        mic: null,
        cloud: null,
      },
    } as any);
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "upload" });
    });

    expect(useAsrStore.getState().llmApiStatus).toBe("error");
    expect(useAsrStore.getState().llmApiStatusDetail).toContain("Aucune transcription disponible");
  });

  it("reads the selected transcript mode instead of the global segments array", async () => {
    useAsrStore.setState({
      segments: [{ text: "Ancien segment global" }],
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

    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription", transcriptMode: "cloud" });
    });

    expect(mocks.prepareLongInputForReportsMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceText: "Texte cloud" })
    );
  });
});
