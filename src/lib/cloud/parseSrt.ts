import type { TranscriptionSegment } from "@/lib/export";
import logger from "@/lib/logger";

const TIME_SEPARATOR = "-->";

type ParseSrtOptions = {
  strategy?: "chunks" | "silence";
  chunkIdPrefix?: string;
};

export function parseSrtToSegments(srt: string, options: ParseSrtOptions = {}): TranscriptionSegment[] {
  if (!srt || typeof srt !== "string") return [];
  const normalized = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const segments: TranscriptionSegment[] = [];
  const strategy = options.strategy ?? "chunks";
  const chunkPrefix = options.chunkIdPrefix ?? "cloud";

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const timeIndex = lines.findIndex((line) => line.includes(TIME_SEPARATOR));
    if (timeIndex === -1) {
      continue;
    }
    const timeLine = lines[timeIndex] ?? "";
    const [rawStart, rawEnd] = timeLine.split(TIME_SEPARATOR).map((part) => part.trim());
    const start = parseTimestamp(rawStart);
    const end = parseTimestamp(rawEnd);
    if (typeof start !== "number" || typeof end !== "number") {
      logger.warn("[cloud][srt] invalid timestamps", { timeLine });
      continue;
    }
    const text = lines.slice(timeIndex + 1).join("\n").trim();
    const index = segments.length;
    segments.push({
      index,
      start,
      end,
      text,
      chunkId: `${chunkPrefix}-${index}`,
      strategy,
    });
  }

  return segments;
}

function parseTimestamp(value: string): number | null {
  const match = value.match(/(\d{2}):(\d{2}):(\d{2})([.,](\d{1,3}))?/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const msRaw = match[5] ?? "0";
  const ms = Number(msRaw.padEnd(3, "0"));
  if (![hours, minutes, seconds, ms].every((n) => Number.isFinite(n))) return null;
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}
