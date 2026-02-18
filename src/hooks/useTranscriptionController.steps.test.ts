import { describe, expect, it } from "vitest";

import {
  accumulateConfidenceFromSegments,
  clamp01,
  isRunInvalidated,
  resolveOverallConfidence,
  resolveMemoryModeForDuration,
  shouldEmitThrottledUpdate,
  shouldStopRun,
  trimChunkOverlap,
  trimDebrisPrefix,
} from "@/hooks/useTranscriptionController.steps";

describe("useTranscriptionController.steps", () => {
  it("clamps values between 0 and 1", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(42)).toBe(1);
  });

  it("detects run invalidation", () => {
    expect(isRunInvalidated(1, 2)).toBe(true);
    expect(isRunInvalidated(2, 2)).toBe(false);
  });

  it("stops run when stopRequested is true or runId mismatch", () => {
    expect(shouldStopRun({ runId: 1, currentRunId: 2, stopRequested: false })).toBe(true);
    expect(shouldStopRun({ runId: 2, currentRunId: 2, stopRequested: true })).toBe(true);
    expect(shouldStopRun({ runId: 2, currentRunId: 2, stopRequested: false })).toBe(false);
  });

  it("switches to progressive mode when duration exceeds threshold", () => {
    expect(
      resolveMemoryModeForDuration({
        durationSec: 1000,
        requestedMode: "full",
        thresholdSec: 900,
      })
    ).toEqual({
      mode: "progressive",
      switched: true,
      thresholdSec: 900,
    });
  });

  it("keeps requested mode when below threshold", () => {
    expect(
      resolveMemoryModeForDuration({
        durationSec: 300,
        requestedMode: "progressive",
        thresholdSec: 900,
      })
    ).toEqual({
      mode: "progressive",
      switched: false,
      thresholdSec: 900,
    });
  });

  it("accumulates weighted confidence by segment duration", () => {
    const result = accumulateConfidenceFromSegments(
      { totalDur: 0, weightedSum: 0, modelDur: 0, estimatedDur: 0 },
      [
        { start: 0, end: 2, confidence: 0.8, confidenceSource: "model" },
        { start: 2, end: 5, confidence: 0.5, confidenceSource: "estimated" },
        { start: 5, end: 5, confidence: 0.2, confidenceSource: "model" },
      ]
    );

    expect(result.totalDur).toBeCloseTo(5.001, 3);
    expect(result.weightedSum).toBeCloseTo(3.1002, 3);
    expect(result.modelDur).toBeCloseTo(2.001, 3);
    expect(result.estimatedDur).toBe(3);
  });

  it("resolves overall confidence from accumulator or fallback text", () => {
    const fromAccumulator = resolveOverallConfidence({
      accumulator: { totalDur: 10, weightedSum: 7, modelDur: 3, estimatedDur: 7 },
      estimateFromText: () => 0.1,
    });
    expect(fromAccumulator).toEqual({ overall: 0.7, source: "estimated" });

    const fromFallback = resolveOverallConfidence({
      accumulator: { totalDur: 0, weightedSum: 0, modelDur: 0, estimatedDur: 0 },
      fallbackText: "bonjour",
      fallbackDurationSec: 2,
      estimateFromText: () => 0.42,
    });
    expect(fromFallback).toEqual({ overall: 0.42, source: "estimated" });

    const empty = resolveOverallConfidence({
      accumulator: { totalDur: 0, weightedSum: 0, modelDur: 0, estimatedDur: 0 },
      fallbackText: "",
      estimateFromText: () => 0.9,
    });
    expect(empty).toEqual({ overall: null, source: null });
  });

  it("emits throttled updates only when forced, clamped edge, or interval elapsed", () => {
    expect(
      shouldEmitThrottledUpdate({
        now: 1000,
        lastTimestamp: 990,
        value: 0.5,
        throttleMs: 50,
      })
    ).toBe(false);
    expect(
      shouldEmitThrottledUpdate({
        now: 1060,
        lastTimestamp: 990,
        value: 0.5,
        throttleMs: 50,
      })
    ).toBe(true);
    expect(
      shouldEmitThrottledUpdate({
        now: 1000,
        lastTimestamp: 999,
        value: 1,
        throttleMs: 50,
      })
    ).toBe(true);
    expect(
      shouldEmitThrottledUpdate({
        now: 1000,
        lastTimestamp: 999,
        value: 0.5,
        throttleMs: 50,
        force: true,
      })
    ).toBe(true);
  });

  it("handles exact overlap edge cases and no-overlap fallback", () => {
    expect(trimChunkOverlap("bonjour", "", "exact")).toEqual({
      text: "",
      overlapWords: 0,
      removedTokens: 0,
    });
    expect(trimChunkOverlap(undefined, "bonjour", "exact")).toEqual({
      text: "bonjour",
      overlapWords: 0,
      removedTokens: 0,
    });
    expect(trimChunkOverlap("   ", "bonjour", "exact")).toEqual({
      text: "bonjour",
      overlapWords: 0,
      removedTokens: 0,
    });
    expect(trimChunkOverlap("meme texte", "meme texte", "exact")).toEqual({
      text: "",
      overlapWords: 2,
      removedTokens: 2,
    });
    expect(trimChunkOverlap("salut toi", "autre phrase", "exact")).toEqual({
      text: "autre phrase",
      overlapWords: 0,
      removedTokens: 0,
    });
  });

  it("handles fuzzy overlap edge cases", () => {
    expect(trimChunkOverlap("bonjour", "", "fuzzy")).toEqual({
      text: "",
      overlapWords: 0,
      removedTokens: 0,
    });
    expect(trimChunkOverlap("   ", "bonjour", "fuzzy")).toEqual({
      text: "bonjour",
      overlapWords: 0,
      removedTokens: 0,
    });
    expect(trimChunkOverlap("meme texte", "meme texte", "fuzzy")).toEqual({
      text: "",
      overlapWords: 2,
      removedTokens: 2,
    });
  });

  it("trims debris prefix only when continuation heuristics are met", () => {
    expect(trimDebrisPrefix(undefined, "abc def ghi jkl")).toEqual({
      text: "abc def ghi jkl",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("Phrase complete.", "abc def ghi jkl")).toEqual({
      text: "abc def ghi jkl",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("Texte normal", "abc def ghi jkl")).toEqual({
      text: "abc def ghi jkl",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("texte d'", "abc def ghi")).toEqual({
      text: "abc def ghi",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("texte d'", "Paris est tres belle aujourd hui")).toEqual({
      text: "Paris est tres belle aujourd hui",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("texte d'", "est encore la suite complete")).toEqual({
      text: "est encore la suite complete",
      removedTokens: 0,
    });
    expect(trimDebrisPrefix("texte d'", "abc def ghi jkl mno")).toEqual({
      text: "jkl mno",
      removedTokens: 3,
    });
    expect(trimDebrisPrefix("texte qu'", "abc def ghi jkl mno")).toEqual({
      text: "jkl mno",
      removedTokens: 3,
    });
  });

  it("falls back when unicode normalization throws", () => {
    const originalNormalize = String.prototype.normalize;
    String.prototype.normalize = (() => {
      throw new Error("normalize unavailable");
    }) as typeof String.prototype.normalize;
    try {
      expect(trimChunkOverlap("salut monde entier", "monde entier encore", "exact")).toEqual({
        text: "encore",
        overlapWords: 2,
        removedTokens: 2,
      });
    } finally {
      String.prototype.normalize = originalNormalize;
    }
  });
});
