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
  segments: TranscriptionSegment[];
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

export function getSessionTranscriptText(segments: Array<{ text?: string | null }>): string {
  return segments
    .map((segment) => segment.text?.trim())
    .filter((text): text is string => Boolean(text && text.length > 0))
    .join("\n");
}

export function hasSessionTranscriptContent(
  entry: SessionTranscriptMemoryEntry | null | undefined
): entry is SessionTranscriptMemoryEntry {
  return Boolean(entry && getSessionTranscriptText(entry.segments).length > 0);
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
    segments: [...args.segments],
    audioSource,
    audioMetadata: args.audioMetadata ?? null,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
  };
}
