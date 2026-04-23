import type { ReportDetailLevel } from "@/lib/llm/reportDetail";

export type ReportFormat = "CRI" | "CRO" | "CRS";
export type ReportResultKey = "cri" | "cro" | "crs";

export interface ReportJson {
  format: ReportFormat;
  title: string;
  subtitle?: string;
  sections: Array<{ heading: string; paragraphs: string[] }>;
  key_points?: string[];
  action_items?: string[];
  caveats?: string[];
}

export interface ReportResult {
  format: ReportFormat;
  report: ReportJson;
  rawResponse: string;
  modelId: string;
  generatedAt: string;
  sourceMode: "transcription" | "text";
  sourceTokenCount: number;
  pipelinePasses: number;
  strategy: "chatCompletion" | "textGeneration" | "localTextGeneration";
  detailLevel?: ReportDetailLevel;
}

const FORMAT_SET = new Set<ReportFormat>(["CRI", "CRO", "CRS"]);

export function reportFormatToKey(format: ReportFormat): ReportResultKey {
  return format.toLowerCase() as ReportResultKey;
}

export function reportKeyToFormat(key: ReportResultKey): ReportFormat {
  return key.toUpperCase() as ReportFormat;
}

export function parseReportJson(rawOutput: string, expectedFormat: ReportFormat): ReportJson {
  const parsed = parseJsonCandidate(rawOutput);
  return normalizeReport(parsed, expectedFormat);
}

export function cloneReportJson(report: ReportJson): ReportJson {
  const clone: ReportJson = {
    format: report.format,
    title: report.title,
    sections: report.sections.map((section) => ({
      heading: section.heading,
      paragraphs: [...section.paragraphs],
    })),
  };

  if (report.subtitle !== undefined) {
    clone.subtitle = report.subtitle;
  }
  if (report.key_points !== undefined) {
    clone.key_points = [...report.key_points];
  }
  if (report.action_items !== undefined) {
    clone.action_items = [...report.action_items];
  }
  if (report.caveats !== undefined) {
    clone.caveats = [...report.caveats];
  }

  return clone;
}

export function areReportJsonsEqual(left: ReportJson | null | undefined, right: ReportJson | null | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  if (left.format !== right.format) return false;
  if (left.title !== right.title) return false;
  if ((left.subtitle ?? undefined) !== (right.subtitle ?? undefined)) return false;
  if (!areStringArraysEqual(left.key_points, right.key_points)) return false;
  if (!areStringArraysEqual(left.action_items, right.action_items)) return false;
  if (!areStringArraysEqual(left.caveats, right.caveats)) return false;
  if (left.sections.length !== right.sections.length) return false;

  for (let index = 0; index < left.sections.length; index += 1) {
    const leftSection = left.sections[index];
    const rightSection = right.sections[index];
    if (!leftSection || !rightSection) return false;
    if (leftSection.heading !== rightSection.heading) return false;
    if (!areStringArraysEqual(leftSection.paragraphs, rightSection.paragraphs)) return false;
  }

  return true;
}

function parseJsonCandidate(rawOutput: string): unknown {
  const trimmed = rawOutput.trim();
  if (!trimmed) {
    throw new Error("La reponse du modele est vide.");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const primary = fenced?.[1]?.trim() ?? trimmed;
  const candidates = buildJsonCandidates(primary);

  for (const candidate of candidates) {
    const parsed = tryParseJsonVariants(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error("Le JSON retourne par le modele est invalide.");
}

function buildJsonCandidates(primary: string): string[] {
  const trimmed = primary.trim();
  const candidates = [trimmed];

  const balanced = extractFirstBalancedObject(trimmed);
  if (balanced) {
    candidates.push(balanced);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  return uniqueStrings(candidates);
}

function tryParseJsonVariants(candidate: string): unknown | null {
  const variants = uniqueStrings([
    candidate,
    normalizeJsonCandidate(candidate),
    stripTrailingCommas(candidate),
    normalizeJsonCandidate(stripTrailingCommas(candidate)),
  ]);

  for (const variant of variants) {
    try {
      return JSON.parse(variant);
    } catch {
      continue;
    }
  }

  return null;
}

function normalizeJsonCandidate(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2018\u2019]/g, "'");
}

function stripTrailingCommas(value: string): string {
  return value.replace(/,\s*([}\]])/g, "$1");
}

function extractFirstBalancedObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (!char) continue;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return value.slice(start, index + 1);
      }
    }
  }

  return null;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function normalizeReport(value: unknown, expectedFormat: ReportFormat): ReportJson {
  if (!value || typeof value !== "object") {
    throw new Error("Le JSON de sortie est invalide.");
  }
  const record = value as Record<string, unknown>;

  const formatCandidate = toTrimmedString(record.format)?.toUpperCase();
  const format = FORMAT_SET.has(expectedFormat) ? expectedFormat : (formatCandidate as ReportFormat);
  if (!FORMAT_SET.has(format)) {
    throw new Error("Le format du compte rendu est invalide dans la sortie du modele.");
  }

  const title = toTrimmedString(record.title) ?? `Compte rendu ${format}`;
  const subtitle = toTrimmedString(record.subtitle) ?? undefined;

  const sectionsRaw = Array.isArray(record.sections) ? record.sections : [];
  const sections = sectionsRaw
    .map((entry): { heading: string; paragraphs: string[] } | null => {
      if (!entry || typeof entry !== "object") return null;
      const section = entry as Record<string, unknown>;
      const heading = toTrimmedString(section.heading);
      const paragraphs = normalizeStringArray(section.paragraphs);
      if (!heading || !paragraphs.length) return null;
      return { heading, paragraphs };
    })
    .filter((entry): entry is { heading: string; paragraphs: string[] } => Boolean(entry));

  if (!sections.length) {
    throw new Error("Le JSON de sortie ne contient aucune section exploitable.");
  }

  const report: ReportJson = {
    format,
    title,
    sections,
  };

  if (subtitle) report.subtitle = subtitle;

  const keyPoints = normalizeStringArray(record.key_points);
  if (keyPoints.length) report.key_points = keyPoints;

  const actionItems = normalizeStringArray(record.action_items);
  if (actionItems.length) report.action_items = actionItems;

  const caveats = normalizeStringArray(record.caveats);
  if (caveats.length) report.caveats = caveats;

  return report;
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftValues = left ?? [];
  const rightValues = right ?? [];
  if (leftValues.length !== rightValues.length) return false;

  for (let index = 0; index < leftValues.length; index += 1) {
    if (leftValues[index] !== rightValues[index]) {
      return false;
    }
  }

  return true;
}
