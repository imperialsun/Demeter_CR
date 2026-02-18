import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeCloudError,
  extractSrtText,
  resolveChunkingConfig,
} from "@/hooks/useCloudTranscription.steps";

describe("useCloudTranscription.steps", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("normalizes chunk duration/overlap bounds", () => {
    expect(resolveChunkingConfig(0, 0)).toEqual({ duration: 5, overlap: 0 });
    expect(resolveChunkingConfig(12.2, 20)).toEqual({ duration: 12, overlap: 11 });
    expect(resolveChunkingConfig(8.7, -1)).toEqual({ duration: 9, overlap: 0 });
  });

  it("formats cloud errors safely", () => {
    expect(describeCloudError(undefined)).toBe("Erreur inconnue");
    expect(describeCloudError("failed")).toBe("failed");
    expect(describeCloudError(new Error("boom"))).toBe("boom");
    expect(describeCloudError({ code: 422 })).toBe('{"code":422}');
  });

  it("returns plain SRT string directly", async () => {
    const srt = "1\n00:00:00,000 --> 00:00:01,000\nBonjour";
    await expect(extractSrtText(srt, "https://api.example.com")).resolves.toBe(srt);
  });

  it("fetches SRT from absolute and relative URLs", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("SRT DATA", { status: 200 }));

    await expect(extractSrtText("https://cdn.example.com/file.srt", "https://api.example.com")).resolves.toBe(
      "SRT DATA"
    );
    await expect(extractSrtText({ path: "/relative.srt" }, "https://api.example.com/")).resolves.toBe("SRT DATA");

    expect(fetchSpy).toHaveBeenNthCalledWith(1, "https://cdn.example.com/file.srt");
    expect(fetchSpy).toHaveBeenNthCalledWith(2, "https://api.example.com/relative.srt");
  });

  it("extracts SRT from base64 data payload", async () => {
    const encoded = btoa("1\n00:00:00,000 --> 00:00:01,000\nSalut");
    await expect(extractSrtText({ data: encoded }, "https://api.example.com")).resolves.toContain("-->");
  });

  it("returns null when source cannot be decoded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    await expect(extractSrtText({ data: "%%%invalid%%%" }, "https://api.example.com")).resolves.toBeNull();
  });
});
