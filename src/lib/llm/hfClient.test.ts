import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inferenceCtor: vi.fn(function MockInferenceClient(this: Record<string, unknown>, token: string) {
    this.token = token;
    this.chatCompletion = vi.fn(async () => ({ choices: [{ message: { content: "ok" } }] }));
    this.textGeneration = vi.fn(async () => ({ generated_text: "ok" }));
  }),
}));

vi.mock("@huggingface/inference", () => ({
  InferenceClient: mocks.inferenceCtor,
}));

import { generateWithChatThenFallbackText, getLlmHfClient } from "@/lib/llm/hfClient";

describe("hfClient", () => {
  it("throws when HF token is missing", async () => {
    await expect(getLlmHfClient("   ")).rejects.toThrow("Token Hugging Face manquant.");
  });

  it("caches client by trimmed token and recreates on token change", async () => {
    const first = await getLlmHfClient("  token-a  ");
    const second = await getLlmHfClient("token-a");
    const third = await getLlmHfClient("token-b");

    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(mocks.inferenceCtor).toHaveBeenCalledWith("token-a");
    expect(mocks.inferenceCtor).toHaveBeenCalledWith("token-b");
  });

  it("uses chatCompletion when available", async () => {
    const client = {
      chatCompletion: vi.fn(async () => ({
        choices: [{ message: { content: '{"format":"CRI","title":"X","sections":[{"heading":"H","paragraphs":["P"]}]}' } }],
      })),
      textGeneration: vi.fn(),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 512,
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
    expect(client.textGeneration).not.toHaveBeenCalled();
    expect(client.chatCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "auto",
      })
    );
  });

  it("falls back to textGeneration when chatCompletion fails", async () => {
    const client = {
      chatCompletion: vi.fn(async () => {
        throw new Error("chat not supported");
      }),
      textGeneration: vi.fn(async () => ({ generated_text: '{"ok":true}' })),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 512,
    });

    expect(result.strategy).toBe("textGeneration");
    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
    expect(client.textGeneration).toHaveBeenCalledTimes(1);
  });

  it("accepts array textGeneration responses and trims generated text", async () => {
    const client = {
      chatCompletion: vi.fn(async () => {
        throw new Error("chat unavailable");
      }),
      textGeneration: vi.fn(async () => [{ generated_text: "  ok-array  " }]),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 512,
    });

    expect(result).toEqual({ text: "ok-array", strategy: "textGeneration" });
  });

  it("throws when modelId is blank after trimming", async () => {
    const client = {
      chatCompletion: vi.fn(async () => ({ choices: [{ message: { content: "ok" } }] })),
      textGeneration: vi.fn(),
    };

    await expect(
      generateWithChatThenFallbackText({
        client,
        modelId: "   ",
        systemPrompt: "system",
        userPrompt: "user",
        temperature: 0,
        maxTokens: 512,
      })
    ).rejects.toThrow("Model ID manquant.");
  });

  it("normalizes provider/maxTokens/temperature and uses plain text fallback inputs in text mode", async () => {
    const client = {
      chatCompletion: vi.fn(async () => {
        throw new Error("chat unavailable");
      }),
      textGeneration: vi.fn(async () => ({ generated_text: "plain-output" })),
    };

    await generateWithChatThenFallbackText({
      client,
      modelId: "openai/gpt-oss-20b",
      systemPrompt: "S",
      userPrompt: "U",
      temperature: Number.POSITIVE_INFINITY,
      maxTokens: Number.NaN,
      responseMode: "text",
      provider: "   ",
      maxRetries: 0,
    });

    expect(client.textGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "auto",
        inputs: "S\n\nU",
        parameters: expect.objectContaining({
          max_new_tokens: 2048,
          temperature: 0.2,
        }),
      })
    );
  });

  it("parses chatCompletion content when returned as structured blocks", async () => {
    const client = {
      chatCompletion: vi.fn(async () => ({
        choices: [
          {
            message: {
              content: [{ type: "text", text: '{"format":"CRI","title":"Bloc","sections":[{"heading":"H","paragraphs":["P"]}]}' }],
            },
          },
        ],
      })),
      textGeneration: vi.fn(),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "openai/gpt-oss-20b",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 512,
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(result.text).toContain('"title":"Bloc"');
    expect(client.textGeneration).not.toHaveBeenCalled();
  });

  it("parses direct chat content objects", async () => {
    const client = {
      chatCompletion: vi.fn(async () => ({
        content: { text: '{"format":"CRI","title":"Obj","sections":[{"heading":"H","paragraphs":["P"]}]}' },
      })),
      textGeneration: vi.fn(),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "openai/gpt-oss-20b",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 512,
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(result.text).toContain('"title":"Obj"');
  });

  it("retries retryable errors", async () => {
    const retryable = Object.assign(new Error("429 rate limit"), { status: 429 });
    const client = {
      chatCompletion: vi.fn(async () => {
        throw new Error("chat unavailable");
      }),
      textGeneration: vi
        .fn()
        .mockRejectedValueOnce(retryable)
        .mockResolvedValueOnce({ generated_text: '{"ok":true}' }),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "Qwen/Qwen2.5-7B-Instruct",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 512,
      maxRetries: 2,
      initialBackoffMs: 1,
    });

    expect(result.strategy).toBe("textGeneration");
    expect(client.textGeneration).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error when no HF inference provider exists for the model", async () => {
    const missingProviderError = new Error(
      "We have not been able to find inference provider information for model mistralai/Mistral-Large-Instruct-2411."
    );
    const client = {
      chatCompletion: vi.fn(async () => {
        throw missingProviderError;
      }),
      textGeneration: vi.fn(async () => ({ generated_text: '{"ok":true}' })),
    };

    await expect(
      generateWithChatThenFallbackText({
        client,
        modelId: "mistralai/Mistral-Large-Instruct-2411",
        systemPrompt: "system",
        userPrompt: "user",
        temperature: 0,
        maxTokens: 512,
      })
    ).rejects.toThrow(/aucun provider hf inference/i);

    expect(client.chatCompletion).toHaveBeenCalledTimes(1);
    expect(client.textGeneration).not.toHaveBeenCalled();
  });

  it("throws a clear error when provider only supports conversational task", async () => {
    const client = {
      chatCompletion: vi.fn(async () => {
        throw new Error("chat transient issue");
      }),
      textGeneration: vi.fn(async () => {
        throw new Error(
          "Model openai/gpt-oss-20b is not supported for task text-generation and provider groq. Supported task: conversational."
        );
      }),
    };

    await expect(
      generateWithChatThenFallbackText({
        client,
        modelId: "openai/gpt-oss-20b",
        systemPrompt: "system",
        userPrompt: "user",
        temperature: 0,
        maxTokens: 512,
      })
    ).rejects.toThrow(/mode conversation uniquement/i);

    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(client.textGeneration).toHaveBeenCalledTimes(1);
  });

  it("retries chatCompletion with reduced max tokens when model is conversational-only", async () => {
    const client = {
      chatCompletion: vi
        .fn()
        .mockRejectedValueOnce(new Error("max_tokens exceeds provider limit"))
        .mockResolvedValueOnce({
          choices: [{ message: { content: '{"format":"CRI","title":"OK","sections":[{"heading":"H","paragraphs":["P"]}]}' } }],
        }),
      textGeneration: vi.fn(async () => {
        throw new Error(
          "Model openai/gpt-oss-20b is not supported for task text-generation and provider groq. Supported task: conversational."
        );
      }),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "openai/gpt-oss-20b",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 131072,
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(result.text).toContain('"title":"OK"');
    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(client.textGeneration).toHaveBeenCalledTimes(1);

    const secondChatCallArgs = client.chatCompletion.mock.calls[1]?.[0] as { max_tokens?: number };
    expect(secondChatCallArgs.max_tokens).toBe(8192);
  });

  it("retries with hf-inference provider when auto provider requires PRO", async () => {
    const client = {
      chatCompletion: vi.fn(async (...args: unknown[]) => {
        const request = (args[0] ?? {}) as { provider?: string };
        if (request.provider === "auto") {
          throw new Error("chat transient issue");
        }
        return {
          choices: [{ message: { content: '{"format":"CRI","title":"HF","sections":[{"heading":"H","paragraphs":["P"]}]}' } }],
        };
      }),
      textGeneration: vi.fn(async () => {
        throw new Error("Failed to perform inference: Subscribe to PRO to use Inference Providers with your account.");
      }),
    };

    const result = await generateWithChatThenFallbackText({
      client,
      modelId: "openai/gpt-oss-20b",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0,
      maxTokens: 2048,
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(result.text).toContain('"title":"HF"');
    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(client.textGeneration).toHaveBeenCalledTimes(1);
    expect(client.chatCompletion.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ provider: "auto" }));
    expect(client.chatCompletion.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ provider: "hf-inference" }));
  });

  it("shows clear message when PRO is required and model is unavailable on hf-inference", async () => {
    const client = {
      chatCompletion: vi.fn(async (...args: unknown[]) => {
        const request = (args[0] ?? {}) as { provider?: string };
        if (request.provider === "auto") {
          throw new Error("chat transient issue");
        }
        throw new Error(
          "We have not been able to find inference provider information for model openai/gpt-oss-20b."
        );
      }),
      textGeneration: vi.fn(async () => {
        throw new Error("Failed to perform inference: Subscribe to PRO to use Inference Providers with your account.");
      }),
    };

    await expect(
      generateWithChatThenFallbackText({
        client,
        modelId: "openai/gpt-oss-20b",
        systemPrompt: "system",
        userPrompt: "user",
        temperature: 0,
        maxTokens: 2048,
      })
    ).rejects.toThrow(/pro requis.*pas disponible sur hf-inference/i);
  });
});
