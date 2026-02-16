import { describe, expect, it } from "vitest";
import { parseVttToSegments } from "./parseVtt";

describe("parseVttToSegments", () => {
  it("parses standard vtt cues", () => {
    const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:01.200
Bonjour le monde

2
00:00:02.500 --> 00:00:03.000 align:start
Test`;

    const segments = parseVttToSegments(vtt);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.text).toBe("Bonjour le monde");
    expect(segments[0]?.start).toBeCloseTo(0, 3);
    expect(segments[0]?.end).toBeCloseTo(1.2, 3);
    expect(segments[1]?.text).toBe("Test");
    expect(segments[1]?.start).toBeCloseTo(2.5, 3);
  });

  it("ignores NOTE/STYLE/REGION blocks", () => {
    const vtt = `WEBVTT

NOTE source metadata
foo bar

STYLE
::cue { color: lime; }

REGION
id:r0

00:00:01.000 --> 00:00:02.000
Hello`;

    const segments = parseVttToSegments(vtt);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("Hello");
  });
});
