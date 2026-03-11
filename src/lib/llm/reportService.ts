import { buildReportSystemPrompt, buildReportUserPrompt } from "@/lib/llm/reportPrompts";
import { parseReportJson, type ReportFormat, type ReportJson } from "@/lib/llm/reportSchema";
import {
  generateWithChatThenFallbackText,
  getLlmHfClient,
  type GenerationStrategy,
} from "@/lib/llm/hfClient";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";
import { generateWithDemeterChat } from "@/lib/llm/demeterChatClient";
import logger from "@/lib/logger";

interface GenerateReportBaseParams {
  format: ReportFormat;
  modelId: string;
  sourceText: string;
  temperature: number;
  maxTokens: number;
}

export interface GenerateReportHuggingFaceParams extends GenerateReportBaseParams {
  provider: "huggingface";
  hfToken: string;
}

export interface GenerateReportMistralParams extends GenerateReportBaseParams {
  provider: "mistral";
  mistralApiKey: string;
  mistralApiUrl: string;
}

export interface GenerateReportDemeterParams extends GenerateReportBaseParams {
  provider: "demeter_sante";
}

export type GenerateReportParams =
  | GenerateReportHuggingFaceParams
  | GenerateReportMistralParams
  | GenerateReportDemeterParams;

export interface GenerateReportDetailedResult {
  report: ReportJson;
  rawResponse: string;
  strategy: GenerationStrategy;
}

export async function generateReport(params: GenerateReportParams): Promise<ReportJson> {
  const detailed = await generateReportDetailed(params);
  return detailed.report;
}

export async function generateReportDetailed(
  params: GenerateReportParams
): Promise<GenerateReportDetailedResult> {
  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID manquant.");
  }

  const sourceText = params.sourceText.trim();
  if (!sourceText) {
    throw new Error("Source vide pour la generation du compte rendu.");
  }
  logger.info("[llm-api][report-service] generation start", {
    provider: params.provider,
    format: params.format,
    modelId,
    sourceLength: sourceText.length,
  });

  let generation: { text: string; strategy: GenerationStrategy };
  if (params.provider === "huggingface") {
    const token = params.hfToken.trim();
    if (!token) {
      throw new Error("Token Hugging Face manquant.");
    }

    const client = await getLlmHfClient(token);
    generation = await generateWithChatThenFallbackText({
      client,
      modelId,
      systemPrompt: buildReportSystemPrompt(),
      userPrompt: buildReportUserPrompt(params.format, sourceText),
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      responseMode: "json",
    });
  } else if (params.provider === "mistral") {
    const apiKey = params.mistralApiKey.trim();
    if (!apiKey) {
      throw new Error("Token API Mistral manquant.");
    }
    generation = await generateWithMistralChat({
      apiUrl: params.mistralApiUrl,
      apiKey,
      modelId,
      systemPrompt: buildReportSystemPrompt(),
      userPrompt: buildReportUserPrompt(params.format, sourceText),
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      responseMode: "json",
    });
  } else {
    generation = await generateWithDemeterChat({
      modelId,
      systemPrompt: buildReportSystemPrompt(),
      userPrompt: buildReportUserPrompt(params.format, sourceText),
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      responseMode: "json",
    });
  }
  logger.info("[llm-api][report-service] generation response received", {
    provider: params.provider,
    format: params.format,
    modelId,
    strategy: generation.strategy,
    responseLength: generation.text.length,
  });

  let report: ReportJson;
  try {
    report = parseReportJson(generation.text, params.format);
  } catch (error) {
    logger.warn("[llm-api][report-service] invalid report json", {
      provider: params.provider,
      format: params.format,
      modelId,
      strategy: generation.strategy,
      responseLength: generation.text.length,
      responsePreview: buildTextPreview(generation.text),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  logger.info("[llm-api][report-service] generation parsed", {
    provider: params.provider,
    format: report.format,
    modelId,
    strategy: generation.strategy,
    sectionCount: report.sections.length,
  });
  return {
    report,
    rawResponse: generation.text,
    strategy: generation.strategy,
  };
}

function buildTextPreview(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  if (normalized.length <= 512) return normalized;
  return `${normalized.slice(0, 256)}...[${normalized.length - 512} chars omitted]...${normalized.slice(-256)}`;
}
