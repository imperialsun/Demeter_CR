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
}));

vi.mock("@/lib/llm/reportService", () => ({
  generateReportDetailed: (...args: unknown[]) => mocks.generateReportDetailedMock(...args),
}));

vi.mock("@/lib/llm/longInputPipeline", () => ({
  prepareLongInputForReports: (...args: unknown[]) => mocks.prepareLongInputForReportsMock(...args),
}));

vi.mock("@/lib/llm/hfClient", () => ({
  getLlmHfClient: (...args: unknown[]) => mocks.getLlmHfClientMock(...args),
  generateWithChatThenFallbackText: (...args: unknown[]) => mocks.generateWithChatThenFallbackTextMock(...args),
}));

describe("useLlmReports telemetry", () => {
  beforeEach(() => {
    mocks.generateReportDetailedMock.mockReset();
    mocks.prepareLongInputForReportsMock.mockReset();
    mocks.getLlmHfClientMock.mockReset();
    mocks.generateWithChatThenFallbackTextMock.mockReset();

    useAsrStore.setState({
      llmApiProvider: "huggingface",
      llmApiHfToken: "hf_test_token",
      llmApiModelId: "openai/gpt-oss-20b",
      llmApiTemperature: 0.2,
      llmApiMaxTokens: 8192,
      llmApiStatus: "idle",
      llmApiStatusDetail: undefined,
      llmApiProgress: 0,
      llmApiResults: {},
      cloudMistralApiKey: "",
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
});
