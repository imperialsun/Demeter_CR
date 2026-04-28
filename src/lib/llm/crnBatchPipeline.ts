import { cloneReportJson, type ReportJson } from "@/lib/llm/reportSchema";

export interface CrnTranscriptBatch {
  batchIndex: number;
  batchCount: number;
  startLine: number;
  endLine: number;
  lines: string[];
  text: string;
}

const DEFAULT_CRN_BATCH_LINE_COUNT = 10;
const DEFAULT_CRN_BATCH_OVERLAP_LINES = 0;

export function splitTranscriptTextIntoLines(sourceText: string): string[] {
  return sourceText
    .split(/\r?\n+/)
    .map((line) => normalizeLineText(line))
    .filter((line): line is string => Boolean(line));
}

export function buildCrnTranscriptBatches(
  sourceText: string,
  options: { linesPerBatch?: number; overlapLines?: number } = {}
): CrnTranscriptBatch[] {
  const lines = splitTranscriptTextIntoLines(sourceText);
  if (!lines.length) {
    return [];
  }

  const linesPerBatch = normalizePositiveInt(options.linesPerBatch, DEFAULT_CRN_BATCH_LINE_COUNT);
  const overlapLines = normalizePositiveInt(options.overlapLines, DEFAULT_CRN_BATCH_OVERLAP_LINES);
  const chunkSize = Math.max(1, linesPerBatch);
  const safeOverlap = Math.min(Math.max(0, overlapLines), chunkSize - 1);
  const step = Math.max(1, chunkSize - safeOverlap);

  const batches: CrnTranscriptBatch[] = [];
  for (let startLine = 0; startLine < lines.length; startLine += step) {
    const endLine = Math.min(lines.length, startLine + chunkSize);
    const batchLines = lines.slice(startLine, endLine);
    batches.push({
      batchIndex: batches.length + 1,
      batchCount: 0,
      startLine,
      endLine,
      lines: batchLines,
      text: batchLines.join("\n"),
    });
    if (endLine >= lines.length) {
      break;
    }
  }

  const batchCount = batches.length;
  return batches.map((batch) => ({
    ...batch,
    batchCount,
  }));
}

export function mergeCrnReportResults(reports: ReportJson[]): ReportJson {
  if (!reports.length) {
    throw new Error("Impossible de fusionner un CRN vide.");
  }

  const merged = cloneReportJson(reports[0]!);
  merged.format = "CRN";

  for (const report of reports.slice(1)) {
    mergeReportTitle(merged, report);
    mergeReportSubtitle(merged, report);
    mergeReportSections(merged, report);
    merged.key_points = mergeUniqueStringLists(merged.key_points, report.key_points);
    merged.action_items = mergeUniqueStringLists(merged.action_items, report.action_items);
    merged.caveats = mergeUniqueStringLists(merged.caveats, report.caveats);
  }

  return merged;
}

function mergeReportTitle(target: ReportJson, source: ReportJson) {
  if (!target.title.trim() && source.title.trim()) {
    target.title = source.title;
  }
}

function mergeReportSubtitle(target: ReportJson, source: ReportJson) {
  if (target.subtitle || !source.subtitle) {
    return;
  }
  target.subtitle = source.subtitle;
}

function mergeReportSections(target: ReportJson, source: ReportJson) {
  const sectionIndexByHeading = new Map<string, number>();
  target.sections.forEach((section, index) => {
    sectionIndexByHeading.set(normalizeSectionKey(section.heading), index);
  });

  for (const section of source.sections) {
    const normalizedHeading = normalizeSectionKey(section.heading);
    const existingIndex = sectionIndexByHeading.get(normalizedHeading);
    if (typeof existingIndex === "number") {
      const existingSection = target.sections[existingIndex]!;
      existingSection.paragraphs = mergeUniqueStringLists(existingSection.paragraphs, section.paragraphs);
      continue;
    }

    target.sections.push({
      heading: section.heading,
      paragraphs: mergeUniqueStringLists(undefined, section.paragraphs) ?? [],
    });
    sectionIndexByHeading.set(normalizedHeading, target.sections.length - 1);
  }
}

function mergeUniqueStringLists(left: string[] | undefined, right: string[] | undefined): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const value of [...(left ?? []), ...(right ?? [])]) {
    const normalized = normalizeLineText(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(value.trim());
  }

  return merged;
}

function normalizeSectionKey(value: string): string {
  return normalizeLineText(value).toLowerCase();
}

function normalizeLineText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}
