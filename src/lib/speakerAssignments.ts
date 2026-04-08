import type { TranscriptionSegment } from "@/lib/export";

export interface SpeakerAssignment {
  firstName: string;
  lastName: string;
}

export type SpeakerAssignmentMap = Record<string, SpeakerAssignment>;
export type SpeakerAssignmentMode = "upload" | "mic" | "cloud";

export interface SpeakerAssignmentEntry {
  assignmentKey: string;
  chunkId: string;
  chunkLabel: string;
  speakerId: string;
  start: number;
  end: number;
}

export function buildSpeakerAssignmentKey(
  segment: Pick<TranscriptionSegment, "chunkId" | "speaker">,
  mode: SpeakerAssignmentMode
): string | undefined {
  const speakerId = normalizeSpeakerId(segment.speaker);
  if (!speakerId) return undefined;
  if (mode !== "cloud") return speakerId;

  const chunkId = normalizeChunkId(segment.chunkId);
  if (!chunkId) return speakerId;
  return `${chunkId}::${speakerId}`;
}

export function collectSpeakerAssignmentEntries(
  segments: TranscriptionSegment[],
  mode: SpeakerAssignmentMode
): SpeakerAssignmentEntry[] {
  const entries: SpeakerAssignmentEntry[] = [];
  const seen = new Set<string>();
  const chunkMetaById = new Map<string, { label: string; start: number; end: number }>();

  for (const segment of segments) {
    let chunkId = "";
    let chunkLabel = "";
    let start = segment.start;
    let end = segment.end;

    if (mode === "cloud") {
      chunkId = normalizeChunkId(segment.chunkId) ?? "chunk";
      const existingChunkMeta = chunkMetaById.get(chunkId);
      if (existingChunkMeta) {
        existingChunkMeta.start = Math.min(existingChunkMeta.start, segment.start);
        existingChunkMeta.end = Math.max(existingChunkMeta.end, segment.end);
        chunkLabel = existingChunkMeta.label;
        start = existingChunkMeta.start;
        end = existingChunkMeta.end;
      } else {
        const nextChunkMeta = {
          label: `Chunk ${chunkMetaById.size + 1}`,
          start: segment.start,
          end: segment.end,
        };
        chunkMetaById.set(chunkId, nextChunkMeta);
        chunkLabel = nextChunkMeta.label;
      }
    }

    const speakerId = normalizeSpeakerId(segment.speaker);
    if (!speakerId) continue;

    const assignmentKey = buildSpeakerAssignmentKey(segment, mode);
    if (!assignmentKey || seen.has(assignmentKey)) continue;

    seen.add(assignmentKey);
    entries.push({
      assignmentKey,
      chunkId,
      chunkLabel,
      speakerId,
      start,
      end,
    });
  }

  if (mode !== "cloud") {
    return entries;
  }

  return entries.map((entry) => {
    const chunkMeta = chunkMetaById.get(entry.chunkId);
    if (!chunkMeta) return entry;
    return {
      ...entry,
      chunkLabel: chunkMeta.label,
      start: chunkMeta.start,
      end: chunkMeta.end,
    };
  });
}

export function collectSpeakerIds(segments: TranscriptionSegment[]): string[] {
  return collectSpeakerAssignmentEntries(segments, "upload").map((entry) => entry.speakerId);
}

export function resolveSpeakerAssignment(
  segment: Pick<TranscriptionSegment, "chunkId" | "speaker" | "speakerLabel">,
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): SpeakerAssignment | undefined {
  const assignmentKey = buildSpeakerAssignmentKey(segment, mode);
  if (!assignmentKey) return undefined;
  return assignmentMap[assignmentKey];
}

export function resolveSegmentSpeakerLabel(
  segment: Pick<TranscriptionSegment, "chunkId" | "speaker" | "speakerLabel">,
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): string | undefined {
  return resolveSegmentSpeakerDisplay(segment, assignmentMap, mode);
}

export function applySpeakerAssignments(
  segments: TranscriptionSegment[],
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): TranscriptionSegment[] {
  return segments.map((segment) => {
    const speaker = resolveSegmentSpeakerDisplay(segment, assignmentMap, mode);
    return {
      ...segment,
      speaker,
      speakerLabel: speaker,
    };
  });
}

export function decorateSegmentsWithSpeakerLabels(
  segments: TranscriptionSegment[],
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): TranscriptionSegment[] {
  return segments.map((segment) => ({
    ...segment,
    speakerLabel: resolveSpeakerLabel(
      segment.speaker,
      resolveSpeakerAssignment(segment, assignmentMap, mode)
    ),
  }));
}

export function buildSpeakerAwareTranscriptText(
  segments: Pick<TranscriptionSegment, "chunkId" | "speaker" | "speakerLabel" | "text">[],
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): string {
  return segments
    .map((segment) => {
      const text = segment.text.trim();
      if (!text) return "";

      const speaker = resolveSegmentSpeakerDisplay(segment, assignmentMap, mode);
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

export function formatAssignedSpeakerName(assignment: SpeakerAssignment): string {
  const lastName = assignment.lastName.trim();
  const firstName = assignment.firstName.trim();
  if (lastName && firstName) return `${lastName} ${firstName}`;
  return lastName || firstName;
}

export function resolveSpeakerLabel(
  rawSpeaker: string | undefined,
  assignment: SpeakerAssignment | undefined
): string | undefined {
  const normalizedRawSpeaker = normalizeSpeakerId(rawSpeaker);
  if (!normalizedRawSpeaker) return undefined;
  if (!assignment) return normalizedRawSpeaker;

  const assignedLabel = formatAssignedSpeakerName(assignment);
  return assignedLabel || normalizedRawSpeaker;
}

export function resolveSegmentSpeakerDisplay(
  segment: Pick<TranscriptionSegment, "chunkId" | "speaker" | "speakerLabel">,
  assignmentMap: SpeakerAssignmentMap,
  mode: SpeakerAssignmentMode
): string | undefined {
  const cachedLabel = normalizeSpeakerId(segment.speakerLabel);
  if (cachedLabel) return cachedLabel;

  return resolveSpeakerLabel(segment.speaker, resolveSpeakerAssignment(segment, assignmentMap, mode));
}

function normalizeSpeakerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeChunkId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
