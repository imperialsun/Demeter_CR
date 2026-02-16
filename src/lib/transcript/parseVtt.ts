import type { TranscriptionSegment } from "@/lib/export";

const TIME_SEPARATOR = "-->";

type ParseVttOptions = {
  strategy?: "chunks" | "silence";
  chunkIdPrefix?: string;
};

export function parseVttToSegments(vtt: string, options: ParseVttOptions = {}): TranscriptionSegment[] {
  if (!vtt || typeof vtt !== "string") return [];
  const normalized = normalizeText(vtt);
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const strategy = options.strategy ?? "chunks";
  const chunkPrefix = options.chunkIdPrefix ?? "vtt";
  const segments: TranscriptionSegment[] = [];

  for (const block of blocks) {
    if (isNonCueBlock(block)) continue;

    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (!lines.length) continue;

    const timeIndex = lines.findIndex((line) => line.includes(TIME_SEPARATOR));
    if (timeIndex === -1) continue;

    const timeLine = lines[timeIndex] ?? "";
    const [rawStart, rawEndWithSettings] = timeLine.split(TIME_SEPARATOR).map((part) => part.trim());
    const rawEnd = (rawEndWithSettings ?? "").split(/\s+/)[0] ?? "";
    const start = parseVttTimestamp(rawStart);
    const end = parseVttTimestamp(rawEnd);
    if (typeof start !== "number" || typeof end !== "number") continue;

    const text = lines
      .slice(timeIndex + 1)
      .join("\n")
      .trim();
    if (!text) continue;

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

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "");
}

function isNonCueBlock(block: string): boolean {
  const head = block.split("\n", 1)[0]?.trim().toUpperCase() ?? "";
  return head === "WEBVTT" || head.startsWith("NOTE") || head.startsWith("STYLE") || head.startsWith("REGION");
}

function parseVttTimestamp(value: string): number | null {
  const match = value.match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})\.(\d{1,3})/);
  if (!match) return null;
  const hours = Number(match[1] ?? "0");
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? "0").padEnd(3, "0"));
  if (![hours, minutes, seconds, milliseconds].every((n) => Number.isFinite(n))) return null;
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000;
}
