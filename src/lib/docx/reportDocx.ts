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
import type { ReportFormat, ReportJson, ReportResultKey } from "@/lib/llm/reportSchema";
import logger from "@/lib/logger";

export interface ReportDocxMetadata {
  format: ReportFormat;
  modelId: string;
  generatedAt: string;
  sourceMode: "transcription" | "text";
  sourceTokenCount: number;
}

export async function buildReportDocx(report: ReportJson, metadata: ReportDocxMetadata): Promise<Blob> {
  logger.info("[llm-api][docx] build start", {
    format: metadata.format,
    modelId: metadata.modelId,
    sectionCount: report.sections.length,
    sourceMode: metadata.sourceMode,
    sourceTokenCount: metadata.sourceTokenCount,
  });
  const generatedAt = new Date(metadata.generatedAt);
  const timestamp = Number.isNaN(generatedAt.getTime())
    ? metadata.generatedAt
    : generatedAt.toLocaleString("fr-FR");

  const header = new Header({
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({ text: `Rapport ${metadata.format}`, bold: true }),
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
      text: report.title,
      heading: HeadingLevel.TITLE,
      spacing: { after: 200 },
    }),
  ];

  if (report.subtitle) {
    children.push(
      new Paragraph({
        text: report.subtitle,
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      })
    );
  }

  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: `Format: ${metadata.format}`, bold: true }),
        new TextRun({ text: `  |  Genere le: ${timestamp}` }),
      ],
      spacing: { after: 80 },
    }),
    new Paragraph({
      children: [
        new TextRun({ text: `Mode source: ${metadata.sourceMode}` }),
        new TextRun({ text: `  |  Modele: ${metadata.modelId}` }),
        new TextRun({ text: `  |  Tokens source: ${metadata.sourceTokenCount}` }),
      ],
      spacing: { after: 280 },
    })
  );

  for (const section of report.sections) {
    children.push(
      new Paragraph({
        text: section.heading,
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 180, after: 120 },
      })
    );

    for (const paragraph of section.paragraphs) {
      children.push(
        new Paragraph({
          text: paragraph,
          spacing: { after: 100 },
          alignment: AlignmentType.JUSTIFIED,
        })
      );
    }
  }

  appendBulletSection(children, "Points cles", report.key_points);
  appendBulletSection(children, "Actions", report.action_items);
  appendBulletSection(children, "Points de vigilance", report.caveats);

  const doc = new Document({
    creator: "Demeter Speech",
    title: `${metadata.format} - ${report.title}`,
    description: "Compte rendu genere par LLM API",
    sections: [
      {
        headers: { default: header },
        footers: { default: footer },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  logger.info("[llm-api][docx] build done", {
    format: metadata.format,
    modelId: metadata.modelId,
    sectionCount: report.sections.length,
    sizeBytes: blob.size,
  });
  return blob;
}

export function formatReportDocxFilename(formatKey: ReportResultKey, date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  const hh = `${date.getHours()}`.padStart(2, "0");
  const min = `${date.getMinutes()}`.padStart(2, "0");
  return `rapport-${formatKey}-${yyyy}-${mm}-${dd}-${hh}${min}.docx`;
}

export function downloadDocxBlob(blob: Blob, filename: string) {
  if (typeof document === "undefined") return;
  logger.info("[llm-api][docx] download start", { filename, sizeBytes: blob.size });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
  logger.info("[llm-api][docx] download done", { filename });
}

function appendBulletSection(target: Paragraph[], title: string, entries: string[] | undefined) {
  if (!entries?.length) return;

  target.push(
    new Paragraph({
      text: title,
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 180, after: 100 },
    })
  );

  for (const entry of entries) {
    target.push(
      new Paragraph({
        text: entry,
        bullet: { level: 0 },
        spacing: { after: 70 },
      })
    );
  }
}
