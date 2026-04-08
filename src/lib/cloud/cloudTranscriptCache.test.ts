import { beforeEach, describe, expect, it } from "vitest";
import { IDBKeyRange, indexedDB as fakeIndexedDB } from "fake-indexeddb";
import type { TranscriptionSegment } from "@/lib/export";
import {
  appendCloudTranscriptChunkSegments,
  clearAllCloudTranscriptCache,
  deleteCloudTranscriptSession,
  loadCloudTranscriptChunkSegments,
  loadCloudTranscriptChunkSummaries,
  loadCloudTranscriptChunkSummary,
  loadCloudTranscriptSegmentsForExport,
  updateCloudTranscriptSegment,
  replaceCloudTranscriptChunkSegments,
} from "./cloudTranscriptCache";

beforeEach(async () => {
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = fakeIndexedDB;
  (globalThis as unknown as { IDBKeyRange: typeof IDBKeyRange }).IDBKeyRange = IDBKeyRange;
  await clearAllCloudTranscriptCache();
});

function buildSegment(overrides: Partial<TranscriptionSegment> & Pick<TranscriptionSegment, "index" | "start" | "end" | "text" | "chunkId">): TranscriptionSegment {
  return {
    strategy: "chunks",
    ...overrides,
  } as TranscriptionSegment;
}

describe("cloudTranscriptCache", () => {
  it("stores chunk summaries and reads chunk segments on demand", async () => {
    const sessionId = "session-1";
    const chunkId = "chunk-1";

    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId,
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 0,
          start: 0,
          end: 4,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId,
        }),
      ],
    });

    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId,
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 1,
          start: 4,
          end: 8,
          text: "tout le monde",
          speaker: "SPEAKER_01",
          chunkId,
        }),
      ],
    });

    const summary = await loadCloudTranscriptChunkSummary(sessionId, chunkId);
    const summaries = await loadCloudTranscriptChunkSummaries(sessionId);
    const segments = await loadCloudTranscriptChunkSegments(sessionId, chunkId);

    expect(summary).not.toBeNull();
    expect(summary?.segmentCount).toBe(2);
    expect(summary?.textSample).toContain("Bonjour");
    expect(summary?.textSample).toContain("tout le monde");
    expect(summary?.speakerIds).toEqual(["SPEAKER_00", "SPEAKER_01"]);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.chunkId).toBe(chunkId);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.index).toBe(0);
    expect(segments[1]?.index).toBe(1);
  });

  it("updates a chunk segment and refreshes the cached summary", async () => {
    const sessionId = "session-2";
    const chunkId = "chunk-2";

    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId,
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 0,
          start: 0,
          end: 3,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          chunkId,
        }),
        buildSegment({
          index: 1,
          start: 3,
          end: 6,
          text: "suite",
          speaker: "SPEAKER_01",
          chunkId,
        }),
      ],
    });

    const updateResult = await updateCloudTranscriptSegment(sessionId, chunkId, 1, (segment) => ({
      ...segment,
      text: "suite modifiée",
      speaker: "SPEAKER_02",
    }));

    const segments = await loadCloudTranscriptChunkSegments(sessionId, chunkId);
    const summary = await loadCloudTranscriptChunkSummary(sessionId, chunkId);

    expect(updateResult).not.toBeNull();
    expect(updateResult?.segmentCount).toBe(2);
    expect(segments[1]?.text).toBe("suite modifiée");
    expect(segments[1]?.speaker).toBe("SPEAKER_02");
    expect(summary?.textSample).toContain("suite modifiée");
    expect(summary?.speakerIds).toContain("SPEAKER_02");
  });

  it("preserves speaker labels when chunk segments are replaced", async () => {
    const sessionId = "session-2b";
    const chunkId = "chunk-2b";

    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId,
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 0,
          start: 0,
          end: 3,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          speakerLabel: "Dupont Alice",
          chunkId,
        }),
      ],
    });

    await replaceCloudTranscriptChunkSegments({
      sessionId,
      chunkId,
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 0,
          start: 0,
          end: 3,
          text: "Bonjour",
          speaker: "SPEAKER_00",
          speakerLabel: "Dupont Alice",
          chunkId,
        }),
      ],
    });

    const segments = await loadCloudTranscriptChunkSegments(sessionId, chunkId);
    expect(segments[0]?.speakerLabel).toBe("Dupont Alice");
  });

  it("exports segments in chunk order and deletes a whole session", async () => {
    const sessionId = "session-3";

    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId: "chunk-a",
      chunkIndex: 0,
      segments: [
        buildSegment({
          index: 0,
          start: 0,
          end: 2,
          text: "A1",
          chunkId: "chunk-a",
        }),
      ],
    });
    await appendCloudTranscriptChunkSegments({
      sessionId,
      chunkId: "chunk-b",
      chunkIndex: 1,
      segments: [
        buildSegment({
          index: 1,
          start: 2,
          end: 4,
          text: "B1",
          chunkId: "chunk-b",
        }),
      ],
    });

    const exportedBeforeDelete = await loadCloudTranscriptSegmentsForExport(sessionId);
    expect(exportedBeforeDelete).toHaveLength(2);
    expect(exportedBeforeDelete[0]?.chunkId).toBe("chunk-a");
    expect(exportedBeforeDelete[1]?.chunkId).toBe("chunk-b");

    await deleteCloudTranscriptSession(sessionId);

    const summariesAfterDelete = await loadCloudTranscriptChunkSummaries(sessionId);
    const exportedAfterDelete = await loadCloudTranscriptSegmentsForExport(sessionId);
    expect(summariesAfterDelete).toHaveLength(0);
    expect(exportedAfterDelete).toHaveLength(0);
  });
});
