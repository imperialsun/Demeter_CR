import type { ReportFormat } from "@/lib/llm/reportSchema";

export const REPORT_DETAIL_LEVELS = ["standard", "verbose", "exhaustive"] as const;

export type ReportDetailLevel = (typeof REPORT_DETAIL_LEVELS)[number];

export const REPORT_DETAIL_LEVEL_LABELS: Record<ReportDetailLevel, string> = {
  standard: "Standard",
  verbose: "Verbeux",
  exhaustive: "Exhaustif",
};

export const DEFAULT_REPORT_DETAIL_LEVELS: Record<ReportFormat, ReportDetailLevel> = {
  CUSTOM: "standard",
  CRI: "standard",
  CRO: "standard",
  CRS: "standard",
  CRN: "standard",
};

export const REPORT_DETAIL_TARGETS: Record<
  ReportFormat,
  Record<ReportDetailLevel, { ratio: number; label: string }>
> = {
  CUSTOM: {
    standard: { ratio: 0.05, label: "libre compact" },
    verbose: { ratio: 0.1, label: "libre developpe" },
    exhaustive: { ratio: 0.15, label: "libre tres detaille" },
  },
  CRI: {
    standard: { ratio: 0.05, label: "compact" },
    verbose: { ratio: 0.1, label: "developpe" },
    exhaustive: { ratio: 0.15, label: "tres detaille" },
  },
  CRO: {
    standard: { ratio: 0.025, label: "compact" },
    verbose: { ratio: 0.05, label: "developpe" },
    exhaustive: { ratio: 0.075, label: "tres detaille" },
  },
  CRS: {
    standard: { ratio: 0.0125, label: "compact" },
    verbose: { ratio: 0.025, label: "developpe" },
    exhaustive: { ratio: 0.0375, label: "tres detaille" },
  },
  CRN: {
    standard: { ratio: 0.4, label: "narratif" },
    verbose: { ratio: 0.5, label: "narratif developpe" },
    exhaustive: { ratio: 0.6, label: "proces-verbal" },
  },
};

const REPORT_DETAIL_LEVEL_GUIDANCE: Record<ReportDetailLevel, string> = {
  standard: "standard = complet mais compact, sans superflu inutile.",
  verbose: "verbeux = sensiblement plus developpe, avec davantage de contexte et de precisions.",
  exhaustive:
    "exhaustif = le plus long et le plus detaille, avec expansion claire du contexte, des interlocuteurs nommes, des opinions et des points de vigilance.",
};

export function normalizeReportDetailLevel(value: unknown, fallback: ReportDetailLevel = "standard"): ReportDetailLevel {
  return typeof value === "string" && isReportDetailLevel(value) ? value : fallback;
}

export function normalizeReportDetailLevels(
  value: unknown,
  fallback: Record<ReportFormat, ReportDetailLevel> = DEFAULT_REPORT_DETAIL_LEVELS
): Record<ReportFormat, ReportDetailLevel> {
  const next: Record<ReportFormat, ReportDetailLevel> = { ...fallback };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return next;
  }

  const record = value as Partial<Record<ReportFormat, unknown>>;
  for (const format of getReportFormats()) {
    next[format] = normalizeReportDetailLevel(record[format], fallback[format]);
  }

  return next;
}

export function reportDetailLevelToIndex(level: ReportDetailLevel): number {
  return REPORT_DETAIL_LEVELS.indexOf(level);
}

export function reportDetailIndexToLevel(index: number): ReportDetailLevel {
  const normalizedIndex = Math.max(0, Math.min(REPORT_DETAIL_LEVELS.length - 1, Math.round(index)));
  return REPORT_DETAIL_LEVELS[normalizedIndex] ?? "standard";
}

export function buildReportDetailLevelLabel(level: ReportDetailLevel): string {
  return REPORT_DETAIL_LEVEL_LABELS[level];
}

export function buildReportDetailTargetLabel(format: ReportFormat, level: ReportDetailLevel): string {
  return REPORT_DETAIL_TARGETS[format][level].label;
}

export function buildReportDetailSummary(format: ReportFormat, level: ReportDetailLevel): string {
  return `${buildReportDetailLevelLabel(level)} · ${buildReportDetailTargetLabel(format, level)}`;
}

export function buildReportDetailPromptRules(
  format: ReportFormat,
  level: ReportDetailLevel,
  sourceText: string
): string[] {
  const targetWordCount = computeReportDetailTargetWordCount(format, level, sourceText);
  const targetWordLabel = targetWordCount <= 1 ? "mot" : "mots";

  return [
    `longueur minimale obligatoire (${buildReportDetailLevelLabel(level)}): vise au moins ${targetWordCount} ${targetWordLabel} en prenant la quantité demandee comme base minimale sur la transcription source.`,
    "cette limite est un minimum, pas un plafond.",
    "tu peux depasser cette longueur sans probleme si cela ameliore la fidelite, le contexte, les noms cites ou les nuances; ne compresse pas le texte pour rester court.",
    `progression attendue: ${REPORT_DETAIL_LEVEL_GUIDANCE[level]}`,
    "si des interlocuteurs sont nommes, cite leurs noms et leur avis ou position lorsqu'elle est exprimee.",
  ];
}

export function computeReportDetailTargetWordCount(
  format: ReportFormat,
  level: ReportDetailLevel,
  sourceTextOrWordCount: string | number
): number {
  const sourceWordCount =
    typeof sourceTextOrWordCount === "number" ? sourceTextOrWordCount : countWords(sourceTextOrWordCount);
  const target = REPORT_DETAIL_TARGETS[format][level];
  return Math.max(1, Math.round(sourceWordCount * target.ratio));
}

function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.trim().match(/[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu);
  return matches ? matches.length : 0;
}

function getReportFormats(): ReportFormat[] {
  return ["CUSTOM", "CRI", "CRO", "CRS", "CRN"];
}

function isReportDetailLevel(value: string): value is ReportDetailLevel {
  return (REPORT_DETAIL_LEVELS as readonly string[]).includes(value);
}
