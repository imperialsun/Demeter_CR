import type { TranscriptionSegment } from "@/lib/export";

export interface SpeakerAssignment {
  firstName: string;
  lastName: string;
}

export type SpeakerAssignmentMap = Record<string, SpeakerAssignment>;

export function collectSpeakerIds(segments: TranscriptionSegment[]): string[] {
  const orderedSpeakerIds: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    const speakerId = normalizeSpeakerId(segment.speaker);
    if (!speakerId || seen.has(speakerId)) continue;
    seen.add(speakerId);
    orderedSpeakerIds.push(speakerId);
  }

  return orderedSpeakerIds;
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

export function applySpeakerAssignments(
  segments: TranscriptionSegment[],
  assignmentMap: SpeakerAssignmentMap
): TranscriptionSegment[] {
  return segments.map((segment) => {
    const rawSpeaker = normalizeSpeakerId(segment.speaker);
    if (!rawSpeaker) {
      return {
        ...segment,
        speaker: undefined,
      };
    }

    return {
      ...segment,
      speaker: resolveSpeakerLabel(rawSpeaker, assignmentMap[rawSpeaker]),
    };
  });
}

function normalizeSpeakerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
