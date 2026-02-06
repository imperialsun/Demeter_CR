import { describe, it, expect } from "vitest";
import { summarizeSegments } from "./segmentSummary";
import { estimateTokenCount } from "@/lib/tokens";

describe("summarizeSegments", () => {
  it("returns zero summary for empty list", () => {
    expect(summarizeSegments([])).toEqual({ count: 0, totalDurationSec: 0, textChars: 0, tokenCount: 0 });
  });

  it("summarizes count, duration, and samples", () => {
    const summary = summarizeSegments([
      { index: 0, start: 0, end: 1.2, text: "Bonjour", chunkId: "c0", strategy: "chunks" },
      { index: 1, start: 1.5, end: 3, text: "Le monde", chunkId: "c1", strategy: "chunks" },
    ]);
    expect(summary.count).toBe(2);
    expect(summary.totalDurationSec).toBeCloseTo(2.7, 3);
    expect(summary.textChars).toBe("Bonjour".length + "Le monde".length);
    expect(summary.tokenCount).toBe(estimateTokenCount("Bonjour") + estimateTokenCount("Le monde"));
    expect(summary.first?.chunkId).toBe("c0");
    expect(summary.last?.chunkId).toBe("c1");
  });

  it("truncates long text samples", () => {
    const longText = "a".repeat(120);
    const summary = summarizeSegments([
      { index: 0, start: 0, end: 2, text: longText, chunkId: "c0", strategy: "chunks" },
    ]);
    expect(summary.first?.textSample.endsWith("...")).toBe(true);
    expect(summary.first?.textSample.length).toBe(83);
  });
});
