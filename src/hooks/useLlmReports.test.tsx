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
      mistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      telemetryCollector: null,
      telemetrySummary: null,
      segments: [{ text: "Segment un" }, { text: "Segment deux" }],
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
      await result.current.generateAll({ source: "transcription" });
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
      await result.current.generateAll({ source: "transcription" });
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
      await result.current.generateAll({ source: "transcription" });
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

  it("emits LLM_DOCX_DOWNLOAD error event when formatting fails", async () => {
    mocks.buildReportDocxMock.mockRejectedValueOnce(new Error("docx failed"));
    const { result } = renderHook(() => useLlmReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription" });
    });

    await act(async () => {
      await expect(result.current.downloadDocx("cri")).rejects.toThrow("docx failed");
    });

    const summary = useAsrStore.getState().telemetrySummary;
    const docxEvents = summary?.events.filter((event) => event.type === "LLM_DOCX_DOWNLOAD") ?? [];
    expect(docxEvents.some((event) => event.data?.status === "error")).toBe(true);
  });
});
