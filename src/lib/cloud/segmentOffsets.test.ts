import { describe, it, expect } from "vitest";
import { offsetSegments } from "./segmentOffsets";

describe("offsetSegments", () => {
  it("offsets times and indices and prefixes chunkId", () => {
    const result = offsetSegments(
      [
        { index: 0, start: 0, end: 1, text: "A", chunkId: "c0", strategy: "chunks" },
        { index: 1, start: 1, end: 2, text: "B", chunkId: "c1", strategy: "chunks" },
      ],
      60,
      10,
      "batch-2"
    );
    expect(result[0]?.index).toBe(10);
    expect(result[0]?.start).toBe(60);
    expect(result[1]?.end).toBe(62);
    expect(result[0]?.chunkId).toBe("batch-2-c0");
  });
});
