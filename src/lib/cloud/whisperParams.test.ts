import { describe, expect, it } from "vitest";
import { buildWhisperParameters } from "./whisperParams";

describe("buildWhisperParameters", () => {
  it("builds generation parameters with timestamps", () => {
    const params = buildWhisperParameters({
      maxTokens: 2048,
      temperature: 0.4,
      topP: 0.9,
      doSample: true,
      returnTimestamps: true,
    });

    expect(params.return_timestamps).toBe(true);
    expect(params.generation_parameters).toEqual({
      max_new_tokens: 2048,
      temperature: 0.4,
      top_p: 0.9,
      do_sample: true,
    });
  });

  it("omits return_timestamps when disabled", () => {
    const params = buildWhisperParameters({
      maxTokens: 512,
      temperature: 0,
      topP: 1,
      doSample: false,
      returnTimestamps: false,
    });

    expect(params.return_timestamps).toBeUndefined();
    expect(params.generation_parameters?.max_new_tokens).toBe(512);
  });
});
