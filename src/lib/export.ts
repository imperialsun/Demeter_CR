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

export interface ExportHeader {
  exportedAt: string;
  mode: "upload" | "mic" | "cloud";
  settings: {
    file: Record<string, unknown>;
    mic: Record<string, unknown>;
    cloud?: Record<string, unknown>;
  };
  runtime?: Record<string, unknown>;
}

export function serializeVtt(segments: TranscriptionSegment[], header?: ExportHeader): string {
  const headerLine = "WEBVTT";
  const headerBlock = header ? formatHeaderBlock(headerLine, header, "vtt") : headerLine;
  const body = segments
    .map((segment) => {
      const start = formatTimestamp(segment.start, "vtt");
      const end = formatTimestamp(segment.end, "vtt");
      return `${segment.index}\n${start} --> ${end}\n${segment.text.trim()}\n`;
    })
    .join("\n");
  return `${headerBlock}\n\n${body}`;
}

export function serializeSrt(segments: TranscriptionSegment[], header?: ExportHeader): string {
  const headerBlock = header ? formatHeaderBlock("NOTE SETTINGS", header, "srt") + "\n\n" : "";
  const body = segments
    .map((segment) => {
      const start = formatTimestamp(segment.start, "srt");
      const end = formatTimestamp(segment.end, "srt");
      return `${segment.index}\n${start} --> ${end}\n${segment.text.trim()}\n`;
    })
    .join("\n");
  return `${headerBlock}${body}`;
}

export function serializeSegmentsJson(segments: TranscriptionSegment[], header?: ExportHeader): string {
  return JSON.stringify(
    {
      header,
      segments: segments.map((segment) => ({
        ...segment,
        text: segment.text.trim(),
      })),
    },
    null,
    2
  );
}

export function serializeTelemetry(summary: TelemetrySummary, header?: ExportHeader): string {
  return JSON.stringify({ header, telemetry: summary }, null, 2);
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

function formatHeaderBlock(label: string, header: ExportHeader, format: Format | "srt" | "vtt") {
  const json = JSON.stringify(header, null, 2);
  if (format === "vtt") {
    return `${label}\nNOTE SETTINGS\n${json}`;
  }
  return `${label}\n${json}`;
}
