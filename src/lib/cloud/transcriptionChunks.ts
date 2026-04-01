import type { TranscriptionSegment } from "@/lib/export";

export interface CloudTranscriptionChunkGroup {
  chunkId: string;
  chunkIndex: number;
  label: string;
  start: number;
  end: number;
  duration: number;
  segmentCount: number;
  speakerIds: string[];
  textSample: string;
}

const TEXT_SAMPLE_LIMIT = 120;

export function buildCloudTranscriptionChunkGroup(
  segments: readonly TranscriptionSegment[],
  chunkIndex: number,
  chunkId?: string
): CloudTranscriptionChunkGroup {
  const normalizedChunkId = normalizeChunkId(chunkId) ?? normalizeChunkId(segments[0]?.chunkId) ?? `__chunk-${chunkIndex}`;
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  const speakerIds: string[] = [];

  for (const segment of segments) {
    start = Math.min(start, segment.start);
    end = Math.max(end, segment.end);
    const speakerId = normalizeSpeakerId(segment.speaker);
    if (speakerId && !speakerIds.includes(speakerId)) {
      speakerIds.push(speakerId);
    }
  }

  return {
    chunkId: normalizedChunkId,
    chunkIndex,
    label: `Partie ${chunkIndex + 1}`,
    start: Number.isFinite(start) ? start : 0,
    end,
    duration: Math.max(0, end - (Number.isFinite(start) ? start : 0)),
    segmentCount: segments.length,
    speakerIds,
    textSample: buildCloudChunkTextSample(segments),
  };
}

export function mergeCloudTranscriptionChunkGroup(
  current: CloudTranscriptionChunkGroup | null | undefined,
  nextSegments: readonly TranscriptionSegment[],
  chunkIndex?: number,
  chunkId?: string
): CloudTranscriptionChunkGroup {
  const nextGroup = buildCloudTranscriptionChunkGroup(nextSegments, chunkIndex ?? current?.chunkIndex ?? 0, chunkId ?? current?.chunkId);
  if (!current) {
    return nextGroup;
  }

  const start = Math.min(current.start, nextGroup.start);
  const end = Math.max(current.end, nextGroup.end);

  return {
    ...current,
    chunkId: nextGroup.chunkId,
    chunkIndex: typeof chunkIndex === "number" ? chunkIndex : current.chunkIndex,
    label: typeof chunkIndex === "number" ? `Partie ${chunkIndex + 1}` : current.label,
    start,
    end,
    duration: Math.max(0, end - start),
    segmentCount: current.segmentCount + nextGroup.segmentCount,
    speakerIds: mergeUniqueStrings(current.speakerIds, nextGroup.speakerIds),
    textSample: mergeCloudChunkTextSample(current.textSample, nextSegments),
  };
}

export function groupCloudTranscriptionSegments(
  segments: readonly TranscriptionSegment[]
): CloudTranscriptionChunkGroup[] {
  const groups = new Map<
    string,
    {
      chunkId: string;
      start: number;
      end: number;
      segments: TranscriptionSegment[];
      speakerIds: string[];
      firstSeenIndex: number;
    }
  >();
  let firstSeenIndex = 0;

  for (const segment of segments) {
    const chunkId = normalizeChunkId(segment.chunkId) ?? `__chunk-${segment.index}`;
    let group = groups.get(chunkId);
    if (!group) {
      group = {
        chunkId,
        start: segment.start,
        end: segment.end,
        segments: [],
        speakerIds: [],
        firstSeenIndex,
      };
      groups.set(chunkId, group);
      firstSeenIndex += 1;
    }

    group.start = Math.min(group.start, segment.start);
    group.end = Math.max(group.end, segment.end);
    group.segments.push(segment);

    const speakerId = normalizeSpeakerId(segment.speaker);
    if (speakerId && !group.speakerIds.includes(speakerId)) {
      group.speakerIds.push(speakerId);
    }
  }

  return [...groups.values()]
    .sort((left, right) => left.start - right.start || left.firstSeenIndex - right.firstSeenIndex)
    .map((group, chunkIndex) => buildCloudTranscriptionChunkGroup(group.segments, chunkIndex, group.chunkId));
}

export function buildCloudChunkTextSample(segments: readonly TranscriptionSegment[]): string {
  const pieces: string[] = [];

  for (const segment of segments) {
    const text = normalizeText(segment.text);
    if (!text) continue;
    pieces.push(text);
    if (pieces.join(" ").length >= TEXT_SAMPLE_LIMIT) {
      break;
    }
  }

  return normalizeSampleText(pieces.join(" "));
}

export function mergeCloudChunkTextSample(previousSample: string, nextSegments: readonly TranscriptionSegment[]): string {
  const nextSample = buildCloudChunkTextSample(nextSegments);
  if (!previousSample) {
    return nextSample;
  }
  if (!nextSample) {
    return previousSample;
  }

  const merged = normalizeSampleText(`${previousSample} ${nextSample}`);
  if (merged.length <= TEXT_SAMPLE_LIMIT) {
    return merged;
  }
  return `${merged.slice(0, TEXT_SAMPLE_LIMIT - 3).trimEnd()}...`;
}

export function formatCloudChunkTimeRange(start: number, end: number): string {
  return `${formatCloudChunkTime(start)} - ${formatCloudChunkTime(end)}`;
}

function normalizeChunkId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeSpeakerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeSampleText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function mergeUniqueStrings(left: string[], right: string[]): string[] {
  const merged: string[] = [];
  for (const value of [...left, ...right]) {
    if (merged.includes(value)) continue;
    merged.push(value);
  }
  return merged;
}

function formatCloudChunkTime(seconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hrs > 0) {
    return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  }
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
