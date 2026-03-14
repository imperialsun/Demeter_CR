import { describe, expect, it } from "vitest";

import { DEMETER_SANTE_MAX_TOKENS, resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";

describe("resolveActiveLlmPipelineConfig", () => {
  const source = {
    llmApiHfModelId: "openai/gpt-oss-20b",
    llmApiHfTemperature: 0.1,
    llmApiHfMaxTokens: 4096,
    llmApiMistralModelId: "mistral-medium-latest",
    llmApiMistralTemperature: 0.2,
    llmApiMistralMaxTokens: 8192,
  };

  it("keeps mistral max tokens configurable", () => {
    expect(resolveActiveLlmPipelineConfig(source, "mistral")).toEqual({
      modelId: "mistral-medium-latest",
      temperature: 0.2,
      maxTokens: 8192,
    });
  });

  it("forces demeter max tokens to 128K", () => {
    expect(resolveActiveLlmPipelineConfig(source, "demeter_sante")).toEqual({
      modelId: "mistral-medium-latest",
      temperature: 0.2,
      maxTokens: DEMETER_SANTE_MAX_TOKENS,
    });
  });
});