import { buildReportSystemPrompt, buildReportUserPrompt } from "@/lib/llm/reportPrompts";
import { parseReportJson, type ReportFormat, type ReportJson } from "@/lib/llm/reportSchema";
import type { ReportDetailLevel } from "@/lib/llm/reportDetail";
import {
  generateWithChatThenFallbackText,
  getLlmHfClient,
  type GenerationStrategy,
} from "@/lib/llm/hfClient";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";
import {
  backendFetch,
  handleBackendUnauthorized,
  parseBackendHttpError,
} from "@/lib/backend-api";
import { BackendSessionExpiredError, backendRefresh } from "@/lib/backend-auth";
import logger from "@/lib/logger";

interface GenerateReportBaseParams {
  format: ReportFormat;
  modelId: string;
  sourceText: string;
  temperature: number;
  maxTokens: number;
  detailLevel?: ReportDetailLevel;
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

type DemeterReportOperationResponse = {
  operationId: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
  statusCode?: number;
  stage?: string;
  progress?: number;
  lastError?: string;
  response?: {
    format?: string;
    raw?: string;
    report?: ReportJson;
  };
};

const DEMETER_REPORT_REQUEST_TIMEOUT_MS = 30_000;
const DEMETER_REPORT_POLL_INTERVAL_MS = 10_000;
const DEMETER_REPORT_POLL_TIMEOUT_MS = 10 * 60_000;

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
  logger.info("[llm-api][report-service] Génération standard · démarrage", {
    provider: params.provider,
    format: params.format,
    modelId,
    detailLevel: params.detailLevel ?? "standard",
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
      systemPrompt: buildReportSystemPrompt(params.detailLevel),
      userPrompt: buildReportUserPrompt(params.format, sourceText, params.detailLevel),
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
      systemPrompt: buildReportSystemPrompt(params.detailLevel),
      userPrompt: buildReportUserPrompt(params.format, sourceText, params.detailLevel),
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      responseMode: "json",
    });
  } else {
    return generateWithDemeterReportQueue({
      format: params.format,
      modelId,
      sourceText,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      detailLevel: params.detailLevel,
    });
  }
  logger.info("[llm-api][report-service] Génération standard · réponse reçue", {
    provider: params.provider,
    format: params.format,
    modelId,
    detailLevel: params.detailLevel ?? "standard",
    strategy: generation.strategy,
    responseLength: generation.text.length,
  });

  let report: ReportJson;
  try {
    report = parseReportJson(generation.text, params.format);
  } catch (error) {
    logger.warn("[llm-api][report-service] JSON de rapport invalide", {
      provider: params.provider,
      format: params.format,
      modelId,
      detailLevel: params.detailLevel ?? "standard",
      strategy: generation.strategy,
      responseLength: generation.text.length,
      responsePreview: buildTextPreview(generation.text),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  logger.info("[llm-api][report-service] Rapport parsé", {
    provider: params.provider,
    format: report.format,
    modelId,
    detailLevel: params.detailLevel ?? "standard",
    strategy: generation.strategy,
    sectionCount: report.sections.length,
  });
  return {
    report,
    rawResponse: generation.text,
    strategy: generation.strategy,
  };
}

async function generateWithDemeterReportQueue(params: {
  format: ReportFormat;
  modelId: string;
  sourceText: string;
  temperature: number;
  maxTokens: number;
  detailLevel?: ReportDetailLevel;
}): Promise<GenerateReportDetailedResult> {
  const submitBody = {
    format: params.format,
    modelId: params.modelId,
    sourceText: params.sourceText,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    detailLevel: params.detailLevel ?? "standard",
  };

  const submit = () =>
    backendFetch("/providers/demeter-sante/report/operations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(submitBody),
      timeoutMs: DEMETER_REPORT_REQUEST_TIMEOUT_MS,
    });

  let submitResponse = await submit();
  if (!submitResponse.ok && submitResponse.status === 401) {
    const refreshResult = await backendRefresh();
    if (refreshResult === "expired") {
      throw new BackendSessionExpiredError();
    }
    if (refreshResult === "failed") {
      throw new Error("Impossible de renouveler la session backend Demeter Santé.");
    }
    submitResponse = await submit();
  }
  if (!submitResponse.ok) {
    const error = await parseBackendHttpError(submitResponse, "/providers/demeter-sante/report/operations", "POST");
    if ((error as Error & { status?: number }).status === 401) {
      handleBackendUnauthorized(error);
    }
    throw error;
  }

  const submitPayload = (await submitResponse.json()) as DemeterReportOperationResponse;
  const operationId = submitPayload.operationId?.trim();
  if (!operationId) {
    throw new Error("Réponse backend invalide: operationId manquant.");
  }

  const pollStartedAt = Date.now();
  while (true) {
    if (Date.now() - pollStartedAt > DEMETER_REPORT_POLL_TIMEOUT_MS) {
      throw new Error("Le traitement du rapport a dépassé le délai maximal.");
    }

    const statusRes = await backendFetch(`/providers/demeter-sante/report/operations/${encodeURIComponent(operationId)}`, {
      method: "GET",
      timeoutMs: DEMETER_REPORT_REQUEST_TIMEOUT_MS,
    });
    if (!statusRes.ok) {
      const error = await parseBackendHttpError(
        statusRes,
        `/providers/demeter-sante/report/operations/${operationId}`,
        "GET"
      );
      if ((error as Error & { status?: number }).status === 401) {
        handleBackendUnauthorized(error);
      }
      throw error;
    }

    const snapshot = (await statusRes.json()) as DemeterReportOperationResponse;
    if (snapshot.status === "completed") {
      const report = snapshot.response?.report;
      if (!report) {
        throw new Error("Le backend a terminé sans renvoyer de rapport.");
      }
      return {
        report,
        rawResponse: snapshot.response?.raw ?? "",
        strategy: "chatCompletion",
      };
    }
    if (snapshot.status === "failed") {
      throw new Error(snapshot.lastError?.trim() || "La génération du rapport a échoué.");
    }
    if (snapshot.status === "cancelled") {
      throw new Error("La génération du rapport a été annulée.");
    }

    await new Promise((resolve) => setTimeout(resolve, DEMETER_REPORT_POLL_INTERVAL_MS));
  }
}

function buildTextPreview(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  if (normalized.length <= 512) return normalized;
  return `${normalized.slice(0, 256)}...[${normalized.length - 512} chars omitted]...${normalized.slice(-256)}`;
}
