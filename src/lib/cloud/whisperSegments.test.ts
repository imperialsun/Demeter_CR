import { describe, expect, it } from "vitest";
import { parseWhisperOutput } from "./whisperSegments";

describe("parseWhisperOutput", () => {
  it("maps chunk timestamps with offsets", () => {
    const output = {
      text: "Bonjour monde",
      chunks: [
        { text: "Bonjour", timestamp: [0, 1.2] },
        { text: "monde", timestamp: [1.2, 2.4] },
      ],
    };

    const segments = parseWhisperOutput(output, {
      offsetSec: 60,
      startIndex: 5,
      chunkId: "whisper-2",
      fallbackDurationSec: 30,
    });

    expect(segments).toHaveLength(2);
    expect(segments[0].index).toBe(5);
    expect(segments[0].start).toBeCloseTo(60);
    expect(segments[0].end).toBeCloseTo(61.2);
    expect(segments[1].index).toBe(6);
    expect(segments[1].start).toBeCloseTo(61.2);
    expect(segments[1].end).toBeCloseTo(62.4);
  });

  it("falls back to full text when chunks are missing", () => {
    const output = { text: "Texte complet" };
    const segments = parseWhisperOutput(output, {
      offsetSec: 0,
      startIndex: 0,
      chunkId: "whisper-0",
      fallbackDurationSec: 12,
    });

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe("Texte complet");
    expect(segments[0].start).toBe(0);
    expect(segments[0].end).toBe(12);
  });
});
