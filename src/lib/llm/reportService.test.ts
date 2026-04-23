import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateReport, generateReportDetailed } from "@/lib/llm/reportService";

const getLlmHfClientMock = vi.fn();
const generateWithChatThenFallbackTextMock = vi.fn();
const generateWithMistralChatMock = vi.fn();

vi.mock("@/lib/llm/hfClient", () => ({
  getLlmHfClient: (...args: unknown[]) => getLlmHfClientMock(...args),
  generateWithChatThenFallbackText: (...args: unknown[]) => generateWithChatThenFallbackTextMock(...args),
}));

vi.mock("@/lib/llm/mistralChatClient", () => ({
  generateWithMistralChat: (...args: unknown[]) => generateWithMistralChatMock(...args),
}));

describe("reportService", () => {
  beforeEach(() => {
    getLlmHfClientMock.mockReset();
    generateWithChatThenFallbackTextMock.mockReset();
    generateWithMistralChatMock.mockReset();
    getLlmHfClientMock.mockResolvedValue({ chatCompletion: vi.fn(), textGeneration: vi.fn() });
  });

  it("generateReport returns validated report JSON", async () => {
    generateWithChatThenFallbackTextMock.mockResolvedValue({
      text: JSON.stringify({
        format: "CRI",
        title: "Compte rendu",
        sections: [{ heading: "Histoire", paragraphs: ["Texte"] }],
      }),
      strategy: "chatCompletion",
    });

    const report = await generateReport({
      provider: "huggingface",
      format: "CRI",
      modelId: "openai/gpt-oss-20b",
      hfToken: "hf_xxx",
      sourceText: "source",
      temperature: 0.2,
      maxTokens: 1024,
    });

    expect(report.format).toBe("CRI");
    expect(report.sections).toHaveLength(1);
    expect(generateWithChatThenFallbackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        responseMode: "json",
      })
    );
  });

  it("generateReportDetailed exposes raw response and strategy", async () => {
    generateWithChatThenFallbackTextMock.mockResolvedValue({
      text: JSON.stringify({
        format: "CRO",
        title: "Compte rendu structure",
        sections: [{ heading: "Synthese", paragraphs: ["Element"] }],
      }),
      strategy: "textGeneration",
    });

    const result = await generateReportDetailed({
      provider: "huggingface",
      format: "CRO",
      modelId: "openai/gpt-oss-20b",
      hfToken: "hf_xxx",
      sourceText: "source",
      temperature: 0,
      maxTokens: 1024,
      detailLevel: "verbose",
    });

    expect(result.strategy).toBe("textGeneration");
    expect(result.rawResponse).toContain("\"title\"");
    expect(result.report.format).toBe("CRO");
    expect(generateWithChatThenFallbackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: expect.stringContaining("Niveau de detail actif: Verbeux"),
        userPrompt: expect.stringContaining("longueur minimale obligatoire"),
      })
    );
    expect(generateWithChatThenFallbackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining("tu peux depasser"),
      })
    );
  });

  it("throws when source text is empty", async () => {
    await expect(
      generateReport({
        provider: "huggingface",
        format: "CRS",
        modelId: "openai/gpt-oss-20b",
        hfToken: "hf_xxx",
        sourceText: "   ",
        temperature: 0,
        maxTokens: 512,
      })
    ).rejects.toThrow("Source vide");
  });

  it("uses Mistral provider path when selected", async () => {
    generateWithMistralChatMock.mockResolvedValue({
      text: JSON.stringify({
        format: "CRI",
        title: "Compte rendu mistral",
        sections: [{ heading: "Synthese", paragraphs: ["Texte"] }],
      }),
      strategy: "chatCompletion",
    });

    const result = await generateReportDetailed({
      provider: "mistral",
      format: "CRI",
      modelId: "mistral-medium-latest",
      mistralApiKey: "mistral_secret",
      mistralApiUrl: "https://api.mistral.ai",
      sourceText: "source",
      temperature: 0.2,
      maxTokens: 2048,
      detailLevel: "exhaustive",
    });

    expect(result.report.format).toBe("CRI");
    expect(generateWithMistralChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "mistral_secret",
        apiUrl: "https://api.mistral.ai",
        systemPrompt: expect.stringContaining("Niveau de detail actif: Exhaustif"),
        userPrompt: expect.stringContaining("longueur minimale obligatoire"),
      })
    );
    expect(generateWithMistralChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userPrompt: expect.stringContaining("le plus long et le plus detaille"),
      })
    );
    expect(generateWithChatThenFallbackTextMock).not.toHaveBeenCalled();
  });
});
