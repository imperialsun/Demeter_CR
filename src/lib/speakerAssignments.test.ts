import { describe, expect, it } from "vitest";
import {
  applySpeakerAssignments,
  buildSpeakerAssignmentKey,
  buildSpeakerAwareTranscriptText,
  collectSpeakerAssignmentEntries,
} from "@/lib/speakerAssignments";

describe("speakerAssignments", () => {
  it("uses distinct assignment keys per chunk in cloud mode", () => {
    const segments = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        chunkId: "mistral-1",
        strategy: "chunks" as const,
      },
      {
        index: 1,
        start: 2,
        end: 3,
        text: "Salut",
        speaker: "SPEAKER_00",
        chunkId: "mistral-2",
        strategy: "chunks" as const,
      },
    ];

    expect(buildSpeakerAssignmentKey(segments[0], "cloud")).toBe("mistral-1::SPEAKER_00");
    expect(buildSpeakerAssignmentKey(segments[1], "cloud")).toBe("mistral-2::SPEAKER_00");

    const entries = collectSpeakerAssignmentEntries(segments, "cloud");
    expect(entries).toEqual([
      expect.objectContaining({
        assignmentKey: "mistral-1::SPEAKER_00",
        chunkId: "mistral-1",
        chunkLabel: "Chunk 1",
        speakerId: "SPEAKER_00",
      }),
      expect.objectContaining({
        assignmentKey: "mistral-2::SPEAKER_00",
        chunkId: "mistral-2",
        chunkLabel: "Chunk 2",
        speakerId: "SPEAKER_00",
      }),
    ]);
  });

  it("keeps a global speaker key outside cloud mode", () => {
    const segment = {
      index: 0,
      start: 0,
      end: 1,
      text: "Bonjour",
      speaker: "SPEAKER_00",
      chunkId: "chunk-1",
      strategy: "chunks" as const,
    };

    expect(buildSpeakerAssignmentKey(segment, "upload")).toBe("SPEAKER_00");
    expect(buildSpeakerAssignmentKey(segment, "mic")).toBe("SPEAKER_00");
  });

  it("applies cloud speaker assignments per chunk", () => {
    const segments = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        chunkId: "mistral-1",
        strategy: "chunks" as const,
      },
      {
        index: 1,
        start: 2,
        end: 3,
        text: "Salut",
        speaker: "SPEAKER_00",
        chunkId: "mistral-2",
        strategy: "chunks" as const,
      },
    ];

    const result = applySpeakerAssignments(
      segments,
      {
        "mistral-1::SPEAKER_00": {
          firstName: "Alice",
          lastName: "Dupont",
        },
      },
      "cloud"
    );

    expect(result[0]?.speaker).toBe("Dupont Alice");
    expect(result[1]?.speaker).toBe("SPEAKER_00");
  });

  it("prefers assigned cloud speaker names over cached raw labels", () => {
    const segments = [
      {
        index: 0,
        start: 0,
        end: 1,
        text: "Bonjour",
        speaker: "SPEAKER_00",
        speakerLabel: "SPEAKER_00",
        chunkId: "mistral-1",
        strategy: "chunks" as const,
      },
    ];

    const transcriptText = buildSpeakerAwareTranscriptText(
      segments,
      {
        "mistral-1::SPEAKER_00": {
          firstName: "Alice",
          lastName: "Dupont",
        },
      },
      "cloud"
    );

    expect(transcriptText).toBe("Dupont Alice: Bonjour");
  });
});
