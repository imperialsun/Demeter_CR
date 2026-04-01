import { Document, Packer, Paragraph, TextRun } from "docx";
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

  it("parses docx files", async () => {
    const doc = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [new TextRun("Bonjour")],
            }),
            new Paragraph({
              children: [new TextRun("Monde")],
            }),
          ],
        },
      ],
    });
    const buffer = await Packer.toBuffer(doc);
    const file = new File([buffer], "source.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("docx");
    expect(parsed.extraction).toBe("plain");
    expect(parsed.text).toContain("Bonjour");
    expect(parsed.text).toContain("Monde");
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

  it("rejects unsupported extensions", async () => {
    const file = new File(["hello"], "source.pdf", { type: "application/pdf" });
    await expect(parseTranscriptFile(file)).rejects.toThrow(/format non supporte/i);
  });

  it("rejects empty files", async () => {
    const file = new File(["\r\n   \n"], "empty.txt", { type: "text/plain" });
    await expect(parseTranscriptFile(file)).rejects.toThrow(/fichier vide/i);
  });

  it("rejects invalid json payloads", async () => {
    const file = new File(["{not-json"], "broken.json", { type: "application/json" });
    await expect(parseTranscriptFile(file)).rejects.toThrow(/json invalide/i);
  });

  it("parses json channels alternatives", async () => {
    const file = new File(
      [
        JSON.stringify({
          channels: [{ alternatives: [{ transcript: "Canal A" }, { transcript: "Canal B" }] }],
        }),
      ],
      "channels.json",
      { type: "application/json" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.extraction).toBe("results");
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.text).toBe("Canal A\nCanal B");
  });

  it("falls back to nested text extraction within max depth", async () => {
    const file = new File(
      [
        JSON.stringify({
          a: {
            b: {
              c: {
                d: {
                  text: "Texte imbriqué",
                },
              },
            },
          },
        }),
      ],
      "fallback.json",
      { type: "application/json" }
    );

    const parsed = await parseTranscriptFile(file);
    expect(parsed.extraction).toBe("fallback");
    expect(parsed.text).toContain("Texte imbriqué");
  });

  it("uses FileReader fallback when file.text is unavailable", async () => {
    const originalFileReader = globalThis.FileReader;
    class MockFileReader {
      public result: string | null = null;
      public onerror: (() => void) | null = null;
      public onload: (() => void) | null = null;

      readAsText() {
        this.result = "Bonjour via reader";
        this.onload?.();
      }
    }

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: MockFileReader,
    });

    const file = {
      name: "reader.txt",
      type: "text/plain",
      size: 15,
    } as unknown as File;

    const parsed = await parseTranscriptFile(file);
    expect(parsed.format).toBe("txt");
    expect(parsed.text).toBe("Bonjour via reader");

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: originalFileReader,
    });
  });

  it("surfaces FileReader errors with a readable message", async () => {
    const originalFileReader = globalThis.FileReader;
    class MockFileReaderWithError {
      public onerror: (() => void) | null = null;
      public onload: (() => void) | null = null;

      readAsText() {
        this.onerror?.();
      }
    }

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: MockFileReaderWithError,
    });

    const file = {
      name: "reader-error.txt",
      type: "text/plain",
      size: 15,
    } as unknown as File;

    await expect(parseTranscriptFile(file)).rejects.toThrow(/impossible de lire le fichier/i);

    Object.defineProperty(globalThis, "FileReader", {
      configurable: true,
      value: originalFileReader,
    });
  });
});
