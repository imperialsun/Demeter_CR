import { buildReportFormatLabel } from "@/lib/llm/reportPrompts";

export const CLOUD_WORKFLOW_MAX_EXPANSION_PASSES = 5;
export const CLOUD_WORKFLOW_GLOBAL_PASS_TOTAL = CLOUD_WORKFLOW_MAX_EXPANSION_PASSES + 1;

export interface CloudRunStageContext {
  provider: string;
  modelId: string;
  sourceMode: string;
  format?: string;
  detailLevel?: string;
  generationMode?: string;
  sequenceIndex?: number;
  sequenceTotal?: number;
}

export interface CloudRunStageDescriptor {
  telemetryData: Record<string, unknown>;
  consoleContext: Record<string, unknown>;
  consoleMessage: string;
  stageLabel: string;
  globalPassIndex: number;
  globalPassTotal: number;
}

const LONG_TEXT_KEYS = new Set([
  "summary",
  "rationale",
  "message",
  "responsePreview",
  "focusPreview",
  "errorPreview",
]);

export function formatCloudPassLabel(globalPassIndex: number | null | undefined, globalPassTotal: number | null | undefined): string | null {
  const safeIndex = normalizePositiveInt(globalPassIndex);
  const safeTotal = normalizePositiveInt(globalPassTotal);
  if (!safeIndex || !safeTotal || safeTotal <= 1) {
    return null;
  }
  return `Passe ${safeIndex}/${safeTotal}`;
}

export function resolveCloudRunStageDescriptor(
  stage: string,
  data: Record<string, unknown> | undefined,
  context: CloudRunStageContext
): CloudRunStageDescriptor {
  const normalizedData = normalizeStageData(data);
  const globalPassTotal = resolveGlobalPassTotal(stage, normalizedData, context);
  const globalPassIndex = resolveGlobalPassIndex(stage, normalizedData, context, globalPassTotal);
  const localLabel = resolveLocalStageLabel(stage, normalizedData, context);
  const passLabel = formatCloudPassLabel(globalPassIndex, globalPassTotal);
  const stageLabel = passLabel ? `${passLabel} · ${localLabel}` : localLabel;
  const stepKind = resolveStepKind(stage);
  const stepStatus = resolveStepStatus(stage);
  const summary = buildStageSummary(stage, normalizedData, context);
  const telemetryData: Record<string, unknown> = {
    stage,
    stageLabel,
    stepKind,
    stepStatus,
    globalPassIndex,
    globalPassTotal,
    provider: context.provider,
    modelId: context.modelId,
    sourceMode: context.sourceMode,
    ...(context.format ? { format: context.format } : {}),
    ...(context.detailLevel ? { detailLevel: context.detailLevel } : {}),
    ...(context.generationMode ? { generationMode: context.generationMode } : {}),
    ...(typeof context.sequenceIndex === "number" ? { sequenceIndex: context.sequenceIndex } : {}),
    ...(typeof context.sequenceTotal === "number" ? { sequenceTotal: context.sequenceTotal } : {}),
    ...normalizedData,
    ...(typeof normalizedData.summary === "string" && normalizedData.summary.trim() ? {} : summary ? { summary } : {}),
  };
  const consoleContext = buildConsoleContext(stage, telemetryData);

  return {
    telemetryData,
    consoleContext,
    consoleMessage: `${stageScope(stage)} ${stageLabel}`,
    stageLabel,
    globalPassIndex,
    globalPassTotal,
  };
}

export function resolveCloudRunStageLabel(
  stage: string,
  data: Record<string, unknown> | undefined,
  context: Partial<CloudRunStageContext> = {}
): string {
  return resolveCloudRunStageDescriptor(
    stage,
    data,
    {
      provider: context.provider ?? "cloud",
      modelId: context.modelId ?? "unset",
      sourceMode: context.sourceMode ?? "unknown",
      format: context.format,
      detailLevel: context.detailLevel,
      generationMode: context.generationMode,
      sequenceIndex: context.sequenceIndex,
      sequenceTotal: context.sequenceTotal,
    }
  ).stageLabel;
}

export function resolveCloudRunStageSummary(
  stage: string,
  data: Record<string, unknown> | undefined,
  context: Partial<CloudRunStageContext> = {}
): string | null {
  return buildStageSummary(stage, normalizeStageData(data), context) ?? null;
}

function resolveGlobalPassTotal(
  stage: string,
  data: Record<string, unknown>,
  context: CloudRunStageContext
): number {
  const explicit = normalizePositiveInt(data.globalPassTotal);
  if (explicit) {
    return explicit;
  }
  if (context.generationMode === "multi_pass" || stage.startsWith("workflow_")) {
    return CLOUD_WORKFLOW_GLOBAL_PASS_TOTAL;
  }
  return 1;
}

function resolveGlobalPassIndex(
  stage: string,
  data: Record<string, unknown>,
  context: CloudRunStageContext,
  globalPassTotal: number
): number {
  const explicit = normalizePositiveInt(data.globalPassIndex);
  if (explicit) {
    return explicit;
  }

  if (stage.startsWith("workflow_expansion_")) {
    const expansionPass = normalizePositiveInt(data.expansionPass);
    if (expansionPass) {
      return Math.min(globalPassTotal, expansionPass + 1);
    }
    const pipelinePasses = normalizePositiveInt(data.pipelinePasses);
    if (pipelinePasses) {
      return Math.min(globalPassTotal, pipelinePasses);
    }
    return Math.min(globalPassTotal, 2);
  }

  const pipelinePasses = normalizePositiveInt(data.pipelinePasses);
  if (
    pipelinePasses &&
    (stage === "workflow_section_assembled" ||
      stage === "workflow_metadata_start" ||
      stage === "workflow_metadata_done" ||
      stage === "workflow_done")
  ) {
    return Math.min(globalPassTotal, pipelinePasses);
  }

  if (context.generationMode === "multi_pass" && globalPassTotal > 1) {
    return 1;
  }

  return 1;
}

function resolveLocalStageLabel(stage: string, data: Record<string, unknown>, context: CloudRunStageContext): string {
  switch (stage) {
    case "LLM_RUN_START":
      return "Démarrage du run";
    case "LLM_RUN_DONE":
      return "Run terminé";
    case "LLM_RUN_ERROR":
      return "Erreur de génération";
    case "source_resolved":
      return "Source résolue";
    case "mistral_model_metadata":
      return "Métadonnées modèle";
    case "chunking_profile_resolved":
      return "Profil de découpage";
    case "prepare_long_input_start":
      return "Préparation source";
    case "prepare_long_input_done":
      return "Source préparée";
    case "token_budget_resolved":
      return "Budget tokens";
    case "report_sequence_start":
      return "Séquence des formats";
    case "format_generation_start":
      return buildFormatStageLabel(context, "démarrage");
    case "format_generation_done":
      return buildFormatStageLabel(context, "terminé");
    case "workflow_start":
      return "Planification";
    case "workflow_plan_start":
      return "Plan";
    case "workflow_plan_parsed":
      return "Plan structuré";
    case "workflow_plan_done":
      return "Plan validé";
    case "workflow_section_assembled":
      return "CR provisoire assemblé";
    case "workflow_part_extract_start":
      return buildSectionPathLabel(data, { suffix: "Extraction", includeSubpart: false, includeChunk: false });
    case "workflow_part_extract_done":
      return buildSectionPathLabel(data, { suffix: "Extraits prêts", includeSubpart: false, includeChunk: false });
    case "workflow_chunk_extract_start":
      return buildSectionPathLabel(data, { suffix: undefined, includeSubpart: true, includeChunk: true });
    case "workflow_chunk_extract_done":
      return buildSectionPathLabel(data, { suffix: "Extrait prêt", includeSubpart: true, includeChunk: true });
    case "workflow_section_review_start":
      return buildSectionPathLabel(data, { suffix: "Relecture", includeSubpart: true, includeChunk: false });
    case "workflow_section_review_done":
      return buildSectionPathLabel(data, { suffix: "Relecture terminée", includeSubpart: true, includeChunk: false });
    case "workflow_expansion_analysis_start":
      return "CR trop court · Analyse";
    case "workflow_expansion_analysis_done":
      return "CR trop court · Analyse terminée";
    case "workflow_expansion_structure_created":
      return buildExpansionLabel(data, "Structure ajoutée");
    case "workflow_expansion_target_start":
      return buildExpansionLabel(data, "Extraction");
    case "workflow_expansion_target_done":
      return buildExpansionLabel(data, "Relecture expansion");
    case "workflow_expansion_pass_done":
      return "Passe d’expansion terminée";
    case "workflow_expansion_saturation":
      return "Limite d’agrandissement atteinte";
    case "workflow_metadata_start":
      return "Métadonnées";
    case "workflow_metadata_done":
      return "Métadonnées prêtes";
    case "workflow_done":
      return "Terminé";
    default:
      return fallbackStageLabel(stage, data, context);
  }
}

function fallbackStageLabel(stage: string, data: Record<string, unknown>, context: CloudRunStageContext): string {
  if (context.format && stage === "format_generation_start") {
    return `${buildReportFormatLabel(context.format as Parameters<typeof buildReportFormatLabel>[0])} · démarrage`;
  }
  if (context.format && stage === "format_generation_done") {
    return `${buildReportFormatLabel(context.format as Parameters<typeof buildReportFormatLabel>[0])} · terminé`;
  }
  const summary = buildStageSummary(stage, data, context);
  if (summary) {
    return summary;
  }
  return stage.replace(/_/g, " ");
}

function buildFormatStageLabel(context: CloudRunStageContext, suffix: string): string {
  const label = context.format
    ? buildReportFormatLabel(context.format as Parameters<typeof buildReportFormatLabel>[0])
    : "Format";
  return `${label} · ${suffix}`;
}

function buildSectionPathLabel(
  data: Record<string, unknown>,
  options: { suffix?: string; includeSubpart: boolean; includeChunk: boolean }
): string {
  const segments: string[] = [];
  const partIndex = normalizePositiveInt(data.partIndex);
  const partTotal = normalizePositiveInt(data.partTotal);
  if (partIndex) {
    segments.push(partTotal ? `Partie ${partIndex}/${partTotal}` : `Partie ${partIndex}`);
  }

  if (options.includeSubpart) {
    const subpartIndex = normalizePositiveInt(data.subpartIndex);
    const subpartTotal = normalizePositiveInt(data.subpartTotal);
    if (subpartIndex) {
      segments.push(subpartTotal ? `Sous-partie ${subpartIndex}/${subpartTotal}` : `Sous-partie ${subpartIndex}`);
    }
  }

  if (options.includeChunk) {
    const chunkIndex = normalizePositiveInt(data.chunkIndex);
    const chunkTotal = normalizePositiveInt(data.chunkTotal);
    if (chunkIndex) {
      segments.push(chunkTotal ? `Chunk ${chunkIndex}/${chunkTotal}` : `Chunk ${chunkIndex}`);
    }
  }

  if (options.suffix) {
    segments.push(options.suffix);
  }

  return segments.length ? segments.join(" · ") : options.suffix ?? "Étape";
}

function buildExpansionLabel(data: Record<string, unknown>, suffix: string): string {
  const targetIndex = normalizePositiveInt(data.targetIndex) ?? normalizePositiveInt(data.expansionPass);
  const targetTotal = normalizePositiveInt(data.targetTotal) ?? normalizePositiveInt(data.targetCount);
  const mode = typeof data.mode === "string" ? data.mode : typeof data.structureKind === "string" ? data.structureKind : "";
  const noun = mode === "new_subpart" || mode === "expand_subpart" || mode === "subpart" ? "sous-partie" : "partie";
  if (targetIndex) {
    const base = targetTotal ? `Expansion ${noun} ${targetIndex}/${targetTotal}` : `Expansion ${noun} ${targetIndex}`;
    return `${base} · ${suffix}`;
  }
  return `Expansion · ${suffix}`;
}

function buildStageSummary(
  stage: string,
  data: Record<string, unknown>,
  context: Partial<CloudRunStageContext>
): string | undefined {
  const parts: string[] = [];
  const pushCount = (label: string, value: unknown) => {
    const normalized = normalizePositiveInt(value);
    if (!normalized) return;
    parts.push(`${formatNumber(normalized)} ${label}`);
  };

  pushCount("parties", data.partTotal);
  pushCount("chunks", data.chunkCount);
  pushCount("chunks", data.chunkTotal);
  pushCount("cibles", data.targetCount);
  pushCount("cibles", data.targetTotal);
  pushCount("mots source", data.sourceWordCount);
  pushCount("mots cible", data.targetWordCount);
  pushCount("mots CR", data.reportWordCount);
  pushCount("mots brouillon", data.draftWordCount);
  pushCount("mots bloc", data.chunkWordCount);
  pushCount("mots partie", data.sectionWordCount);
  pushCount("mots extrait", data.outputWordCount);
  pushCount("points clés", data.keyPointCount);
  pushCount("actions", data.actionItemCount);
  pushCount("caveats", data.caveatCount);

  if (stage === "workflow_plan_done" || stage === "workflow_plan_parsed") {
    if (typeof data.title === "string" && data.title.trim()) {
      parts.push(truncateText(data.title, 96));
    }
  }

  if (stage === "report_sequence_start") {
    pushCount("formats", data.totalFormats);
  }

  if (
    stage === "workflow_part_extract_done" ||
    stage === "workflow_section_review_done" ||
    stage === "workflow_expansion_target_done"
  ) {
    pushCount("mots", data.outputWordCount);
    pushCount("mots section", data.sectionWordCount);
  }

  if (stage === "workflow_section_assembled" || stage === "workflow_done") {
    // Generic counters already added above.
  }

  if (stage === "workflow_expansion_analysis_done") {
    parts.push(data.needs_more ? "enrichissement requis" : "enrichissement suffisant");
    if (typeof data.summary === "string" && data.summary.trim()) {
      parts.push(truncateText(data.summary, 140));
    }
  }

  if (stage === "workflow_metadata_done") {
    if (typeof data.title === "string" && data.title.trim()) {
      parts.push(truncateText(data.title, 96));
    }
    if (data.hasSubtitle) {
      parts.push("sous-titre prêt");
    }
  }

  if (stage === "format_generation_done") {
    pushCount("sections", data.sectionCount);
    pushCount("caractères", data.outputLength);
  }

  if (stage === "prepare_long_input_done") {
    pushCount("tokens", data.preparedTokenEstimate);
  }

  if (stage === "token_budget_resolved") {
    pushCount("tokens max", data.effectiveMaxGenerationTokens);
  }

  if (stage === "mistral_model_metadata") {
    pushCount("tokens contexte", data.contextWindowTokens);
  }

  if (typeof data.summary === "string" && data.summary.trim()) {
    parts.push(truncateText(data.summary, 140));
  }

  if (typeof data.rationale === "string" && data.rationale.trim()) {
    parts.push(truncateText(data.rationale, 120));
  }

  if (typeof data.partHeading === "string" && data.partHeading.trim()) {
    parts.push(truncateText(data.partHeading, 96));
  }

  if (typeof data.heading === "string" && data.heading.trim() && stage === "workflow_expansion_structure_created") {
    parts.push(truncateText(data.heading, 96));
  }

  if (parts.length) {
    return parts.join(" · ");
  }

  if (context.format && stage === "format_generation_start") {
    return buildReportFormatLabel(context.format as Parameters<typeof buildReportFormatLabel>[0]);
  }

  return undefined;
}

function buildConsoleContext(stage: string, telemetryData: Record<string, unknown>): Record<string, unknown> {
  return compactRecord({
    stage,
    stageLabel: telemetryData.stageLabel,
    globalPassIndex: telemetryData.globalPassIndex,
    globalPassTotal: telemetryData.globalPassTotal,
    format: telemetryData.format,
    detailLevel: telemetryData.detailLevel,
    generationMode: telemetryData.generationMode,
    sequenceIndex: telemetryData.sequenceIndex,
    sequenceTotal: telemetryData.sequenceTotal,
    partIndex: telemetryData.partIndex,
    partTotal: telemetryData.partTotal,
    subpartIndex: telemetryData.subpartIndex,
    subpartTotal: telemetryData.subpartTotal,
    chunkIndex: telemetryData.chunkIndex,
    chunkTotal: telemetryData.chunkTotal,
    targetIndex: telemetryData.targetIndex,
    targetTotal: telemetryData.targetTotal,
    expansionPass: telemetryData.expansionPass,
    pipelinePasses: telemetryData.pipelinePasses,
    sourceWordCount: telemetryData.sourceWordCount,
    chunkCount: telemetryData.chunkCount,
    reportWordCount: telemetryData.reportWordCount,
    targetWordCount: telemetryData.targetWordCount,
    sectionWordCount: telemetryData.sectionWordCount,
    outputWordCount: telemetryData.outputWordCount,
    summary: telemetryData.summary,
    rationale: telemetryData.rationale,
    title: telemetryData.title,
    heading: telemetryData.heading,
    partHeading: telemetryData.partHeading,
    needs_more: telemetryData.needs_more,
    hasSubtitle: telemetryData.hasSubtitle,
  });
}

function stageScope(stage: string): string {
  if (stage.startsWith("workflow_")) {
    return "[llm-api][workflow]";
  }
  if (stage.startsWith("format_") || stage.startsWith("report_")) {
    return "[llm-api][report]";
  }
  return "[llm-api]";
}

function resolveStepKind(stage: string): string {
  if (stage.startsWith("workflow_plan_")) return "plan";
  if (stage.startsWith("workflow_part_extract_")) return "part";
  if (stage.startsWith("workflow_chunk_extract_")) return "chunk";
  if (stage.startsWith("workflow_section_review_")) return "review";
  if (stage.startsWith("workflow_expansion_analysis_")) return "expansion";
  if (stage.startsWith("workflow_expansion_target_")) return "expansion";
  if (stage.startsWith("workflow_expansion_structure_")) return "expansion";
  if (stage.startsWith("workflow_metadata_")) return "metadata";
  if (stage.startsWith("workflow_")) return "workflow";
  if (stage.startsWith("format_generation_")) return "generation";
  if (stage.startsWith("prepare_long_input_") || stage === "source_resolved" || stage === "token_budget_resolved") return "preparation";
  if (stage === "report_sequence_start") return "sequence";
  if (stage === "LLM_RUN_START" || stage === "LLM_RUN_DONE" || stage === "LLM_RUN_ERROR") return "run";
  return "unknown";
}

function resolveStepStatus(stage: string): string {
  if (stage.endsWith("_start")) return "start";
  if (stage.endsWith("_done")) return "done";
  if (stage.endsWith("_parsed")) return "parsed";
  if (stage.endsWith("_analysis")) return "analysis";
  if (stage.endsWith("_created")) return "created";
  if (stage.endsWith("_saturation")) return "saturation";
  if (stage.endsWith("_resolved")) return "resolved";
  if (stage.endsWith("_start") || stage.endsWith("_done")) return "done";
  if (stage === "workflow_section_assembled") return "assembled";
  if (stage === "LLM_RUN_START") return "start";
  if (stage === "LLM_RUN_DONE") return "done";
  if (stage === "LLM_RUN_ERROR") return "error";
  return "info";
}

function normalizeStageData(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (typeof value === "string") {
      result[key] = LONG_TEXT_KEYS.has(key) ? truncateText(value, 160) : value.trim().length > 320 ? truncateText(value, 160) : value;
      continue;
    }
    result[key] = value;
  }
  return result;
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null));
}

function normalizePositiveInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const normalized = Math.floor(value);
    return normalized > 0 ? normalized : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      const normalized = Math.floor(parsed);
      return normalized > 0 ? normalized : null;
    }
  }
  return null;
}

function formatNumber(value: number): string {
  return Number.isFinite(value) ? value.toLocaleString("fr-FR") : String(value);
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const head = Math.max(32, Math.floor(maxLength / 2));
  const tail = Math.max(24, maxLength - head - 16);
  return `${normalized.slice(0, head)}...[${normalized.length - head - tail} chars omitted]...${normalized.slice(-tail)}`;
}
