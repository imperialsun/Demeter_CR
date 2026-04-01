import logger from "@/lib/logger";
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

export const SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY = "demeter-asr-session-transcript-memories";

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
  transcriptText?: string;
  segmentCount?: number;
  audioSource?: SessionSource | null;
  audioMetadata?: AudioMetadata | null;
  updatedAt?: string;
}): SessionTranscriptMemoryEntry {
  const audioSource = args.audioSource ?? null;
  const transcriptText = typeof args.transcriptText === "string" ? args.transcriptText : getSessionTranscriptText(args.segments);
  const segmentCount =
    typeof args.segmentCount === "number" && Number.isFinite(args.segmentCount) ? args.segmentCount : args.segments.length;
  return {
    mode: args.mode,
    provider: args.provider,
    label: buildSessionTranscriptMemoryLabel(args.provider, audioSource),
    transcriptText,
    segmentCount,
    audioSource,
    audioMetadata: args.audioMetadata ?? null,
    updatedAt: args.updatedAt ?? new Date().toISOString(),
  };
}

export function loadSessionTranscriptMemoriesFromSessionStorage():
  | Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null>
  | null {
  const storage = getSessionStorage();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const next = createEmptySessionTranscriptMemories();
    let hasAny = false;

    for (const mode of ["upload", "mic", "cloud"] as const) {
      const entry = normalizePersistedSessionTranscriptMemoryEntry((parsed as Record<string, unknown>)[mode], mode);
      if (!entry) {
        continue;
      }
      next[mode] = entry;
      hasAny = true;
    }

    return hasAny ? next : null;
  } catch (error) {
    logger.warn("[session-transcript-memory] impossible de lire le cache de transcription de session", error);
    return null;
  }
}

export function saveSessionTranscriptMemoriesToSessionStorage(
  memories: Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null>
) {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    if (!hasAnySessionTranscriptContent(memories)) {
      storage.removeItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY);
      return;
    }

    storage.setItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY, JSON.stringify(memories));
  } catch (error) {
    logger.warn("[session-transcript-memory] impossible de persister le cache de transcription de session", error);
  }
}

export function clearSessionTranscriptMemoriesFromSessionStorage() {
  const storage = getSessionStorage();
  if (!storage) {
    return;
  }

  try {
    storage.removeItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY);
  } catch (error) {
    logger.warn("[session-transcript-memory] impossible de nettoyer le cache de transcription de session", error);
  }
}

function hasAnySessionTranscriptContent(
  memories: Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null>
): boolean {
  return hasSessionTranscriptContent(memories.upload) || hasSessionTranscriptContent(memories.mic) || hasSessionTranscriptContent(memories.cloud);
}

function normalizePersistedSessionTranscriptMemoryEntry(
  value: unknown,
  mode: SessionTranscriptMode
): SessionTranscriptMemoryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const provider = isSessionTranscriptProvider(record.provider) ? record.provider : null;
  if (!provider) {
    return null;
  }

  const transcriptText = typeof record.transcriptText === "string" ? record.transcriptText : "";
  if (transcriptText.trim().length === 0) {
    return null;
  }

  const label = typeof record.label === "string" && record.label.trim().length > 0
    ? record.label.trim()
    : buildSessionTranscriptMemoryLabel(provider, normalizeSessionSource(record.audioSource));
  const segmentCount =
    typeof record.segmentCount === "number" && Number.isFinite(record.segmentCount)
      ? Math.max(0, Math.floor(record.segmentCount))
      : transcriptText
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .length;
  const audioSource = normalizeSessionSource(record.audioSource);
  const audioMetadata = normalizeAudioMetadata(record.audioMetadata);
  const updatedAt =
    typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0 ? record.updatedAt : new Date().toISOString();

  return {
    mode,
    provider,
    label,
    transcriptText,
    segmentCount,
    audioSource,
    audioMetadata,
    updatedAt,
  };
}

function isSessionTranscriptProvider(value: unknown): value is SessionTranscriptProvider {
  return (
    value === "upload" ||
    value === "mic" ||
    value === "whisper" ||
    value === "mistral" ||
    value === "demeter_sante"
  );
}

function normalizeSessionSource(value: unknown): SessionSource | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.label !== "string" ||
    (record.type !== "file" && record.type !== "mic")
  ) {
    return null;
  }

  return {
    id: record.id,
    label: record.label,
    type: record.type,
  };
}

function normalizeAudioMetadata(value: unknown): AudioMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as AudioMetadata;
}

function getSessionStorage(): Storage | null {
  try {
    if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
      return null;
    }
    return window.sessionStorage;
  } catch (error) {
    logger.warn("[session-transcript-memory] sessionStorage indisponible", error);
    return null;
  }
}
