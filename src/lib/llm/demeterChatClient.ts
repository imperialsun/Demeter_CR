import logger from "@/lib/logger";
import { backendFetch, handleBackendUnauthorized, parseBackendHttpError } from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import type { GenerationStrategy } from "@/lib/llm/hfClient";

const MIN_CONTEXT_RETRY_TOKENS = 1024;

type ErrorWithStatus = Error & { status?: number };

export interface GenerateWithDemeterChatParams {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseMode?: "json" | "text";
  maxRetries?: number;
  initialBackoffMs?: number;
  maxContextRetries?: number;
}

export interface GenerateWithDemeterChatResult {
  text: string;
  strategy: GenerationStrategy;
}

export async function generateWithDemeterChat(
  params: GenerateWithDemeterChatParams
): Promise<GenerateWithDemeterChatResult> {
  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID Demeter Santé manquant.");
  }

  const temperature = sanitizeTemperature(params.temperature);
  const responseMode = params.responseMode ?? "json";
  const maxRetries = params.maxRetries ?? 2;
  const initialBackoffMs = params.initialBackoffMs ?? 700;
  const maxContextRetries = Math.max(0, params.maxContextRetries ?? 3);

  let currentMaxTokens = sanitizeMaxTokens(params.maxTokens);
  let contextRetryCount = 0;

  while (true) {
    try {
      const payload = await withRetry(
        async () =>
          requestDemeterChat({
            modelId,
            systemPrompt: params.systemPrompt,
            userPrompt: buildUserPrompt(params.userPrompt, responseMode),
            temperature,
            maxTokens: currentMaxTokens,
            responseMode,
          }),
        maxRetries,
        initialBackoffMs
      );

      const content = extractChatContent(payload);
      if (!content) {
        throw new Error("Le modèle Demeter Santé a retourné une réponse vide.");
      }

      logger.info("[llm-api][demeter] chat success", {
        modelId,
        responseMode,
        usedMaxTokens: currentMaxTokens,
        textLength: content.length,
      });

      return { text: content, strategy: "chatCompletion" };
    } catch (error) {
      if (
        contextRetryCount < maxContextRetries &&
        currentMaxTokens > MIN_CONTEXT_RETRY_TOKENS &&
        isContextLimitError(error)
      ) {
        const nextTokens = Math.max(MIN_CONTEXT_RETRY_TOKENS, Math.floor(currentMaxTokens / 2));
        if (nextTokens === currentMaxTokens) {
          throw error;
        }
        contextRetryCount += 1;
        currentMaxTokens = nextTokens;
        continue;
      }
      throw error;
    }
  }
}

async function requestDemeterChat(params: {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseMode: "json" | "text";
}): Promise<unknown> {
  const body: Record<string, unknown> = {
    model: params.modelId,
    messages: [
      { role: "system", content: params.systemPrompt },
      { role: "user", content: params.userPrompt },
    ],
    temperature: params.temperature,
    max_tokens: params.maxTokens,
  };
  if (params.responseMode === "json") {
    body.response_format = { type: "json_object" };
  }

  const request = () =>
    backendFetch("/providers/demeter-sante/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

  let response = await request();
  if (!response.ok && response.status === 401) {
    const unauthorizedError = await parseBackendHttpError(response, "/providers/demeter-sante/chat/completions", "POST");
    logger.warn("[llm-api][demeter] unauthorized, attempting refresh before retry");
    try {
      const refreshed = await backendRefresh();
      if (!refreshed) {
        handleBackendUnauthorized(unauthorizedError);
        throw unauthorizedError;
      }
    } catch (refreshError) {
      logger.warn("[llm-api][demeter] refresh request failed", {
        message: refreshError instanceof Error ? refreshError.message : String(refreshError),
      });
      throw new Error(`Impossible de renouveler la session backend Demeter Santé. ${toErrorMessage(refreshError)}`);
    }

    response = await request();
  }

  if (!response.ok) {
    const error = await parseBackendHttpError(response, "/providers/demeter-sante/chat/completions", "POST");
    if ((error as ErrorWithStatus).status === 401) {
      handleBackendUnauthorized(error);
    }
    throw error;
  }

  return response.json();
}

async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number,
  initialBackoffMs: number
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = initialBackoffMs * 2 ** attempt;
      attempt += 1;
      await sleep(delayMs);
    }
  }
}

function extractChatContent(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const record = response as Record<string, unknown>;
  const direct = normalizeTextContent(record.output_text ?? record.generated_text ?? record.content);
  if (direct) return direct;

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const firstChoice = choices[0];
  if (!firstChoice || typeof firstChoice !== "object") return "";
  const firstRecord = firstChoice as Record<string, unknown>;

  const choiceText = normalizeTextContent(firstRecord.text);
  if (choiceText) return choiceText;

  const message = firstRecord.message;
  if (!message || typeof message !== "object") return "";
  return normalizeTextContent((message as Record<string, unknown>).content);
}

function normalizeTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (typeof part === "string") return part.trim();
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        const text = record.text;
        return typeof text === "string" ? text.trim() : "";
      })
      .filter((part) => part.length > 0);
    return textParts.join("\n").trim();
  }

  if (content && typeof content === "object") {
    const maybeText = (content as Record<string, unknown>).text;
    if (typeof maybeText === "string") return maybeText.trim();
  }

  return "";
}

function sanitizeTemperature(value: number): number {
  if (!Number.isFinite(value)) return 0.2;
  return Math.max(0, Math.min(2, value));
}

function sanitizeMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 2048;
  return Math.max(MIN_CONTEXT_RETRY_TOKENS, Math.min(131072, Math.round(value)));
}

function isRetryableError(error: unknown): boolean {
  const status = extractStatus(error);
  if (status === 429 || status === 503) return true;

  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("503") ||
    message.includes("rate limit") ||
    message.includes("temporarily unavailable")
  );
}

function isContextLimitError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase();
  return (
    message.includes("context") ||
    message.includes("max_tokens") ||
    message.includes("maximum tokens") ||
    message.includes("too many tokens") ||
    message.includes("token limit") ||
    message.includes("prompt is too long")
  );
}

function extractStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || !error) return undefined;
  return (error as ErrorWithStatus).status;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function buildUserPrompt(userPrompt: string, responseMode: "json" | "text"): string {
  if (responseMode === "json") {
    return `${userPrompt}\n\nRéponds uniquement avec un objet JSON valide.`;
  }
  return userPrompt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
