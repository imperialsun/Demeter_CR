import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const InferenceClient = vi.fn(function MockInferenceClient(this: { token: string }, token: string) {
    this.token = token;
  });
  return {
    InferenceClient,
    loggerError: vi.fn(() => {}),
    loggerInfo: vi.fn(() => {}),
  };
});

vi.mock("@huggingface/inference", () => ({
  InferenceClient: mocks.InferenceClient,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

describe("getWhisperClient", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.InferenceClient.mockClear();
    mocks.loggerError.mockClear();
    mocks.loggerInfo.mockClear();
  });

  it("throws when token is missing", async () => {
    const { getWhisperClient } = await import("./whisperClient");
    const telemetry = { recordAlert: vi.fn(), logEvent: vi.fn() };

    await expect(getWhisperClient("   ", telemetry as never)).rejects.toThrow(
      "Token Hugging Face manquant"
    );
    expect(telemetry.recordAlert).toHaveBeenCalledWith(
      "CLOUD_WHISPER_TOKEN_MISSING",
      expect.objectContaining({ message: "Token Hugging Face manquant" })
    );
  });

  it("caches client by token and reuses module promise", async () => {
    const { getWhisperClient } = await import("./whisperClient");
    const telemetry = { logEvent: vi.fn(), recordAlert: vi.fn() };

    const c1 = await getWhisperClient("hf_token", telemetry as never);
    const c2 = await getWhisperClient(" hf_token ", telemetry as never);

    expect(c1).toBe(c2);
    expect(mocks.InferenceClient).toHaveBeenCalledTimes(1);
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "CLOUD_WHISPER_CLIENT_INIT",
      expect.objectContaining({ tokenLength: 8 })
    );
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "CLOUD_WHISPER_CLIENT_READY",
      expect.objectContaining({ tokenLength: 8 })
    );
  });

  it("creates a new client when token changes", async () => {
    const { getWhisperClient } = await import("./whisperClient");
    await getWhisperClient("token_a");
    await getWhisperClient("token_b");

    expect(mocks.InferenceClient).toHaveBeenCalledTimes(2);
    expect(mocks.InferenceClient).toHaveBeenNthCalledWith(1, "token_a");
    expect(mocks.InferenceClient).toHaveBeenNthCalledWith(2, "token_b");
  });
});

