import { beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeWithMistral } from "./mistralClient";

describe("transcribeWithMistral", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when token is missing", async () => {
    const file = new File(["abc"], "test.wav", { type: "audio/wav" });
    await expect(
      transcribeWithMistral({
        apiUrl: "https://api.mistral.ai",
        apiKey: "   ",
        model: "voxtral-mini-transcribe-26-02",
        file,
      })
    ).rejects.toThrow("Token API Mistral manquant");
  });

  it("posts multipart data and returns json on success", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const file = new File(["abc"], "test.wav", { type: "audio/wav" });
    const result = await transcribeWithMistral({
      apiUrl: "https://api.mistral.ai/",
      apiKey: "token",
      model: "voxtral-mini-transcribe-26-02",
      file,
    });

    expect(result).toEqual({ text: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://api.mistral.ai/v1/audio/transcriptions");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer token" });
    expect(init?.body).toBeInstanceOf(FormData);
  });
});

