import { describe, it, expect } from "vitest";
import { parseSrtToSegments } from "./parseSrt";

describe("parseSrtToSegments", () => {
  it("parses standard SRT blocks", () => {
    const srt = `1
00:00:00,000 --> 00:00:01,200
Bonjour le monde

2
00:00:02,500 --> 00:00:03,000
Test`;
    const segments = parseSrtToSegments(srt);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe("Bonjour le monde");
    expect(segments[0]?.start).toBeCloseTo(0, 3);
    expect(segments[0]?.end).toBeCloseTo(1.2, 3);
    expect(segments[1]?.text).toBe("Test");
    expect(segments[1]?.start).toBeCloseTo(2.5, 3);
  });

  it("ignores non-timestamp blocks", () => {
    const srt = `NOTE SETTINGS
{"foo":"bar"}

1
00:00:00.000 --> 00:00:00.500
Hello`;
    const segments = parseSrtToSegments(srt);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("Hello");
  });
});
