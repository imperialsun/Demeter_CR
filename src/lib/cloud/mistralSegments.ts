import type { TranscriptionSegment, WordSegment } from "@/lib/export";
import type { MistralTranscriptionResponse } from "@/lib/cloud/mistralClient";

export type MistralSegmentOptions = {
  offsetSec: number;
  startIndex: number;
  chunkId: string;
  fallbackDurationSec: number;
  includeWordTimestamps: boolean;
};

type RawSegment = {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
  words?: unknown;
};

type RawWord = {
  word?: unknown;
  text?: unknown;
  start?: unknown;
  end?: unknown;
  confidence?: unknown;
};

const asFiniteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const asText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function mapWords(raw: unknown, offsetSec: number): WordSegment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const words: WordSegment[] = [];
  for (const item of raw) {
    const word = asText((item as RawWord)?.word ?? (item as RawWord)?.text);
    if (!word) continue;
    const start = asFiniteNumber((item as RawWord)?.start) ?? 0;
    const end = asFiniteNumber((item as RawWord)?.end) ?? start;
    const confidence = asFiniteNumber((item as RawWord)?.confidence) ?? undefined;
    words.push({
      word,
      start: Math.max(0, offsetSec + start),
      end: Math.max(0, offsetSec + end),
      confidence,
    });
  }
  return words.length ? words : undefined;
}

export function parseMistralOutput(
  output: MistralTranscriptionResponse | unknown,
  options: MistralSegmentOptions
): TranscriptionSegment[] {
  const payload = output && typeof output === "object" ? (output as MistralTranscriptionResponse) : null;
  const rawSegments = Array.isArray(payload?.segments)
    ? (payload?.segments as RawSegment[])
    : Array.isArray(payload?.chunks)
      ? (payload?.chunks as RawSegment[])
      : [];

  const segments: TranscriptionSegment[] = [];
  let index = options.startIndex;
  for (const item of rawSegments) {
    const text = asText(item?.text);
    if (!text) continue;
    const rawStart = asFiniteNumber(item?.start) ?? 0;
    const rawEnd = asFiniteNumber(item?.end) ?? Math.max(rawStart, options.fallbackDurationSec);
    const confidence = asFiniteNumber(item?.confidence) ?? undefined;
    const words = options.includeWordTimestamps ? mapWords(item?.words, options.offsetSec) : undefined;
    segments.push({
      index,
      start: Math.max(0, options.offsetSec + rawStart),
      end: Math.max(0, options.offsetSec + Math.max(rawEnd, rawStart)),
      text,
      chunkId: options.chunkId,
      strategy: "chunks",
      confidence,
      confidenceSource: typeof confidence === "number" ? "model" : undefined,
      words,
    });
    index += 1;
  }

  if (!segments.length) {
    const fallbackText = asText(payload?.text);
    if (fallbackText) {
      segments.push({
        index,
        start: options.offsetSec,
        end: options.offsetSec + Math.max(0, options.fallbackDurationSec),
        text: fallbackText,
        chunkId: options.chunkId,
        strategy: "chunks",
      });
    }
  }

  return segments;
}

