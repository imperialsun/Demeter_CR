import { beforeEach, describe, expect, it } from "vitest";
import { IDBKeyRange, indexedDB } from "fake-indexeddb";
import { clearAllSegments, deleteSegment, deleteSessionSegments, getSegment, putSegment } from "./segment-cache";

beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = indexedDB;
  (globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange;
  await clearAllSegments();
});

describe("segment-cache", () => {
  it("stores and retrieves a segment", async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
    await putSegment({
      key: "session-1:0",
      sessionId: "session-1",
      index: 0,
      startSec: 0,
      endSec: 10,
      blob,
    });

    const stored = await getSegment("session-1", 0);
    expect(stored).not.toBeNull();
    expect(stored?.sessionId).toBe("session-1");
    expect(stored?.index).toBe(0);
  });

  it("deletes a segment by key", async () => {
    const blob = new Blob([new Uint8Array([4])], { type: "audio/webm;codecs=opus" });
    await putSegment({
      key: "session-2:1",
      sessionId: "session-2",
      index: 1,
      startSec: 10,
      endSec: 20,
      blob,
    });

    await deleteSegment("session-2", 1);
    const stored = await getSegment("session-2", 1);
    expect(stored).toBeNull();
  });

  it("deletes all segments for a session", async () => {
    const blob = new Blob([new Uint8Array([5])], { type: "audio/webm;codecs=opus" });
    await putSegment({
      key: "session-3:0",
      sessionId: "session-3",
      index: 0,
      startSec: 0,
      endSec: 10,
      blob,
    });
    await putSegment({
      key: "session-3:1",
      sessionId: "session-3",
      index: 1,
      startSec: 10,
      endSec: 20,
      blob,
    });

    await deleteSessionSegments("session-3");
    const stored0 = await getSegment("session-3", 0);
    const stored1 = await getSegment("session-3", 1);
    expect(stored0).toBeNull();
    expect(stored1).toBeNull();
  });
});
