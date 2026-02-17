/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useAsrStore } from "@/store/asr-store";
import { useLlmLocalReports } from "@/hooks/useLlmLocalReports";
import { createDefaultLocalModelSettingsByProfile } from "@/lib/llm/localModelCatalog";

const mocks = vi.hoisted(() => ({
  generateLocalReportDetailedMock: vi.fn(),
  prepareLongInputForReportsMock: vi.fn(),
  generateLocalTextMock: vi.fn(),
  disposeLocalGenerationPipelinesMock: vi.fn(async () => undefined),
  buildReportDocxMock: vi.fn(async () => new Blob(["docx"])),
  downloadDocxBlobMock: vi.fn(),
}));

vi.mock("@/lib/llm/local/localReportService", () => ({
  generateLocalReportDetailed: mocks.generateLocalReportDetailedMock,
}));

vi.mock("@/lib/llm/longInputPipeline", () => ({
  prepareLongInputForReports: mocks.prepareLongInputForReportsMock,
}));

vi.mock("@/lib/llm/local/localGeneration", () => ({
  generateLocalText: mocks.generateLocalTextMock,
  disposeLocalGenerationPipelines: mocks.disposeLocalGenerationPipelinesMock,
}));

vi.mock("@/lib/docx/reportDocx", () => ({
  buildReportDocx: mocks.buildReportDocxMock,
  downloadDocxBlob: mocks.downloadDocxBlobMock,
  formatReportDocxFilename: () => "report.docx",
}));

describe("useLlmLocalReports", () => {
  beforeEach(() => {
    mocks.generateLocalReportDetailedMock.mockReset();
    mocks.prepareLongInputForReportsMock.mockReset();
    mocks.generateLocalTextMock.mockReset();
    mocks.disposeLocalGenerationPipelinesMock.mockReset();
    mocks.buildReportDocxMock.mockReset();
    mocks.downloadDocxBlobMock.mockReset();

    const defaults = createDefaultLocalModelSettingsByProfile();
    defaults.qwen_1_7b.temperature = 0.45;
    defaults.qwen_1_7b.maxTokens = 1536;
    defaults.qwen_1_7b.appendNoThinkDirective = true;
    defaults.ministral_3_3b.temperature = 0.2;
    defaults.ministral_3_3b.maxTokens = 2048;
    defaults.ministral_3_3b.appendNoThinkDirective = false;

    useAsrStore.setState({
      webGpuSupported: true,
      wasmAvailable: true,
      llmLocalModelProfile: "qwen_1_7b",
      llmLocalModelId: defaults.qwen_1_7b.modelId,
      llmLocalTemperature: defaults.qwen_1_7b.temperature,
      llmLocalMaxTokens: defaults.qwen_1_7b.maxTokens,
      llmLocalBackendPreference: "webgpu",
      llmLocalDtypeWebgpu: defaults.qwen_1_7b.dtypeWebgpu,
      llmLocalDtypeWasm: defaults.qwen_1_7b.dtypeWasm,
      llmLocalSettingsByProfile: defaults,
      llmLocalStatus: "idle",
      llmLocalProgress: 0,
      llmLocalResults: {},
      telemetryCollector: null,
      telemetrySummary: null,
      segments: [{ text: "Segment un" }, { text: "Segment deux" }],
    } as any);

    mocks.prepareLongInputForReportsMock.mockResolvedValue({
      text: "Source preparee",
      sourceTokenCount: 16,
      chunkCount: 1,
      pipelinePasses: 1,
    });

    mocks.generateLocalReportDetailedMock.mockImplementation(async (params: { format: string }) => ({
      report: {
        format: params.format,
        title: `${params.format} title`,
        sections: [{ heading: "Section", paragraphs: ["Paragraphe"] }],
      },
      rawResponse: JSON.stringify({ format: params.format, title: `${params.format} title`, sections: [] }),
      strategy: "localTextGeneration",
    }));
  });

  it("generates three local report formats using active profile settings", async () => {
    const { result } = renderHook(() => useLlmLocalReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription" });
    });

    expect(useAsrStore.getState().llmLocalStatus).toBe("done");
    expect(mocks.generateLocalReportDetailedMock).toHaveBeenCalledTimes(3);
    expect(useAsrStore.getState().llmLocalResults.cri?.strategy).toBe("localTextGeneration");

    const firstCall = mocks.generateLocalReportDetailedMock.mock.calls[0]?.[0] as {
      temperature: number;
      appendNoThinkDirective: boolean;
    };
    expect(firstCall.temperature).toBe(0.45);
    expect(firstCall.appendNoThinkDirective).toBe(true);

    const summary = useAsrStore.getState().telemetrySummary;
    const events = summary?.events.map((event) => event.type) ?? [];
    expect(events).toContain("LLM_RUN_STAGE");
    expect(events).toContain("LLM_RUN_DONE");
  });

  it("falls back from webgpu to wasm automatically for qwen profile", async () => {
    mocks.generateLocalReportDetailedMock.mockImplementation(async (params: { format: string; backend: string }) => {
      if (params.backend === "webgpu") {
        throw new Error("WebGPU adapter failed");
      }
      return {
        report: {
          format: params.format,
          title: `${params.format} title`,
          sections: [{ heading: "Section", paragraphs: ["Paragraphe"] }],
        },
        rawResponse: JSON.stringify({ format: params.format, title: `${params.format} title`, sections: [] }),
        strategy: "localTextGeneration",
      };
    });

    const { result } = renderHook(() => useLlmLocalReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription" });
    });

    const backends = mocks.generateLocalReportDetailedMock.mock.calls.map(
      (args) => (args[0] as { backend?: string }).backend
    );
    expect(backends[0]).toBe("webgpu");
    expect(backends).toContain("wasm");
    expect(useAsrStore.getState().llmLocalStatus).toBe("done");
    expect(useAsrStore.getState().llmLocalResults.cri?.strategy).toBe("localTextGeneration");
  });

  it("falls back from ministral to qwen with qwen-specific settings", async () => {
    const defaults = createDefaultLocalModelSettingsByProfile();
    defaults.qwen_1_7b.temperature = 0.9;
    defaults.qwen_1_7b.appendNoThinkDirective = true;

    useAsrStore.setState({
      llmLocalModelProfile: "ministral_3_3b",
      llmLocalModelId: defaults.ministral_3_3b.modelId,
      llmLocalSettingsByProfile: defaults,
    } as any);

    mocks.generateLocalReportDetailedMock.mockImplementation(async (params: { modelId: string; format: string }) => {
      if (params.modelId.includes("Ministral")) {
        throw new Error("std::bad_alloc");
      }
      return {
        report: {
          format: params.format,
          title: `${params.format} title`,
          sections: [{ heading: "Section", paragraphs: ["Paragraphe"] }],
        },
        rawResponse: JSON.stringify({ format: params.format, title: `${params.format} title`, sections: [] }),
        strategy: "localTextGeneration",
      };
    });

    const { result } = renderHook(() => useLlmLocalReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription" });
    });

    const calls = mocks.generateLocalReportDetailedMock.mock.calls.map((args) => args[0] as {
      modelId: string;
      temperature: number;
      appendNoThinkDirective: boolean;
    });
    expect(calls.some((call) => call.modelId.includes("Ministral"))).toBe(true);
    expect(calls.some((call) => call.modelId.includes("Qwen3") && call.temperature === 0.9)).toBe(true);
    expect(calls.some((call) => call.modelId.includes("Qwen3") && call.appendNoThinkDirective)).toBe(true);
    expect(useAsrStore.getState().llmLocalModelProfile).toBe("qwen_1_7b");
    expect(useAsrStore.getState().llmLocalStatus).toBe("done");
    expect(useAsrStore.getState().llmLocalModelSizeAlert).toMatchObject({
      severity: "warning",
    });
    const stageEvents = useAsrStore
      .getState()
      .telemetrySummary?.events.filter((event) => event.type === "LLM_RUN_STAGE")
      .map((event) => event.data?.stage);
    expect(stageEvents).toContain("fallback_profile_switch");
  });

  it("sets an error foreground alert when local memory failure is final", async () => {
    useAsrStore.setState({
      llmLocalModelProfile: "qwen_1_7b",
      llmLocalModelId: "onnx-community/Qwen3-1.7B-ONNX",
    } as any);

    mocks.generateLocalReportDetailedMock.mockRejectedValue(new Error("std::bad_alloc"));

    const { result } = renderHook(() => useLlmLocalReports());

    await act(async () => {
      await result.current.generateAll({ source: "transcription" });
    });

    const state = useAsrStore.getState();
    expect(state.llmLocalStatus).toBe("error");
    expect(state.llmLocalModelSizeAlert).toMatchObject({
      severity: "error",
    });
  });

  it("resets local llm session and disposes local generation pipelines", async () => {
    const { result } = renderHook(() => useLlmLocalReports());

    await act(async () => {
      await result.current.resetSession();
    });

    expect(mocks.disposeLocalGenerationPipelinesMock).toHaveBeenCalledTimes(1);
    expect(useAsrStore.getState().llmLocalStatus).toBe("idle");
    expect(useAsrStore.getState().llmLocalProgress).toBe(0);
    expect(useAsrStore.getState().llmLocalResults).toEqual({});
  });

  it("emits LLM_DOCX_DOWNLOAD events on local docx success", async () => {
    const { result } = renderHook(() => useLlmLocalReports());

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

  it("emits LLM_DOCX_DOWNLOAD error on local docx failure", async () => {
    mocks.buildReportDocxMock.mockRejectedValueOnce(new Error("docx failed"));
    const { result } = renderHook(() => useLlmLocalReports());

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
