import type { LlmApiProvider } from "@/store/asr-store";

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
  if (provider === "mistral" || provider === "demeter_sante") {
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
