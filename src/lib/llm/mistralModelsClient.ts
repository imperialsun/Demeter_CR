import logger from "@/lib/logger";
import { MIN_REPORT_GENERATION_TOKENS, TOKEN_RESERVE_FOR_PROMPTS } from "@/lib/llm/modelCatalog";

export const DEFAULT_MISTRAL_LLM_MODEL_ID = "mistral-medium-latest";
export const MISTRAL_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
export const FALLBACK_MISTRAL_MAX_TOKENS = 8192;

export interface MistralModelMetadata {
  id: string;
  maxContextTokens?: number;
  supportsChat: boolean;
}

export interface FetchMistralModelsParams {
  apiUrl: string;
  apiKey: string;
  forceRefresh?: boolean;
}

const DEFAULT_MISTRAL_API_URL = "https://api.mistral.ai";
const modelCache = new Map<string, { expiresAt: number; models: MistralModelMetadata[] }>();

export async function fetchMistralModels(params: FetchMistralModelsParams): Promise<MistralModelMetadata[]> {
  const apiKey = params.apiKey.trim();
  if (!apiKey) {
    throw new Error("Token API Mistral manquant");
  }

  const baseUrl = normalizeApiUrl(params.apiUrl);
  const cacheKey = `${baseUrl}::${apiKey}`;
  const now = Date.now();
  const cached = modelCache.get(cacheKey);
  if (!params.forceRefresh && cached && cached.expiresAt > now) {
    logger.info("[llm-api][mistral] models cache hit", {
      apiUrl: baseUrl,
      modelCount: cached.models.length,
    });
    return cached.models;
  }

  const endpoint = `${baseUrl}/v1/models`;
  logger.info("[llm-api][mistral] models request start", {
    endpoint,
    forceRefresh: params.forceRefresh ?? false,
  });
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiError(raw);
    throw new Error(`Mistral API (${response.status}): ${message}`);
  }

  const payload = (await response.json()) as unknown;
  const models = parseMistralModels(payload);
  modelCache.set(cacheKey, {
    models,
    expiresAt: now + MISTRAL_MODELS_CACHE_TTL_MS,
  });
  logger.info("[llm-api][mistral] models request success", {
    endpoint,
    modelCount: models.length,
  });
  return models;
}

export async function fetchMistralModelsSafe(params: FetchMistralModelsParams): Promise<MistralModelMetadata[]> {
  try {
    return await fetchMistralModels(params);
  } catch (error) {
    logger.warn("[llm-api][mistral] unable to load model metadata", {
      message: toErrorMessage(error),
    });
    return [];
  }
}

export function findMistralModelMetadata(
  models: MistralModelMetadata[],
  modelId: string
): MistralModelMetadata | undefined {
  const trimmed = modelId.trim();
  if (!trimmed) return undefined;
  return models.find((model) => model.id === trimmed) ?? models.find((model) => model.id.toLowerCase() === trimmed.toLowerCase());
}

export function resolveMistralMaxTokens(
  modelMetadata: MistralModelMetadata | undefined,
  reserveTokens = TOKEN_RESERVE_FOR_PROMPTS
): number {
  const contextTokens = modelMetadata?.maxContextTokens;
  if (!Number.isFinite(contextTokens)) {
    return FALLBACK_MISTRAL_MAX_TOKENS;
  }
  return Math.max(MIN_REPORT_GENERATION_TOKENS, Math.floor((contextTokens as number) - reserveTokens));
}

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_MISTRAL_API_URL;
  return trimmed.replace(/\/+$/, "");
}

function parseMistralModels(payload: unknown): MistralModelMetadata[] {
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  const data = Array.isArray(record.data) ? record.data : [];
  const result: MistralModelMetadata[] = [];

  for (const entry of data) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const item = entry as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;
    const capabilities =
      item.capabilities && typeof item.capabilities === "object" && !Array.isArray(item.capabilities)
        ? (item.capabilities as Record<string, unknown>)
        : undefined;

    const maxContextTokens =
      toPositiveInteger(item.max_context_length) ??
      toPositiveInteger(capabilities?.max_context_length) ??
      toPositiveInteger(item.context_length) ??
      toPositiveInteger(capabilities?.context_length);

    const supportsChat =
      toBoolean(capabilities?.completion_chat) ??
      toBoolean(capabilities?.chat_completions) ??
      toBoolean(capabilities?.chat) ??
      true;

    if (!supportsChat) {
      continue;
    }

    result.push({
      id,
      maxContextTokens,
      supportsChat,
    });
  }

  return result;
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

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value !== "boolean") return undefined;
  return value;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
