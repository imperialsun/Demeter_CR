/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAsrStore } from "@/store/asr-store";
import { normaliseSegments } from "./useTranscriptionController";

// Mock types minimal to satisfy calls

describe("normaliseSegments", () => {
  beforeEach(() => {
    useAsrStore.getState().resetApp();
    useAsrStore.setState({
      dedupeMode: "fuzzy",
      enableWordTimestamps: false,
      debugConfidence: false,
      telemetryCollector: null,
    } as any);
  });

  it("computes segment confidence from text when missing (silence mode)", () => {
    const result: any = {
      segments: [
        {
          text: 'Bonjour ceci est un test simple.',
          start: 0,
          end: 3,
          // no confidence, no words
        },
      ],
      chunk: { id: 'c1', start: 0, end: 3 },
    };

    const out = normaliseSegments(result, "silence", 0);
    expect(out.length).toBe(1);
    expect(typeof out[0].confidence).toBe("number");
    expect(out[0].confidence!).toBeGreaterThanOrEqual(0);
    expect(out[0].confidence!).toBeLessThanOrEqual(1);
    expect(out[0].confidenceSource).toBe("estimated");
  });

  it("computes chunk confidence from text when aggregate missing (chunks mode)", () => {
    const result: any = {
      segments: [],
      chunk: { id: 'c2', start: 0, end: 4 },
      text: "Bonjour comment ça va?",
    };
    const out = normaliseSegments(result, "chunks", 0);
    expect(out.length).toBe(1);
    expect(typeof out[0].confidence).toBe("number");
    expect(out[0].confidence!).toBeGreaterThanOrEqual(0);
    expect(out[0].confidence!).toBeLessThanOrEqual(1);
    expect(out[0].confidenceSource).toBe("estimated");
  });

  it("trims overlapping prefix from chunk text", () => {
    const result: any = {
      segments: [],
      chunk: { id: "c3", start: 0, end: 4 },
      text: "Tout le monde comment ça va",
    };
    const previous: any = {
      text: "Bonjour tout le monde",
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, "chunks", 0, previous);
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("comment ça va");
  });

  it("trims when short overlap matches in normal mode", () => {
    const result: any = {
      segments: [],
      chunk: { id: "c4", start: 0, end: 5 },
      text: "bonjour blanches on commence maintenant",
    };
    const previous: any = {
      text: "Hier bonjour Blanche on commence",
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, "chunks", 0, previous, { dedupeMode: "normal" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("maintenant");
  });

  it("trims overlap when fuzzy mode tolerates minor token differences", () => {
    const result: any = {
      segments: [],
      chunk: { id: "c5", start: 0, end: 5 },
      text: "bonjour blanches on commence maintenant",
    };
    const previous: any = {
      text: "Hier bonjour Blanche on commence",
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, "chunks", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("maintenant");
  });

  it("trims overlap in silence mode when segments are adjacent", () => {
    const result: any = {
      segments: [
        {
          text: "bonjour blanches on commence maintenant",
          start: 1.1,
          end: 3,
        },
      ],
      chunk: { id: "c6", start: 0, end: 4 },
    };
    const previous: any = {
      text: "bonjour Blanche on commence",
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("maintenant");
  });

  it("trims overlap with offset tokens at the start of the segment", () => {
    const result: any = {
      segments: [],
      chunk: { id: "c8", start: 0, end: 5 },
      text: "euh bonjour on commence maintenant",
    };
    const previous: any = {
      text: "bonjour on commence",
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, "chunks", 0, previous, { dedupeMode: "normal" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("maintenant");
  });

  it("trims overlap using character-level match in fuzzy mode", () => {
    const result: any = {
      segments: [],
      chunk: { id: "c9", start: 0, end: 5 },
      text: "abxde fghij klmno",
    };
    const previous: any = {
      text: "abcde fghij",
      start: 0,
      end: 2,
    };
    const out = normaliseSegments(result, "chunks", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("klmno");
  });

  it("trims short debris prefix when previous ends with continuation", () => {
    const result: any = {
      segments: [
        {
          text: "surveillance de la cyber securite NetBlocks confirme",
          start: 1.1,
          end: 4,
        },
      ],
      chunk: { id: "c10", start: 0, end: 4 },
    };
    const previous: any = {
      text: "L'ONG de",
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("cyber securite NetBlocks confirme");
  });

  it("keeps prefix when previous ends with terminal punctuation", () => {
    const result: any = {
      segments: [
        {
          text: "depuis ce matin la situation reste tendue",
          start: 1.1,
          end: 4,
        },
      ],
      chunk: { id: "c11", start: 0, end: 4 },
    };
    const previous: any = {
      text: "C’est terminé.",
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("depuis ce matin la situation reste tendue");
  });

  it("keeps text in silence mode when segments are far apart", () => {
    const result: any = {
      segments: [
        {
          text: "bonjour blanches on commence maintenant",
          start: 4,
          end: 6,
        },
      ],
      chunk: { id: "c7", start: 0, end: 6 },
    };
    const previous: any = {
      text: "bonjour Blanche on commence",
      start: 0,
      end: 1,
    };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "fuzzy" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("bonjour blanches on commence maintenant");
  });

  it("computes chunk confidence from model segments and attaches word timestamps", () => {
    useAsrStore.setState({ enableWordTimestamps: true } as any);
    const result: any = {
      chunk: { id: "chunk-model", start: 0, end: 4 },
      text: "alpha beta",
      segments: [
        { text: "alpha", start: 0, end: 1, confidence: 0.4 },
        { text: "beta", start: 1, end: 3, confidence: 0.9 },
      ],
    };
    const out = normaliseSegments(result, "chunks", 7, undefined, { enableWordTimestamps: true });
    expect(out).toHaveLength(1);
    expect(out[0]?.index).toBe(7);
    expect(out[0]?.confidenceSource).toBe("model");
    expect(out[0]?.words).toEqual([
      { word: "alpha", start: 0, end: 1, confidence: 0.4 },
      { word: "beta", start: 1, end: 3, confidence: 0.9 },
    ]);
  });

  it("logs dedupe telemetry in chunks mode and tolerates telemetry errors", () => {
    const logEvent = vi.fn(() => {
      throw new Error("telemetry failed");
    });
    useAsrStore.setState({ telemetryCollector: { logEvent } } as any);

    const result: any = {
      chunk: { id: "chunk-telemetry", start: 0, end: 3 },
      text: "bonjour encore suite",
      segments: [],
    };
    const previous: any = { text: "salut bonjour encore", start: 0, end: 1.2 };
    const out = normaliseSegments(result, "chunks", 0, previous, { dedupeMode: "fuzzy" });

    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("suite");
    expect(logEvent).toHaveBeenCalledWith(
      "SEGMENT_DEDUP",
      expect.objectContaining({ mode: "chunks", dedupeMode: "fuzzy" })
    );
  });

  it("drops exact duplicate adjacent silence segment", () => {
    const result: any = {
      chunk: { id: "chunk-dup", start: 0, end: 3 },
      segments: [{ text: "texte identique", start: 1.1, end: 2 }],
    };
    const previous: any = { text: "texte identique", start: 0, end: 1 };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "normal" });
    expect(out).toHaveLength(0);
  });

  it("derives confidence from word confidences in silence mode", () => {
    const result: any = {
      chunk: { id: "chunk-words-conf", start: 0, end: 4 },
      segments: [
        {
          text: "mot un deux",
          start: 1,
          end: 3,
          words: [
            { word: "mot", start: 1, end: 1.5, confidence: 0.5 },
            { word: "un", start: 1.5, end: 2.2, confidence: 0.75 },
            { word: "deux", start: 2.2, end: 3, confidence: 0.9 },
          ],
        },
      ],
    };
    const out = normaliseSegments(result, "silence", 2);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidenceSource).toBe("model");
    expect(out[0]?.confidence).toBeGreaterThan(0.6);
  });

  it("keeps provided numeric segment confidence as model confidence", () => {
    const result: any = {
      chunk: { id: "chunk-model-conf", start: 0, end: 2 },
      segments: [{ text: "segment", start: 0, end: 1.5, confidence: 0.33 }],
    };
    const out = normaliseSegments(result, "silence", 0);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBe(0.33);
    expect(out[0]?.confidenceSource).toBe("model");
  });

  it("trims overlapped tokens in silence mode and updates start from remaining words", () => {
    const result: any = {
      chunk: { id: "chunk-words-trim", start: 0, end: 4 },
      segments: [
        {
          text: "bonjour monde ensuite",
          start: 1,
          end: 3,
          words: [
            { word: "bonjour", start: 1.0, end: 1.2, confidence: 0.5 },
            { word: "monde", start: 1.2, end: 1.6, confidence: 0.6 },
            { word: "ensuite", start: 1.6, end: 2.2, confidence: 0.7 },
          ],
        },
      ],
    };
    const previous: any = { text: "salut bonjour monde", start: 0, end: 0.8 };
    const out = normaliseSegments(result, "silence", 0, previous, { dedupeMode: "normal" });
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("ensuite");
    expect(out[0]?.start).toBe(1.6);
    expect(out[0]?.words?.length).toBe(1);
  });

  it("produces debug confidence details when enabled", () => {
    useAsrStore.setState({ debugConfidence: true } as any);
    const result: any = {
      chunk: { id: "chunk-debug", start: 0, end: 2 },
      segments: [{ text: "texte sans confidence", start: 0, end: 1.5 }],
    };
    const out = normaliseSegments(result, "silence", 0);
    expect(out).toHaveLength(1);
    expect(out[0]?.confidenceSource).toBe("estimated");
  });
});
