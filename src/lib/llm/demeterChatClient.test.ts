import { beforeEach, describe, expect, it, vi } from "vitest";

const backendApiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  parseBackendHttpError: vi.fn(),
  handleBackendUnauthorized: vi.fn(),
}));

const backendAuthMocks = vi.hoisted(() => ({
  backendRefresh: vi.fn(),
  BackendSessionExpiredError: class BackendSessionExpiredError extends Error {},
}));

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api");
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => backendApiMocks.backendFetch(...args),
    parseBackendHttpError: (...args: unknown[]) => backendApiMocks.parseBackendHttpError(...args),
    handleBackendUnauthorized: (...args: unknown[]) => backendApiMocks.handleBackendUnauthorized(...args),
  };
});

vi.mock("@/lib/backend-auth", () => ({
  backendRefresh: (...args: unknown[]) => backendAuthMocks.backendRefresh(...args),
  BackendSessionExpiredError: backendAuthMocks.BackendSessionExpiredError,
}));

import { BACKEND_NETWORK_ERROR_MESSAGE, BackendHttpError } from "@/lib/backend-api";
import { generateWithDemeterChat } from "@/lib/llm/demeterChatClient";

describe("demeterChatClient", () => {
  beforeEach(() => {
    backendApiMocks.backendFetch.mockReset();
    backendApiMocks.parseBackendHttpError.mockReset();
    backendApiMocks.handleBackendUnauthorized.mockReset();
    backendAuthMocks.backendRefresh.mockReset();
  });

  it("refreshes backend auth and retries the chat completion request when access has expired", async () => {
    backendAuthMocks.backendRefresh.mockResolvedValue("refreshed");
    backendApiMocks.backendFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "rapport ok",
                },
              },
            ],
          }),
          { status: 200 }
        )
      );
    backendApiMocks.parseBackendHttpError.mockResolvedValue(
      new BackendHttpError({
        status: 401,
        code: "unauthorized",
        message: "Session expirée. Veuillez vous reconnecter.",
        path: "/providers/demeter-sante/chat/completions",
        method: "POST",
      })
    );

    const result = await generateWithDemeterChat({
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
    });

    expect(result.text).toBe("rapport ok");
    expect(backendAuthMocks.backendRefresh).toHaveBeenCalledTimes(1);
    expect(backendApiMocks.handleBackendUnauthorized).not.toHaveBeenCalled();
  });

  it("retries the chat completion request after a transient backend outage", async () => {
    backendApiMocks.backendFetch
      .mockRejectedValueOnce(new Error(BACKEND_NETWORK_ERROR_MESSAGE))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "rapport ok",
                },
              },
            ],
          }),
          { status: 200 }
        )
      );

    const result = await generateWithDemeterChat({
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
      initialBackoffMs: 1,
    });

    expect(result.text).toBe("rapport ok");
    expect(backendApiMocks.backendFetch).toHaveBeenCalledTimes(2);
  });

  it("retries the chat completion request after a transient 404", async () => {
    backendApiMocks.backendFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "not found" }), { status: 404 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "rapport ok",
                },
              },
            ],
          }),
          { status: 200 }
        )
      );
    backendApiMocks.parseBackendHttpError.mockResolvedValue(
      new BackendHttpError({
        status: 404,
        code: "not_found",
        message: "not found",
        path: "/providers/demeter-sante/chat/completions",
        method: "POST",
      })
    );

    const result = await generateWithDemeterChat({
      modelId: "mistral-medium-latest",
      systemPrompt: "system",
      userPrompt: "user",
      temperature: 0.2,
      maxTokens: 2048,
      initialBackoffMs: 1,
    });

    expect(result.text).toBe("rapport ok");
    expect(backendApiMocks.backendFetch).toHaveBeenCalledTimes(2);
  });
});
