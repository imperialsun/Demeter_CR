import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";

describe("mistralChatClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns chat content on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"ok":true}' } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await generateWithMistralChat({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
      responseMode: "json",
    });

    expect(result.strategy).toBe("chatCompletion");
    expect(result.text).toContain('"ok":true');

    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      response_format?: { type?: string };
    };
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("parses structured content blocks", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: [{ type: "text", text: "Bloc 1" }, { type: "text", text: "Bloc 2" }] } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    const result = await generateWithMistralChat({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
      responseMode: "text",
    });

    expect(result.text).toContain("Bloc 1");
    expect(result.text).toContain("Bloc 2");

    const body = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      response_format?: { type?: string };
    };
    expect(body.response_format).toBeUndefined();
  });

  it("retries on retryable status", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "temporary overload" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await generateWithMistralChat({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
      initialBackoffMs: 1,
    });

    expect(result.text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("retries with reduced max_tokens on context error", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Context length exceeded" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );

    const result = await generateWithMistralChat({
      apiUrl: "https://api.mistral.ai",
      apiKey: "mistral_key",
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 4096,
      maxRetries: 0,
    });

    expect(result.text).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse((fetchSpy.mock.calls[0]?.[1] as RequestInit).body as string) as {
      max_tokens: number;
    };
    const secondBody = JSON.parse((fetchSpy.mock.calls[1]?.[1] as RequestInit).body as string) as {
      max_tokens: number;
    };
    expect(firstBody.max_tokens).toBe(4096);
    expect(secondBody.max_tokens).toBe(2048);
  });

  it("formats api errors with status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: [{ msg: "Invalid model" }] }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      generateWithMistralChat({
        apiUrl: "https://api.mistral.ai",
        apiKey: "mistral_key",
        modelId: "unknown-model",
        systemPrompt: "system",
        userPrompt: "user",
        temperature: 0.2,
        maxTokens: 2048,
      })
    ).rejects.toThrow(/Mistral API \(400\): Invalid model/i);
  });
});
