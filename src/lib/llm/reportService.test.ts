import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateReport, generateReportDetailed } from "@/lib/llm/reportService";

const getLlmHfClientMock = vi.fn();
const generateWithChatThenFallbackTextMock = vi.fn();
const generateWithMistralChatMock = vi.fn();
const backendFetchMock = vi.fn();

vi.mock("@/lib/llm/hfClient", () => ({
  getLlmHfClient: (...args: unknown[]) => getLlmHfClientMock(...args),
  generateWithChatThenFallbackText: (...args: unknown[]) => generateWithChatThenFallbackTextMock(...args),
}));

vi.mock("@/lib/llm/mistralChatClient", () => ({
  generateWithMistralChat: (...args: unknown[]) => generateWithMistralChatMock(...args),
}));

vi.mock("@/lib/backend-api", () => ({
  backendFetch: (...args: unknown[]) => backendFetchMock(...args),
  handleBackendUnauthorized: vi.fn(),
  parseBackendHttpError: vi.fn(async () => new Error("backend error")),
}));

vi.mock("@/lib/backend-auth", () => ({
  BackendSessionExpiredError: class BackendSessionExpiredError extends Error {},
  backendRefresh: vi.fn(),
}));

describe("reportService", () => {
  beforeEach(() => {
    getLlmHfClientMock.mockReset();
    generateWithChatThenFallbackTextMock.mockReset();
    generateWithMistralChatMock.mockReset();
    backendFetchMock.mockReset();
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

  it("uses extended request timeout for Demeter report queue calls", async () => {
    backendFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ operationId: "op-report-1", status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          operationId: "op-report-1",
          status: "completed",
          response: {
            report: {
              format: "CRI",
              title: "Compte rendu Demeter",
              sections: [{ heading: "Synthese", paragraphs: ["Texte"] }],
            },
            raw: "{}",
          },
        }),
      });

    const result = await generateReportDetailed({
      provider: "demeter_sante",
      format: "CRI",
      modelId: "mistral-medium-latest",
      sourceText: "source",
      temperature: 0,
      maxTokens: 1024,
      detailLevel: "standard",
    });

    expect(result.report.title).toBe("Compte rendu Demeter");
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      1,
      "/providers/demeter-sante/report/operations",
      expect.objectContaining({ timeoutMs: 10 * 60_000 })
    );
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      2,
      "/providers/demeter-sante/report/operations/op-report-1",
      expect.objectContaining({ timeoutMs: 10 * 60_000 })
    );
  });

  it("retries Demeter report queue when backend returns invalid report JSON", async () => {
    backendFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ operationId: "op-report-invalid", status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          operationId: "op-report-invalid",
          status: "failed",
          lastError: "invalid report payload: invalid JSON response",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ operationId: "op-report-retry", status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          operationId: "op-report-retry",
          status: "completed",
          response: {
            report: {
              format: "CRN",
              title: "Compte rendu relancé",
              sections: [{ heading: "Synthese", paragraphs: ["Texte"] }],
            },
            raw: "{}",
          },
        }),
      });

    const result = await generateReportDetailed({
      provider: "demeter_sante",
      format: "CRN",
      modelId: "mistral-medium-latest",
      sourceText: "source",
      temperature: 0,
      maxTokens: 1024,
      detailLevel: "exhaustive",
      pollTimeoutMs: 123_456,
    });

    expect(result.report.title).toBe("Compte rendu relancé");
    expect(backendFetchMock).toHaveBeenCalledTimes(4);
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      1,
      "/providers/demeter-sante/report/operations",
      expect.objectContaining({ method: "POST" })
    );
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      3,
      "/providers/demeter-sante/report/operations",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("formats Demeter Mistral rate limit errors without exposing raw upstream JSON", async () => {
    backendFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ operationId: "op-report-rate-limit", status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          operationId: "op-report-rate-limit",
          status: "failed",
          statusCode: 429,
          lastError:
            'mistral api (429): {"object":"error","message":"Rate limit exceeded","type":"rate_limited","param":null,"code":"1300","raw_status_code":429}',
        }),
      });

    await expect(
      generateReportDetailed({
        provider: "demeter_sante",
        format: "CRI",
        modelId: "mistral-medium-latest",
        sourceText: "source",
        temperature: 0,
        maxTokens: 1024,
        detailLevel: "standard",
      })
    ).rejects.toThrow("Limite Mistral atteinte (429).");
  });
});
