import { describe, expect, it } from "vitest";
import { buildTranscriptDocx, formatTranscriptDocxFilename } from "@/lib/docx/transcriptDocx";
import type { TranscriptionSegment } from "@/lib/export";

describe("transcriptDocx", () => {
  it("builds a non-empty blob from transcript segments", async () => {
    const segments: TranscriptionSegment[] = [
      {
        index: 0,
        start: 0,
        end: 1.2,
        text: "Bonjour",
        speaker: "Alice",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
      {
        index: 1,
        start: 1.2,
        end: 2.4,
        text: "Suite",
        chunkId: "chunk-1",
        strategy: "chunks",
      },
    ];

    const blob = await buildTranscriptDocx(segments, {
      sourceMode: "cloud",
      sourceLabel: "session.wav",
      generatedAt: "2026-02-16T09:05:00.000Z",
    });

    expect(blob.size).toBeGreaterThan(0);
  });

  it("formats the docx filename", () => {
    const file = formatTranscriptDocxFilename(new Date("2026-02-16T09:05:00Z"));
    expect(file).toMatch(/^transcription-brute-\d{4}-\d{2}-\d{2}-\d{4}\.docx$/);
  });
});
