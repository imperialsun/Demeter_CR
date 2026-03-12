import { describe, expect, it } from "vitest";
import {
  DEFAULT_MISTRAL_SEGMENT_DURATION_SEC,
  resolveMistralSegmentDurationSec,
} from "./mistralParams";

describe("resolveMistralSegmentDurationSec", () => {
  it("uses 15 minutes for voxtral mini models", () => {
    expect(resolveMistralSegmentDurationSec("voxtral-mini-latest")).toBe(900);
    expect(resolveMistralSegmentDurationSec("voxtral-mini-2507")).toBe(900);
    expect(resolveMistralSegmentDurationSec("Voxtral-Mini-Transcribe-26-02")).toBe(900);
  });

  it("keeps a conservative default for unknown models", () => {
    expect(resolveMistralSegmentDurationSec("mistral-small-latest")).toBe(DEFAULT_MISTRAL_SEGMENT_DURATION_SEC);
    expect(resolveMistralSegmentDurationSec("   ")).toBe(DEFAULT_MISTRAL_SEGMENT_DURATION_SEC);
  });
});
