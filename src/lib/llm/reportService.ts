import {
  buildCustomReportUserPrompt,
  buildReportSystemPromptWithSource,
  buildReportUserPrompt,
} from "@/lib/llm/reportPrompts";
import { parseReportJson, type ReportFormat, type ReportJson } from "@/lib/llm/reportSchema";
import type { ReportDetailLevel } from "@/lib/llm/reportDetail";
import {
  generateWithChatThenFallbackText,
  getLlmHfClient,
  type GenerationStrategy,
} from "@/lib/llm/hfClient";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";
import {
  buildClarificationSystemPrompt,
  buildClarificationUserPrompt,
  normalizeReportSourceKind,
  parseReportClarificationJson,
  type ReportClarification,
  type ReportClarificationGeneration,
  type ReportSourceKind,
} from "@/lib/llm/reportClarification";
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
  sourceKind?: ReportSourceKind;
  template?: {
    id: string;
    name: string;
    instructions: string;
    exampleOutline?: string;
  };
  signal?: AbortSignal;
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
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
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
    templateId?: string;
    templateName?: string;
    raw?: string;
    report?: ReportJson;
    kind?: string;
    clarification?: ReportClarification;
  };
};

const DEMETER_REPORT_REQUEST_TIMEOUT_MS = 10 * 60_000;
const DEMETER_REPORT_POLL_INTERVAL_MS = 10_000;
const DEMETER_REPORT_POLL_TIMEOUT_MS = 6 * 60 * 60_000;
const DEMETER_REPORT_INVALID_JSON_MAX_ATTEMPTS = 3;

export function isReportOperationCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createReportOperationAbortError(): Error {
  const error = new Error("L'opération Demeter a été annulée.");
  error.name = "AbortError";
  return error;
}

function throwIfReportOperationCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createReportOperationAbortError();
  }
}

async function waitForDemeterPoll(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfReportOperationCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const timerId = globalThis.setTimeout(resolve, delayMs);
    const onAbort = () => {
      globalThis.clearTimeout(timerId);
      reject(createReportOperationAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal) {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", cleanup, { once: true });
      globalThis.setTimeout(cleanup, delayMs);
    }
  });
}

async function cancelDemeterReportQueueOperation(operationId: string): Promise<void> {
  try {
    await backendFetch(`/providers/demeter-sante/report/operations/${encodeURIComponent(operationId)}`, {
      method: "DELETE",
      timeoutMs: DEMETER_REPORT_REQUEST_TIMEOUT_MS,
      retryAttempts: 0,
      allowSessionRefresh: false,
    });
  } catch {
    // Cancellation is best effort after the local operation has already been
    // interrupted. The backend worker still enforces terminal cancellation.
  }
}

type DemeterQueueRunOptions<T> = {
  submitBody: Record<string, unknown>;
  signal?: AbortSignal;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  parseCompleted: (snapshot: DemeterReportOperationResponse) => T;
  buildFailure: (snapshot: DemeterReportOperationResponse) => Error;
};

async function runDemeterQueueOperation<T>(options: DemeterQueueRunOptions<T>): Promise<T> {
  const submitPath = "/providers/demeter-sante/report/operations";
  let operationId = "";
  let terminal = false;
  let cancellationPromise: Promise<void> | null = null;
  const requestCancellation = () => {
    if (!operationId) return Promise.resolve();
    cancellationPromise ??= cancelDemeterReportQueueOperation(operationId);
    return cancellationPromise;
  };
  const onAbort = () => {
    void requestCancellation();
  };

  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    throwIfReportOperationCancelled(options.signal);
    const submit = () =>
      backendFetch(submitPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options.submitBody),
        timeoutMs: DEMETER_REPORT_REQUEST_TIMEOUT_MS,
        signal: options.signal,
      });

    let submitResponse = await submit();
    if (!submitResponse.ok && submitResponse.status === 401) {
      const refreshResult = await backendRefresh();
      throwIfReportOperationCancelled(options.signal);
      if (refreshResult === "expired") throw new BackendSessionExpiredError();
      if (refreshResult === "failed") {
        throw new Error("Impossible de renouveler la session backend Demeter Santé.");
      }
      submitResponse = await submit();
    }
    if (!submitResponse.ok) {
      const error = await parseBackendHttpError(submitResponse, submitPath, "POST");
      if ((error as Error & { status?: number }).status === 401) handleBackendUnauthorized(error);
      throw error;
    }

    const submitPayload = (await submitResponse.json()) as DemeterReportOperationResponse;
    operationId = submitPayload.operationId?.trim() ?? "";
    if (!operationId) throw new Error("Réponse backend invalide: operationId manquant.");

    const pollStartedAt = Date.now();
    while (true) {
      throwIfReportOperationCancelled(options.signal);
      if (Date.now() - pollStartedAt > options.pollTimeoutMs) {
        throw new Error("Le traitement du rapport a dépassé le délai maximal.");
      }

      const statusPath = `${submitPath}/${encodeURIComponent(operationId)}`;
      const statusResponse = await backendFetch(statusPath, {
        method: "GET",
        timeoutMs: DEMETER_REPORT_REQUEST_TIMEOUT_MS,
        signal: options.signal,
      });
      if (!statusResponse.ok) {
        const error = await parseBackendHttpError(statusResponse, statusPath, "GET");
        if ((error as Error & { status?: number }).status === 401) handleBackendUnauthorized(error);
        throw error;
      }

      const snapshot = (await statusResponse.json()) as DemeterReportOperationResponse;
      if (snapshot.status === "completed") {
        terminal = true;
        return options.parseCompleted(snapshot);
      }
      if (snapshot.status === "failed" || snapshot.status === "cancelled") {
        terminal = true;
        throw options.buildFailure(snapshot);
      }
      await waitForDemeterPoll(options.pollIntervalMs, options.signal);
    }
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (operationId && !terminal) {
      await requestCancellation();
    }
  }
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
  logger.info("[llm-api][report-service] Génération standard · démarrage", {
    provider: params.provider,
    format: params.format,
    templateId: params.template?.id,
    modelId,
    detailLevel: params.detailLevel ?? "standard",
    sourceLength: sourceText.length,
  });

  const userPrompt = params.template
    ? buildCustomReportUserPrompt({
        format: params.format,
        sourceText,
        detailLevel: params.detailLevel,
        templateName: params.template.name,
        instructions: params.template.instructions,
        exampleOutline: params.template.exampleOutline,
        sourceKind: params.sourceKind,
      })
    : buildReportUserPrompt(params.format, sourceText, params.detailLevel, {
        sourceKind: params.sourceKind,
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
      systemPrompt: buildReportSystemPromptWithSource(params.detailLevel, params.sourceKind),
      userPrompt,
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
      systemPrompt: buildReportSystemPromptWithSource(params.detailLevel, params.sourceKind),
      userPrompt,
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
      sourceKind: params.sourceKind,
      templateId: params.template?.id,
      pollTimeoutMs: params.pollTimeoutMs,
      pollIntervalMs: params.pollIntervalMs,
      signal: params.signal,
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
    report: params.template ? { ...report, title: `${params.template.name} - ${report.title}` } : report,
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
  sourceKind?: ReportSourceKind;
  templateId?: string;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<GenerateReportDetailedResult> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DEMETER_REPORT_INVALID_JSON_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await runDemeterReportQueueOperation(params, attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= DEMETER_REPORT_INVALID_JSON_MAX_ATTEMPTS || !isRetryableInvalidReportPayloadError(error)) {
        throw error;
      }
      logger.warn("[llm-api][report-service] Demeter report payload invalide · nouvel essai", {
        provider: "demeter_sante",
        format: params.format,
        modelId: params.modelId,
        detailLevel: params.detailLevel ?? "standard",
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts: DEMETER_REPORT_INVALID_JSON_MAX_ATTEMPTS,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "La génération du rapport a échoué."));
}

async function runDemeterReportQueueOperation(
  params: {
    format: ReportFormat;
    modelId: string;
    sourceText: string;
    temperature: number;
    maxTokens: number;
    detailLevel?: ReportDetailLevel;
    sourceKind?: ReportSourceKind;
    templateId?: string;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    signal?: AbortSignal;
  },
  attempt: number
): Promise<GenerateReportDetailedResult> {
  const submitBody = {
    format: params.format,
    modelId: params.modelId,
    sourceText: params.sourceText,
    temperature: params.temperature,
    maxTokens: params.maxTokens,
    detailLevel: params.detailLevel ?? "standard",
    operationType: "report",
    sourceKind: normalizeReportSourceKind(params.sourceKind),
    templateId: params.templateId,
  };

  logger.info("[llm-api][report-service] Demeter report queue · tentative", {
    provider: "demeter_sante",
    format: params.format,
    modelId: params.modelId,
    detailLevel: params.detailLevel ?? "standard",
    attempt,
    maxAttempts: DEMETER_REPORT_INVALID_JSON_MAX_ATTEMPTS,
  });

  return runDemeterQueueOperation({
    submitBody,
    signal: params.signal,
    pollTimeoutMs: params.pollTimeoutMs ?? DEMETER_REPORT_POLL_TIMEOUT_MS,
    pollIntervalMs: params.pollIntervalMs ?? DEMETER_REPORT_POLL_INTERVAL_MS,
    parseCompleted: (snapshot) => {
      const report = snapshot.response?.report;
      if (!report) throw new Error("Le backend a terminé sans renvoyer de rapport.");
      return {
        report,
        rawResponse: snapshot.response?.raw ?? "",
        strategy: "chatCompletion" as const,
      };
    },
    buildFailure: (snapshot) => {
      if (snapshot.status === "cancelled") return new Error("La génération du rapport a été annulée.");
      return new Error(formatDemeterReportQueueError(snapshot));
    },
  });
}

type AnalyzeReportSourceBaseParams = {
  modelId: string;
  sourceText: string;
  sourceKind?: ReportSourceKind;
  temperature?: number;
  maxTokens?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type AnalyzeReportSourceParams =
  | (AnalyzeReportSourceBaseParams & {
      provider: "huggingface";
      hfToken: string;
    })
  | (AnalyzeReportSourceBaseParams & {
      provider: "mistral";
      mistralApiKey: string;
      mistralApiUrl: string;
    })
  | (AnalyzeReportSourceBaseParams & {
      provider: "demeter_sante";
    });

export async function analyzeReportSource(
  params: AnalyzeReportSourceParams
): Promise<ReportClarificationGeneration> {
  const modelId = params.modelId.trim();
  if (!modelId) throw new Error("Model ID manquant.");
  const sourceText = params.sourceText.trim();
  if (!sourceText) throw new Error("Source vide pour l'analyse de clarification.");

  const sourceKind = normalizeReportSourceKind(params.sourceKind);
  const temperature = params.temperature ?? 0;
  const maxTokens = params.maxTokens ?? 512;
  logger.info("[llm-api][report-service] Analyse de clarification · démarrage", {
    provider: params.provider,
    modelId,
    sourceKind,
    sourceLength: sourceText.length,
  });

  if (params.provider === "demeter_sante") {
    return runDemeterClarificationQueueOperation({
      modelId,
      sourceText,
      sourceKind,
      temperature: 0,
      maxTokens,
      pollTimeoutMs: params.pollTimeoutMs,
      pollIntervalMs: params.pollIntervalMs,
      signal: params.signal,
    });
  }

  let generation: { text: string; strategy: GenerationStrategy };
  if (params.provider === "huggingface") {
    const token = params.hfToken.trim();
    if (!token) throw new Error("Token Hugging Face manquant.");
    const client = await getLlmHfClient(token);
    generation = await generateWithChatThenFallbackText({
      client,
      modelId,
      systemPrompt: buildClarificationSystemPrompt(sourceKind),
      userPrompt: buildClarificationUserPrompt(sourceText, sourceKind),
      temperature,
      maxTokens,
      responseMode: "json",
    });
  } else {
    const apiKey = params.mistralApiKey.trim();
    if (!apiKey) throw new Error("Token API Mistral manquant.");
    generation = await generateWithMistralChat({
      apiUrl: params.mistralApiUrl,
      apiKey,
      modelId,
      systemPrompt: buildClarificationSystemPrompt(sourceKind),
      userPrompt: buildClarificationUserPrompt(sourceText, sourceKind),
      temperature,
      maxTokens,
      responseMode: "json",
    });
  }

  const clarification = parseReportClarificationJson(generation.text);
  logger.info("[llm-api][report-service] Analyse de clarification · réponse reçue", {
    provider: params.provider,
    modelId,
    sourceKind,
    responseLength: generation.text.length,
    questionCount: clarification.questions.length,
  });
  return {
    clarification,
    rawResponse: generation.text,
    strategy: generation.strategy,
  };
}

async function runDemeterClarificationQueueOperation(params: {
  modelId: string;
  sourceText: string;
  sourceKind: ReportSourceKind;
  temperature: number;
  maxTokens: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}): Promise<ReportClarificationGeneration> {
  const submitBody = {
    operationType: "clarification",
    sourceText: params.sourceText,
    sourceKind: params.sourceKind,
    modelId: params.modelId,
    temperature: 0,
    maxTokens: params.maxTokens,
  };
  return runDemeterQueueOperation({
    submitBody,
    signal: params.signal,
    pollTimeoutMs: params.pollTimeoutMs ?? DEMETER_REPORT_POLL_TIMEOUT_MS,
    pollIntervalMs: params.pollIntervalMs ?? DEMETER_REPORT_POLL_INTERVAL_MS,
    parseCompleted: (snapshot) => {
      const clarification = snapshot.response?.clarification;
      if (!clarification) {
        throw new Error("Le backend a terminé sans renvoyer l'analyse de clarification.");
      }
      return {
        clarification: parseReportClarificationJson(JSON.stringify(clarification)),
        rawResponse: snapshot.response?.raw ?? "",
        strategy: "chatCompletion" as const,
      };
    },
    buildFailure: (snapshot) => {
      if (snapshot.status === "cancelled") return new Error("L'analyse de clarification a été annulée.");
      return new Error(formatDemeterReportQueueError(snapshot));
    },
  });
}

function isRetryableInvalidReportPayloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const normalized = message.toLowerCase();
  return (
    normalized.includes("invalid report payload") ||
    normalized.includes("invalid json response") ||
    normalized.includes("no usable sections returned")
  );
}

function formatDemeterReportQueueError(snapshot: DemeterReportOperationResponse): string {
  const raw = snapshot.lastError?.trim() ?? "";
  const normalized = raw.toLowerCase();
  if (
    snapshot.statusCode === 429 ||
    normalized.includes("rate limit") ||
    normalized.includes("rate_limited") ||
    normalized.includes("mistral api (429)") ||
    normalized.includes("\"raw_status_code\":429")
  ) {
    return "Limite Mistral atteinte (429). Patientez quelques minutes, réduisez le parallélisme de la Queue Rapport, ou augmentez le quota Mistral avant de relancer.";
  }
  if (
    snapshot.statusCode === 503 ||
    normalized.includes("capacity exceeded") ||
    normalized.includes("temporarily unavailable")
  ) {
    return "Mistral est temporairement saturé. Patientez quelques minutes puis relancez la génération.";
  }
  return raw || "La génération du rapport a échoué.";
}

function buildTextPreview(text: string): string {
  const normalized = text.trim();
  if (!normalized) return "";
  if (normalized.length <= 512) return normalized;
  return `${normalized.slice(0, 256)}...[${normalized.length - 512} chars omitted]...${normalized.slice(-256)}`;
}
