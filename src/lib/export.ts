import type { TelemetrySummary } from "@/lib/telemetry";

export interface WordSegment {
  word: string;
  start: number;
  end: number;
  confidence?: number;
}

export interface TranscriptionSegment {
  index: number;
  start: number;
  end: number;
  text: string;
  chunkId: string;
  strategy: "chunks" | "silence";
  confidence?: number;
  confidenceSource?: 'model' | 'estimated';
  words?: WordSegment[];
} 

export function serializeVtt(segments: TranscriptionSegment[]): string {
  const header = "WEBVTT";
  const body = segments
    .map((segment) => {
      const start = formatTimestamp(segment.start, "vtt");
      const end = formatTimestamp(segment.end, "vtt");
      return `${segment.index}\n${start} --> ${end}\n${segment.text.trim()}\n`;
    })
    .join("\n");
  return `${header}\n\n${body}`;
}

export function serializeSrt(segments: TranscriptionSegment[]): string {
  return segments
    .map((segment) => {
      const start = formatTimestamp(segment.start, "srt");
      const end = formatTimestamp(segment.end, "srt");
      return `${segment.index}\n${start} --> ${end}\n${segment.text.trim()}\n`;
    })
    .join("\n");
}

export function serializeSegmentsJson(segments: TranscriptionSegment[]): string {
  return JSON.stringify(
    segments.map((segment) => ({
      ...segment,
      text: segment.text.trim(),
    })),
    null,
    2
  );
}

export function serializeTelemetry(summary: TelemetrySummary): string {
  return JSON.stringify(summary, null, 2);
}

export function downloadBlob(content: string, filename: string, type: string) {
  if (typeof document === "undefined") return;
  const blob = new Blob([content], { type });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

type Format = "vtt" | "srt";

function formatTimestamp(seconds: number, format: Format) {
  const hh = pad(Math.floor(seconds / 3600));
  const mm = pad(Math.floor((seconds % 3600) / 60));
  const ss = pad(Math.floor(seconds % 60));
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);
  const fraction = format === "vtt" ? `.${ms.toString().padStart(3, "0")}` : `,${ms
    .toString()
    .padStart(3, "0")}`;
  return `${hh}:${mm}:${ss}${fraction}`;
}

function pad(value: number) {
  return value.toString().padStart(2, "0");
}
