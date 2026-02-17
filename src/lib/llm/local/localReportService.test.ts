import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateLocalReportDetailed } from "@/lib/llm/local/localReportService";

const generateLocalTextMock = vi.fn();

vi.mock("@/lib/llm/local/localGeneration", () => ({
  generateLocalText: (...args: unknown[]) => generateLocalTextMock(...args),
}));

describe("localReportService", () => {
  beforeEach(() => {
    generateLocalTextMock.mockReset();
  });

  it("returns parsed report with local strategy", async () => {
    generateLocalTextMock.mockResolvedValueOnce(
      JSON.stringify({
        format: "CRI",
        title: "Compte rendu local",
        sections: [{ heading: "Contexte", paragraphs: ["Texte"] }],
      })
    );

    const result = await generateLocalReportDetailed({
      format: "CRI",
      modelId: "onnx-community/Qwen3-1.7B-ONNX",
      sourceText: "Source locale",
      backend: "webgpu",
      dtype: "q4f16",
      temperature: 0.2,
      maxTokens: 1024,
      appendNoThinkDirective: true,
    });

    expect(result.strategy).toBe("localTextGeneration");
    expect(result.report.format).toBe("CRI");
    expect(result.report.sections).toHaveLength(1);
    expect(generateLocalTextMock).toHaveBeenCalledTimes(1);
  });

  it("runs one repair pass when first output is invalid json", async () => {
    generateLocalTextMock
      .mockResolvedValueOnce("not-json")
      .mockResolvedValueOnce(
        JSON.stringify({
          format: "CRS",
          title: "Corrige",
          sections: [{ heading: "Resume", paragraphs: ["Ok"] }],
        })
      );

    const result = await generateLocalReportDetailed({
      format: "CRS",
      modelId: "onnx-community/Qwen3-1.7B-ONNX",
      sourceText: "Source locale",
      backend: "webgpu",
      dtype: "q4f16",
      temperature: 0,
      maxTokens: 512,
    });

    expect(result.report.format).toBe("CRS");
    expect(generateLocalTextMock).toHaveBeenCalledTimes(2);
  });
});
