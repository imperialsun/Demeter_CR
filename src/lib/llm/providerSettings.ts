import type { LlmApiProvider } from "@/store/asr-store";

export const DEMETER_SANTE_MAX_TOKENS = 131072;

export interface LlmProviderPipelineConfig {
  modelId: string;
  temperature: number;
  maxTokens: number;
}

export interface LlmProviderPipelineConfigSource {
  llmApiHfModelId: string;
  llmApiHfTemperature: number;
  llmApiHfMaxTokens: number;
  llmApiMistralModelId: string;
  llmApiMistralTemperature: number;
  llmApiMistralMaxTokens: number;
}

export function resolveActiveLlmPipelineConfig(
  source: LlmProviderPipelineConfigSource,
  provider: LlmApiProvider
): LlmProviderPipelineConfig {
  if (provider === "demeter_sante") {
    return {
      modelId: source.llmApiMistralModelId,
      temperature: source.llmApiMistralTemperature,
      maxTokens: DEMETER_SANTE_MAX_TOKENS,
    };
  }

  if (provider === "mistral") {
    return {
      modelId: source.llmApiMistralModelId,
      temperature: source.llmApiMistralTemperature,
      maxTokens: source.llmApiMistralMaxTokens,
    };
  }

  return {
    modelId: source.llmApiHfModelId,
    temperature: source.llmApiHfTemperature,
    maxTokens: source.llmApiHfMaxTokens,
  };
}
