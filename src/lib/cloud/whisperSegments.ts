import type { AutomaticSpeechRecognitionOutput } from "@huggingface/tasks";
import type { TranscriptionSegment } from "@/lib/export";

export type WhisperSegmentOptions = {
  offsetSec: number;
  startIndex: number;
  chunkId: string;
  fallbackDurationSec: number;
};

type WhisperChunk = {
  text?: unknown;
  timestamp?: unknown;
};

const toFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const normalizeText = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

export function parseWhisperOutput(
  output: AutomaticSpeechRecognitionOutput | unknown,
  options: WhisperSegmentOptions
): TranscriptionSegment[] {
  const base = output && typeof output === "object" ? (output as AutomaticSpeechRecognitionOutput) : null;
  const chunks = Array.isArray(base?.chunks) ? (base?.chunks as WhisperChunk[]) : [];
  const segments: TranscriptionSegment[] = [];
  let index = options.startIndex;

  for (const chunk of chunks) {
    const text = normalizeText(chunk?.text);
    if (!text) continue;
    const stamp = Array.isArray(chunk?.timestamp) ? (chunk?.timestamp as unknown[]) : [];
    const rawStart = toFiniteNumber(stamp[0]) ?? 0;
    const rawEnd = toFiniteNumber(stamp[1]) ?? Math.max(rawStart, options.fallbackDurationSec);
    const start = options.offsetSec + Math.max(0, rawStart);
    const end = options.offsetSec + Math.max(rawEnd, rawStart);
    segments.push({
      index,
      start,
      end,
      text,
      chunkId: options.chunkId,
      strategy: "chunks",
    });
    index += 1;
  }

  if (!segments.length) {
    const text = normalizeText(base?.text);
    if (text) {
      const duration = Math.max(0, options.fallbackDurationSec);
      segments.push({
        index,
        start: options.offsetSec,
        end: options.offsetSec + duration,
        text,
        chunkId: options.chunkId,
        strategy: "chunks",
      });
    }
  }

  return segments;
}
