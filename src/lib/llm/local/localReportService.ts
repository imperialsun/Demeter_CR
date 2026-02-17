import { buildReportSystemPrompt, buildReportUserPrompt } from "@/lib/llm/reportPrompts";
import { parseReportJson, type ReportFormat, type ReportJson } from "@/lib/llm/reportSchema";
import { generateLocalText, type GenerateLocalTextParams } from "@/lib/llm/local/localGeneration";
import logger from "@/lib/logger";
import type { BackendImplementation, ModelDtype } from "@/store/asr-store";

export interface GenerateLocalReportParams {
  format: ReportFormat;
  modelId: string;
  sourceText: string;
  backend: BackendImplementation;
  dtype: ModelDtype;
  temperature: number;
  maxTokens: number;
  appendNoThinkDirective?: boolean;
  onLoadProgress?: GenerateLocalTextParams["onLoadProgress"];
}

export interface GenerateLocalReportDetailedResult {
  report: ReportJson;
  rawResponse: string;
  strategy: "localTextGeneration";
}

export async function generateLocalReport(params: GenerateLocalReportParams): Promise<ReportJson> {
  const detailed = await generateLocalReportDetailed(params);
  return detailed.report;
}

export async function generateLocalReportDetailed(
  params: GenerateLocalReportParams
): Promise<GenerateLocalReportDetailedResult> {
  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID local manquant.");
  }

  const sourceText = params.sourceText.trim();
  if (!sourceText) {
    throw new Error("Source vide pour la generation locale.");
  }

  const userPrompt = buildLocalUserPrompt(params.format, sourceText, Boolean(params.appendNoThinkDirective));

  logger.info("[llm-local][report-service] generation start", {
    modelId,
    format: params.format,
    backend: params.backend,
    dtype: params.dtype,
  });

  const rawResponse = await generateLocalText({
    modelId,
    backend: params.backend,
    dtype: params.dtype,
    systemPrompt: buildReportSystemPrompt(),
    userPrompt,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    onLoadProgress: params.onLoadProgress,
  });

  const parsed = await parseWithRepair({
    modelId,
    format: params.format,
    rawResponse,
    backend: params.backend,
    dtype: params.dtype,
    maxTokens: params.maxTokens,
    onLoadProgress: params.onLoadProgress,
  });

  logger.info("[llm-local][report-service] generation parsed", {
    modelId,
    format: parsed.format,
    sectionCount: parsed.sections.length,
  });

  return {
    report: parsed,
    rawResponse,
    strategy: "localTextGeneration",
  };
}

async function parseWithRepair(params: {
  modelId: string;
  format: ReportFormat;
  rawResponse: string;
  backend: BackendImplementation;
  dtype: ModelDtype;
  maxTokens: number;
  onLoadProgress?: GenerateLocalTextParams["onLoadProgress"];
}): Promise<ReportJson> {
  try {
    return parseReportJson(params.rawResponse, params.format);
  } catch (error) {
    logger.warn("[llm-local][report-service] invalid json, running repair pass", {
      modelId: params.modelId,
      format: params.format,
      message: error instanceof Error ? error.message : String(error),
    });

    const repaired = await generateLocalText({
      modelId: params.modelId,
      backend: params.backend,
      dtype: params.dtype,
      systemPrompt: [
        "Tu corriges des sorties JSON de modele.",
        "Retourne uniquement un JSON valide.",
        "Ne produis aucun commentaire autour.",
      ].join("\n"),
      userPrompt: buildRepairPrompt(params.format, params.rawResponse),
      temperature: 0,
      maxTokens: Math.max(256, Math.min(2048, params.maxTokens)),
      onLoadProgress: params.onLoadProgress,
    });

    return parseReportJson(repaired, params.format);
  }
}

function buildLocalUserPrompt(format: ReportFormat, sourceText: string, appendNoThinkDirective: boolean): string {
  const basePrompt = buildReportUserPrompt(format, sourceText);
  if (!appendNoThinkDirective) return basePrompt;
  return `${basePrompt}\n\n/no_think`;
}

function buildRepairPrompt(format: ReportFormat, rawResponse: string): string {
  return [
    `Format attendu: ${format}.`,
    "Corrige la sortie ci-dessous en JSON valide conforme au schema attendu (format/title/sections/key_points/action_items/caveats).",
    "Conserve le sens des informations deja presentes.",
    "SORTIE A CORRIGER:",
    rawResponse,
  ].join("\n\n");
}
