import { describe, expect, it } from "vitest";
import {
  DEFAULT_MISTRAL_SEGMENT_DURATION_SEC,
  resolveMistralSegmentDurationSec,
} from "./mistralParams";

describe("resolveMistralSegmentDurationSec", () => {
  it("uses 30 minutes for voxtral mini transcribe models", () => {
    expect(resolveMistralSegmentDurationSec("voxtral-mini-transcribe-26-02")).toBe(1800);
    expect(resolveMistralSegmentDurationSec("Voxtral-Mini-Transcribe-26-02")).toBe(1800);
  });

  it("keeps a conservative default for unknown models", () => {
    expect(resolveMistralSegmentDurationSec("mistral-small-latest")).toBe(DEFAULT_MISTRAL_SEGMENT_DURATION_SEC);
    expect(resolveMistralSegmentDurationSec("   ")).toBe(DEFAULT_MISTRAL_SEGMENT_DURATION_SEC);
  });
});

