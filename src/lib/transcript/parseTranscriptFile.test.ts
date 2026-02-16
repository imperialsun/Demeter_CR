import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_UPLOAD_BYTES, parseTranscriptFile } from "./parseTranscriptFile";

describe("parseTranscriptFile", () => {
  it("parses txt files", async () => {
    const file = new File(["Bonjour\r\nMonde"], "source.txt", { type: "text/plain" });
    const parsed = await parseTranscriptFile(file);

    expect(parsed.format).toBe("txt");
    expect(parsed.extraction).toBe("plain");
    expect(parsed.text).toBe("Bonjour\nMonde");
  });

  it("parses srt files", async () => {
    const file = new File(
      [
        `1
00:00:00,000 --> 00:00:01,000
Bonjour

2
00:00:01,200 --> 00:00:02,000
Monde`,
      ],
      "source.srt",
      { type: "text/plain" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("srt");
    expect(parsed.extraction).toBe("segments");
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.text).toBe("Bonjour\nMonde");
  });

  it("parses vtt files", async () => {
    const file = new File(
      [
        `WEBVTT

00:00:00.000 --> 00:00:01.000
Salut

00:00:01.300 --> 00:00:02.000 align:start
A tous`,
      ],
      "source.vtt",
      { type: "text/vtt" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("vtt");
    expect(parsed.extraction).toBe("segments");
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.text).toBe("Salut\nA tous");
  });

  it("parses json with segments array", async () => {
    const file = new File(
      [
        JSON.stringify({
          segments: [{ text: "Premiere ligne" }, { transcript: "Deuxieme ligne" }],
        }),
      ],
      "segments.json",
      { type: "application/json" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("json");
    expect(parsed.extraction).toBe("segments");
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.text).toBe("Premiere ligne\nDeuxieme ligne");
  });

  it("parses json with results alternatives", async () => {
    const file = new File(
      [
        JSON.stringify({
          results: [{ alternatives: [{ transcript: "Bonjour" }] }, { text: "tout le monde" }],
        }),
      ],
      "asr.json",
      { type: "application/json" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("json");
    expect(parsed.extraction).toBe("results");
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.text).toBe("Bonjour\ntout le monde");
  });

  it("rejects non-transcription json", async () => {
    const file = new File([JSON.stringify({ telemetry: { events: [] } })], "telemetry.json", {
      type: "application/json",
    });

    await expect(parseTranscriptFile(file)).rejects.toThrow(/non interpretable/i);
  });

  it("rejects files larger than max limit", async () => {
    const textSpy = vi.fn(async () => "ignored");
    const hugeFile = {
      name: "huge.txt",
      type: "text/plain",
      size: DEFAULT_MAX_UPLOAD_BYTES + 1,
      text: textSpy,
    } as unknown as File;

    await expect(parseTranscriptFile(hugeFile)).rejects.toThrow("Fichier trop volumineux (max 50 Mo).");
    expect(textSpy).not.toHaveBeenCalled();
  });
});
