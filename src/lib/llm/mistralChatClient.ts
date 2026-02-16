import logger from "@/lib/logger";
import type { GenerationStrategy } from "@/lib/llm/hfClient";

const DEFAULT_MISTRAL_API_URL = "https://api.mistral.ai";
const MIN_CONTEXT_RETRY_TOKENS = 1024;

type ErrorWithStatus = Error & { status?: number };

export interface GenerateWithMistralChatParams {
  apiUrl: string;
  apiKey: string;
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

export interface GenerateWithMistralChatResult {
  text: string;
  strategy: GenerationStrategy;
}

export async function generateWithMistralChat(
  params: GenerateWithMistralChatParams
): Promise<GenerateWithMistralChatResult> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new Error("Token API Mistral manquant.");
  }

  const modelId = params.modelId.trim();
  if (!modelId) {
    throw new Error("Model ID Mistral manquant.");
  }

  const baseUrl = normalizeApiUrl(params.apiUrl);
  const endpoint = `${baseUrl}/v1/chat/completions`;
  const temperature = sanitizeTemperature(params.temperature);
  const responseMode = params.responseMode ?? "json";
  const maxRetries = params.maxRetries ?? 2;
  const initialBackoffMs = params.initialBackoffMs ?? 700;
  const maxContextRetries = Math.max(0, params.maxContextRetries ?? 3);
  logger.info("[llm-api][mistral] chat start", {
    modelId,
    responseMode,
    maxTokens: params.maxTokens,
    temperature,
    maxRetries,
    maxContextRetries,
  });

  let currentMaxTokens = sanitizeMaxTokens(params.maxTokens);
  let contextRetryCount = 0;

  while (true) {
    try {
      const payload = await withRetry(
        async () =>
          requestMistralChat({
            endpoint,
            apiKey,
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

      const content = extractMistralChatContent(payload);
      if (!content) {
        throw new Error("Le modele a retourne une reponse chat vide.");
      }
      logger.info("[llm-api][mistral] chat success", {
        modelId,
        responseMode,
        usedMaxTokens: currentMaxTokens,
        textLength: content.length,
      });
      return {
        text: content,
        strategy: "chatCompletion",
      };
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
        logger.warn("[llm-api][mistral] retry with reduced max_tokens after context error", {
          modelId,
          attempt: contextRetryCount,
          maxTokens: currentMaxTokens,
          retryMaxTokens: nextTokens,
          reason: toErrorMessage(error),
        });
        currentMaxTokens = nextTokens;
        continue;
      }
      throw error;
    }
  }
}

async function requestMistralChat(params: {
  endpoint: string;
  apiKey: string;
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  responseMode: "json" | "text";
}): Promise<unknown> {
  logger.debug("[llm-api][mistral] request start", {
    endpoint: params.endpoint,
    modelId: params.modelId,
    responseMode: params.responseMode,
    maxTokens: params.maxTokens,
    temperature: params.temperature,
  });
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

  const response = await fetch(params.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const raw = await response.text();
    throw withStatus(new Error(`Mistral API (${response.status}): ${parseApiError(raw)}`), response.status);
  }

  logger.debug("[llm-api][mistral] request success", {
    endpoint: params.endpoint,
    modelId: params.modelId,
    status: response.status,
  });
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
      logger.warn("[llm-api][mistral] retrying request", {
        attempt,
        delayMs,
        reason: toErrorMessage(error),
      });
      await sleep(delayMs);
    }
  }
}

function extractMistralChatContent(response: unknown): string {
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

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_MISTRAL_API_URL;
  return trimmed.replace(/\/+$/, "");
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

function parseApiError(raw: string): string {
  const text = raw.trim();
  if (!text) return "Reponse API vide";
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractApiMessage(parsed) ?? text;
  } catch {
    return text;
  }
}

function extractApiMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (!value || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    const chunks = value.map((entry) => extractApiMessage(entry)).filter((entry): entry is string => Boolean(entry));
    return chunks.length ? chunks.join(" | ") : null;
  }

  const record = value as Record<string, unknown>;
  return (
    extractApiMessage(record.message) ??
    extractApiMessage(record.error) ??
    extractApiMessage(record.detail) ??
    extractApiMessage(record.msg) ??
    null
  );
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const direct = (error as ErrorWithStatus).status;
  return typeof direct === "number" ? direct : undefined;
}

function withStatus(error: Error, status: number): ErrorWithStatus {
  const withCode = error as ErrorWithStatus;
  withCode.status = status;
  return withCode;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUserPrompt(userPrompt: string, responseMode: "json" | "text"): string {
  if (responseMode === "text") return userPrompt;
  return `${userPrompt}\n\nReponds uniquement en JSON valide.`;
}
