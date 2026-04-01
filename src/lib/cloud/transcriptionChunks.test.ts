import { describe, expect, it } from "vitest";
import { formatCloudChunkTimeRange, groupCloudTranscriptionSegments } from "@/lib/cloud/transcriptionChunks";

describe("groupCloudTranscriptionSegments", () => {
  it("groups segments by chunk id and sorts them chronologically", () => {
    const groups = groupCloudTranscriptionSegments([
      {
        index: 4,
        start: 12,
        end: 18,
        text: "Chunk B - segment 1",
        speaker: "SPEAKER_01",
        chunkId: "chunk-b",
        strategy: "chunks",
      },
      {
        index: 0,
        start: 0,
        end: 5,
        text: "Chunk A - segment 1",
        speaker: "SPEAKER_00",
        chunkId: "chunk-a",
        strategy: "chunks",
      },
      {
        index: 1,
        start: 5,
        end: 10,
        text: "Chunk A - segment 2",
        speaker: "SPEAKER_00",
        chunkId: "chunk-a",
        strategy: "chunks",
      },
      {
        index: 5,
        start: 18,
        end: 24,
        text: "Chunk B - segment 2",
        speaker: "SPEAKER_02",
        chunkId: "chunk-b",
        strategy: "chunks",
      },
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      chunkId: "chunk-a",
      chunkIndex: 0,
      label: "Partie 1",
      start: 0,
      end: 10,
      duration: 10,
      segmentCount: 2,
      speakerIds: ["SPEAKER_00"],
    });
    expect(groups[1]).toMatchObject({
      chunkId: "chunk-b",
      chunkIndex: 1,
      label: "Partie 2",
      start: 12,
      end: 24,
      duration: 12,
      segmentCount: 2,
      speakerIds: ["SPEAKER_01", "SPEAKER_02"],
    });
  });

  it("formats a readable time range", () => {
    expect(formatCloudChunkTimeRange(65, 125)).toBe("01:05 - 02:05");
  });
});
