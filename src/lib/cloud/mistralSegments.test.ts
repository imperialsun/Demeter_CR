import { describe, expect, it } from "vitest";
import { parseMistralOutput } from "./mistralSegments";

describe("parseMistralOutput", () => {
  it("maps segment timestamps, confidence and words with offset", () => {
    const output = {
      text: "bonjour monde",
      segments: [
        {
          text: "bonjour",
          start: 0,
          end: 1.2,
          confidence: 0.91,
          speaker: "SPEAKER_00",
          words: [
            { word: "bonjour", start: 0, end: 1.2, confidence: 0.9 },
          ],
        },
      ],
    };

    const segments = parseMistralOutput(output, {
      offsetSec: 30,
      startIndex: 2,
      chunkId: "mistral-1",
      fallbackDurationSec: 15,
      includeWordTimestamps: true,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].index).toBe(2);
    expect(segments[0].start).toBeCloseTo(30);
    expect(segments[0].end).toBeCloseTo(31.2);
    expect(segments[0].confidence).toBeCloseTo(0.91);
    expect(segments[0].confidenceSource).toBe("model");
    expect(segments[0].speaker).toBe("SPEAKER_00");
    expect(segments[0].words?.[0]?.start).toBeCloseTo(30);
  });

  it("falls back to full text when no segments are available", () => {
    const output = { text: "Transcription complète" };
    const segments = parseMistralOutput(output, {
      offsetSec: 0,
      startIndex: 0,
      chunkId: "mistral-0",
      fallbackDurationSec: 12,
      includeWordTimestamps: false,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Transcription complète");
    expect(segments[0].end).toBe(12);
    expect(segments[0].words).toBeUndefined();
  });
});
