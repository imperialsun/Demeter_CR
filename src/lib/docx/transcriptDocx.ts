import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";
import type { ExportMode, TranscriptionSegment } from "@/lib/export";
import logger from "@/lib/logger";

export interface TranscriptDocxMetadata {
  sourceMode: ExportMode;
  sourceLabel?: string;
  generatedAt?: string;
}

export async function buildTranscriptDocx(
  segments: TranscriptionSegment[],
  metadata: TranscriptDocxMetadata
): Promise<Blob> {
  logger.info("[transcript-docx] build start", {
    sourceMode: metadata.sourceMode,
    segmentCount: segments.length,
    hasSourceLabel: Boolean(metadata.sourceLabel?.trim()),
  });

  const generatedAt = metadata.generatedAt ? new Date(metadata.generatedAt) : new Date();
  const timestamp = Number.isNaN(generatedAt.getTime())
    ? metadata.generatedAt ?? ""
    : generatedAt.toLocaleString("fr-FR");
  const sourceLabel = metadata.sourceLabel?.trim() || "";
  const modeLabel = formatSourceModeLabel(metadata.sourceMode);

  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({ text: "Transcription brute", bold: true }),
          new TextRun({ text: "  |  Demeter Speech", color: "666666" }),
        ],
      }),
    ],
  });

  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.RIGHT,
        children: [
          new TextRun({ text: "Page " }),
          new TextRun({ children: [PageNumber.CURRENT] }),
          new TextRun({ text: " / " }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
        ],
      }),
    ],
  });

  const children: Paragraph[] = [
    new Paragraph({
      text: "Transcription brute",
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Mode: ${modeLabel}`, bold: true }),
        new TextRun({ text: `  |  Généré le: ${timestamp}` }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [new TextRun({ text: `Segments: ${segments.length}` })],
      spacing: { after: 140 },
    }),
  ];

  if (sourceLabel) {
    children.splice(
      1,
      0,
      new Paragraph({
        children: [new TextRun({ text: `Source: ${sourceLabel}` })],
        spacing: { after: 80 },
      })
    );
  }

  if (segments.length) {
    for (const segment of segments) {
      const text = segment.text.trim();
      if (!text) {
        continue;
      }

      const speaker = segment.speaker?.trim();
      const runs = speaker
        ? [new TextRun({ text: `${speaker}: `, bold: true }), new TextRun({ text })]
        : [new TextRun({ text })];

      children.push(
        new Paragraph({
          children: runs,
          spacing: { after: 80 },
          alignment: AlignmentType.LEFT,
        })
      );
    }
  } else {
    children.push(
      new Paragraph({
        text: "Transcription vide.",
        spacing: { after: 80 },
      })
    );
  }

  const doc = new Document({
    creator: "Demeter Speech",
    title: sourceLabel ? `Transcription brute - ${sourceLabel}` : "Transcription brute",
    description: "Transcription brute generee par Demeter Speech",
    sections: [
      {
        headers: { default: header },
        footers: { default: footer },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  logger.info("[transcript-docx] build done", {
    sourceMode: metadata.sourceMode,
    segmentCount: segments.length,
    sizeBytes: blob.size,
  });
  return blob;
}

export function formatTranscriptDocxFilename(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const min = `${date.getMinutes()}`.padStart(2, "0");
  return `transcription-brute-${yyyy}-${mm}-${dd}-${hh}${min}.docx`;
}

export function downloadDocxBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  logger.info("[transcript-docx] download start", { filename, sizeBytes: blob.size });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  logger.info("[transcript-docx] download done", { filename });
}

function formatSourceModeLabel(mode: ExportMode): string {
  switch (mode) {
    case "upload":
      return "Locale";
    case "mic":
      return "Micro";
    case "cloud":
      return "Cloud";
    default:
      return mode;
  }
}
