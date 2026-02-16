import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FALLBACK_MISTRAL_MAX_TOKENS,
  fetchMistralModels,
  fetchMistralModelsSafe,
  findMistralModelMetadata,
  resolveMistralMaxTokens,
} from "@/lib/llm/mistralModelsClient";

describe("mistralModelsClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("parses model metadata from /v1/models and keeps chat-capable models only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            {
              id: "mistral-medium-latest",
              max_context_length: 32768,
              capabilities: { completion_chat: true },
            },
            {
              id: "audio-only-model",
              capabilities: { completion_chat: false },
            },
          ],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    const models = await fetchMistralModels({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
    });

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual({
      id: "mistral-medium-latest",
      maxContextTokens: 32768,
      supportsChat: true,
    });
  });

  it("caches model list for same api url and key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "mistral-medium-latest", max_context_length: 32768, capabilities: { completion_chat: true } }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      )
    );

    await fetchMistralModels({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
      forceRefresh: true,
    });
    await fetchMistralModels({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns empty list from safe fetch when endpoint fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    );

    const models = await fetchMistralModelsSafe({
      apiUrl: "https://api.mistral.ai",
      apiKey: "bad_key",
      forceRefresh: true,
    });

    expect(models).toEqual([]);
  });

  it("finds model metadata and resolves max tokens", () => {
    const models = [
      { id: "mistral-medium-latest", maxContextTokens: 32768, supportsChat: true },
      { id: "other", maxContextTokens: 4096, supportsChat: true },
    ];

    const metadata = findMistralModelMetadata(models, "mistral-medium-latest");
    expect(metadata?.id).toBe("mistral-medium-latest");
    expect(resolveMistralMaxTokens(metadata)).toBe(32256);
    expect(resolveMistralMaxTokens(undefined)).toBe(FALLBACK_MISTRAL_MAX_TOKENS);
  });
});
