export interface SuggestedReportModel {
  id: string;
  label: string;
  contextWindowTokens: number;
  maxGenerationTokens?: number;
}

export interface ModelTokenBudget {
  contextWindowTokens?: number;
  modelMaxGenerationTokens?: number;
  effectiveMaxGenerationTokens?: number;
  blockedByContext: boolean;
}

export interface RuntimeModelLimits {
  contextWindowTokens?: number;
  maxGenerationTokens?: number;
}

export interface LongInputChunkingProfile {
  contextWindowTokens: number;
  outputReserveTokens: number;
  sourceBudgetTokens: number;
  thresholdTokens: number;
  chunkTokens: number;
  chunkOverlapTokens: number;
  contextEstimated: boolean;
}

export const MIN_REPORT_GENERATION_TOKENS = 128;
export const TOKEN_RESERVE_FOR_PROMPTS = 512;
const MIN_FALLBACK_CONTEXT_TOKENS = 8_192;
const MAX_CHUNK_TOKENS = 6_000;
const MIN_CHUNK_TOKENS = 800;
const MIN_THRESHOLD_TOKENS = 512;

export const SUGGESTED_REPORT_MODELS: SuggestedReportModel[] = [
  {
    id: "openai/gpt-oss-120b",
    label: "OpenAI OSS 120B",
    contextWindowTokens: 131_072,
    maxGenerationTokens: 131_072,
  },
  {
    id: "openai/gpt-oss-20b",
    label: "OpenAI OSS 20B",
    contextWindowTokens: 131_072,
    maxGenerationTokens: 131_072,
  },
  {
    id: "meta-llama/Llama-3.1-70B-Instruct",
    label: "Llama 3.1 70B Instruct",
    contextWindowTokens: 128_000,
  },
];

const MODEL_BY_ID = new Map<string, SuggestedReportModel>(
  SUGGESTED_REPORT_MODELS.map((model) => [model.id, model])
);

export function findSuggestedReportModel(modelId: string): SuggestedReportModel | undefined {
  const id = modelId.trim();
  if (!id) return undefined;
  return MODEL_BY_ID.get(id);
}

export function resolveSuggestedModelMaxTokens(
  modelId: string,
  runtimeLimits?: RuntimeModelLimits
): number | undefined {
  const resolved = resolveModelLimits(modelId, runtimeLimits);
  if (!resolved) return undefined;

  const modelDeclaredMax =
    typeof resolved.maxGenerationTokens === "number"
      ? resolved.maxGenerationTokens
      : resolved.contextWindowTokens - TOKEN_RESERVE_FOR_PROMPTS;

  return Math.max(MIN_REPORT_GENERATION_TOKENS, Math.floor(modelDeclaredMax));
}

export function resolveModelTokenBudget(params: {
  modelId: string;
  sourceTokens: number;
  runtimeLimits?: RuntimeModelLimits;
}): ModelTokenBudget {
  const resolved = resolveModelLimits(params.modelId, params.runtimeLimits);
  if (!resolved) {
    return { blockedByContext: false };
  }

  const sourceTokens = Number.isFinite(params.sourceTokens) ? Math.max(0, Math.round(params.sourceTokens)) : 0;
  const contextBudget = Math.max(0, resolved.contextWindowTokens - sourceTokens - TOKEN_RESERVE_FOR_PROMPTS);
  const cappedByModel =
    typeof resolved.maxGenerationTokens === "number"
      ? Math.min(contextBudget, resolved.maxGenerationTokens)
      : contextBudget;

  return {
    contextWindowTokens: resolved.contextWindowTokens,
    modelMaxGenerationTokens: resolved.maxGenerationTokens,
    effectiveMaxGenerationTokens: Math.max(MIN_REPORT_GENERATION_TOKENS, Math.floor(cappedByModel)),
    blockedByContext: contextBudget < MIN_REPORT_GENERATION_TOKENS,
  };
}

export function formatTokenCount(value: number): string {
  const rounded = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  return new Intl.NumberFormat("fr-FR").format(rounded);
}

export function resolveLongInputChunkingProfile(params: {
  modelId: string;
  configuredMaxTokens: number;
  runtimeLimits?: RuntimeModelLimits;
}): LongInputChunkingProfile {
  const resolved = resolveModelLimits(params.modelId, params.runtimeLimits);
  const configuredMaxTokens = normalizeConfiguredMaxTokens(params.configuredMaxTokens);

  const contextWindowTokens = resolved
    ? resolved.contextWindowTokens
    : Math.max(MIN_FALLBACK_CONTEXT_TOKENS, configuredMaxTokens * 4 + TOKEN_RESERVE_FOR_PROMPTS);

  const modelOutputLimit = resolved?.maxGenerationTokens;
  const outputReserveTokens = Math.max(
    1_024,
    Math.min(8_192, typeof modelOutputLimit === "number" ? modelOutputLimit : configuredMaxTokens)
  );

  const rawSourceBudget = contextWindowTokens - TOKEN_RESERVE_FOR_PROMPTS - outputReserveTokens;
  const sourceBudgetTokens = Math.max(MIN_THRESHOLD_TOKENS, Math.floor(rawSourceBudget));
  const thresholdTokens = Math.max(MIN_THRESHOLD_TOKENS, Math.floor(sourceBudgetTokens * 0.92));

  let chunkTokens = Math.floor(sourceBudgetTokens * 0.4);
  chunkTokens = clamp(chunkTokens, MIN_CHUNK_TOKENS, MAX_CHUNK_TOKENS);
  if (chunkTokens >= thresholdTokens) {
    chunkTokens = Math.max(MIN_CHUNK_TOKENS, Math.floor(thresholdTokens * 0.75));
  }

  const maxOverlap = Math.max(64, chunkTokens - 1);
  const chunkOverlapTokens = clamp(Math.floor(chunkTokens * 0.08), 64, Math.min(800, maxOverlap));

  return {
    contextWindowTokens,
    outputReserveTokens,
    sourceBudgetTokens,
    thresholdTokens,
    chunkTokens,
    chunkOverlapTokens,
    contextEstimated: !resolved,
  };
}

function resolveModelLimits(
  modelId: string,
  runtimeLimits?: RuntimeModelLimits
): { contextWindowTokens: number; maxGenerationTokens?: number } | null {
  const model = findSuggestedReportModel(modelId);
  const runtimeContext = sanitizePositiveInteger(runtimeLimits?.contextWindowTokens);
  const runtimeMaxGeneration = sanitizePositiveInteger(runtimeLimits?.maxGenerationTokens);
  const contextWindowTokens = runtimeContext ?? model?.contextWindowTokens;
  if (typeof contextWindowTokens !== "number") return null;

  const declaredMax = runtimeMaxGeneration ?? model?.maxGenerationTokens;
  const maxGenerationTokens =
    typeof declaredMax === "number" ? Math.max(MIN_REPORT_GENERATION_TOKENS, Math.floor(declaredMax)) : undefined;

  return {
    contextWindowTokens,
    maxGenerationTokens,
  };
}

function normalizeConfiguredMaxTokens(value: number): number {
  if (!Number.isFinite(value)) return 2_048;
  return Math.max(MIN_REPORT_GENERATION_TOKENS, Math.floor(value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sanitizePositiveInteger(value: number | undefined): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value as number);
  return normalized > 0 ? normalized : undefined;
}
