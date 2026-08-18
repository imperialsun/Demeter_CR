import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeReportSource, generateReport, generateReportDetailed } from "@/lib/llm/reportService";

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

  it("analyzes missing information directly for Mistral", async () => {
    generateWithMistralChatMock.mockResolvedValue({
      text: JSON.stringify({
        needsClarification: true,
        summary: "Participants absents",
        questions: [{ id: "participants", question: "Qui était présent ?", rationale: "Absent" }],
      }),
      strategy: "chatCompletion",
    });

    const result = await analyzeReportSource({
      provider: "mistral",
      modelId: "mistral-medium-latest",
      mistralApiKey: "mistral_secret",
      mistralApiUrl: "https://api.mistral.ai",
      sourceText: "CR équipe / budget",
      sourceKind: "word_note",
    });

    expect(result.clarification.questions[0]?.id).toBe("participants");
    expect(generateWithMistralChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        temperature: 0,
        maxTokens: 512,
        systemPrompt: expect.stringContaining("prise de note Word très abrégée"),
        userPrompt: expect.stringContaining("CR équipe / budget"),
      })
    );
    expect(backendFetchMock).not.toHaveBeenCalled();
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
      pollIntervalMs: 1,
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

  it("uses the existing Demeter report queue for clarification and polls it", async () => {
    backendFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ operationId: "op-clarification-1", status: "pending" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          operationId: "op-clarification-1",
          status: "completed",
          response: {
            kind: "clarification",
            clarification: {
              needsClarification: true,
              summary: "Participants absents",
              questions: [{ id: "participants", question: "Qui participait ?" }],
            },
          },
        }),
      });

    const result = await analyzeReportSource({
      provider: "demeter_sante",
      modelId: "mistral-medium-latest",
      sourceText: "CR équipe / budget",
      sourceKind: "word_note",
      pollTimeoutMs: 123_456,
      pollIntervalMs: 1,
    });

    expect(result.clarification.questions[0]?.question).toBe("Qui participait ?");
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      1,
      "/providers/demeter-sante/report/operations",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"operationType":"clarification"'),
      })
    );
    const submitOptions = backendFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(submitOptions.body).toContain('"sourceKind":"word_note"');
    expect(submitOptions.body).toContain('"temperature":0');
    expect(backendFetchMock).toHaveBeenNthCalledWith(
      2,
      "/providers/demeter-sante/report/operations/op-clarification-1",
      expect.objectContaining({ method: "GET" })
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
      pollIntervalMs: 1,
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

  it("cancels the backend operation when the queue signal is aborted", async () => {
    const requestStarted = createDeferred<void>();
    const controller = new AbortController();
    backendFetchMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return {
          ok: true,
          json: async () => ({ operationId: "op-abort-1", status: "pending" }),
        };
      }
      if (init?.method === "DELETE") {
        return { ok: true, json: async () => ({ operationId: "op-abort-1", status: "cancelled" }) };
      }
      requestStarted.resolve(undefined);
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    });

    const operation = analyzeReportSource({
      provider: "demeter_sante",
      modelId: "mistral-medium-latest",
      sourceText: "note abrégée",
      sourceKind: "word_note",
      signal: controller.signal,
      pollIntervalMs: 1,
    });
    await requestStarted.promise;
    controller.abort();

    await expect(operation).rejects.toMatchObject({ name: "AbortError" });
    expect(backendFetchMock).toHaveBeenCalledWith(
      "/providers/demeter-sante/report/operations/op-abort-1",
      expect.objectContaining({ method: "DELETE", retryAttempts: 0 })
    );
    expect(pathForCalls(backendFetchMock)).toEqual([
      "/providers/demeter-sante/report/operations",
      "/providers/demeter-sante/report/operations/op-abort-1",
      "/providers/demeter-sante/report/operations/op-abort-1",
    ]);
  });
});

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function pathForCalls(mock: typeof backendFetchMock): string[] {
  return mock.mock.calls.map(([path]) => path as string);
}
