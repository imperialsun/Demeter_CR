import type { AudioMetadata } from "@/lib/audio";
import type { TranscriptionSegment } from "@/lib/export";

export type SessionTranscriptMode = "upload" | "mic" | "cloud";
export type SessionTranscriptProvider = "upload" | "mic" | "whisper" | "mistral" | "demeter_sante";

export type SessionSource = {
  id: string;
  label: string;
  type: "file" | "mic";
};

export interface SessionTranscriptMemoryEntry {
  mode: SessionTranscriptMode;
  provider: SessionTranscriptProvider;
  label: string;
  transcriptText: string;
  segmentCount: number;
  audioSource: SessionSource | null;
  audioMetadata: AudioMetadata | null;
  updatedAt: string;
}

export function createEmptySessionTranscriptMemories(): Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null> {
  return {
    upload: null,
    mic: null,
    cloud: null,
  };
}

export function buildSessionTranscriptMemoryLabel(
  provider: SessionTranscriptProvider,
  audioSource?: SessionSource | null
): string {
  const sourceLabel = audioSource?.label?.trim() || "Fichier audio";

  switch (provider) {
    case "upload":
      return `Locale · ${sourceLabel}`;
    case "mic":
      return "Micro · Session micro";
    case "whisper":
      return `Cloud Whisper · ${sourceLabel}`;
    case "mistral":
      return `Cloud Mistral · ${sourceLabel}`;
    case "demeter_sante":
      return `Cloud Demeter Santé · ${sourceLabel}`;
    default:
      return sourceLabel;
  }
}

type SessionTranscriptTextSource =
  | Array<{ text?: string | null }>
  | {
      transcriptText?: string | null;
      segments?: Array<{ text?: string | null }> | null;
    }
  | null
  | undefined;

type SessionTranscriptCountSource =
  | Array<unknown>
  | {
      segmentCount?: number | null;
      segments?: Array<unknown> | null;
    }
  | null
  | undefined;

export function getSessionTranscriptText(source: SessionTranscriptTextSource): string {
  if (!source) {
    return "";
  }
  if (Array.isArray(source)) {
    return source
      .map((segment) => segment.text?.trim())
      .filter((text): text is string => Boolean(text && text.length > 0))
      .join("\n");
  }

  if (typeof source.transcriptText === "string") {
    return source.transcriptText;
  }

  if (Array.isArray(source.segments)) {
    return getSessionTranscriptText(source.segments);
  }

  return "";
}

export function getSessionTranscriptSegmentCount(source: SessionTranscriptCountSource): number {
  if (!source) {
    return 0;
  }
  if (Array.isArray(source)) {
    return source.length;
  }
  if (typeof source.segmentCount === "number" && Number.isFinite(source.segmentCount)) {
    return source.segmentCount;
  }
  if (Array.isArray(source.segments)) {
    return source.segments.length;
  }
  return 0;
}

export function hasSessionTranscriptContent(
  entry: SessionTranscriptMemoryEntry | null | undefined
): entry is SessionTranscriptMemoryEntry {
  return Boolean(entry && getSessionTranscriptText(entry).length > 0);
}

export function createSessionTranscriptMemoryEntry(args: {
  mode: SessionTranscriptMode;
  provider: SessionTranscriptProvider;
  segments: TranscriptionSegment[];
  audioSource?: SessionSource | null;
  audioMetadata?: AudioMetadata | null;
  updatedAt?: string;
}): SessionTranscriptMemoryEntry {
  const audioSource = args.audioSource ?? null;
  return {
    mode: args.mode,
    provider: args.provider,
    label: buildSessionTranscriptMemoryLabel(args.provider, audioSource),
    transcriptText: getSessionTranscriptText(args.segments),
    segmentCount: args.segments.length,
    audioSource,
    audioMetadata: args.audioMetadata ?? null,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
  };
}
