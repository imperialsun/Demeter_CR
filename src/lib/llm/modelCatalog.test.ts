import { describe, expect, it } from "vitest";
import {
  findSuggestedReportModel,
  resolveLongInputChunkingProfile,
  MIN_REPORT_GENERATION_TOKENS,
  resolveModelTokenBudget,
  resolveSuggestedModelMaxTokens,
  TOKEN_RESERVE_FOR_PROMPTS,
} from "@/lib/llm/modelCatalog";

describe("modelCatalog", () => {
  it("finds known suggested models", () => {
    const model = findSuggestedReportModel("openai/gpt-oss-120b");
    expect(model?.contextWindowTokens).toBe(131072);
  });

  it("accounts for configured model output limit metadata", () => {
    const budget = resolveModelTokenBudget({
      modelId: "openai/gpt-oss-20b",
      sourceTokens: 1000,
    });

    expect(budget.blockedByContext).toBe(false);
    expect(budget.modelMaxGenerationTokens).toBe(131072);
    expect(budget.effectiveMaxGenerationTokens).toBe(131072 - 1000 - TOKEN_RESERVE_FOR_PROMPTS);
  });

  it("blocks when source exceeds context budget", () => {
    const sourceTokens = 131072 - TOKEN_RESERVE_FOR_PROMPTS;
    const budget = resolveModelTokenBudget({
      modelId: "openai/gpt-oss-120b",
      sourceTokens,
    });

    expect(budget.blockedByContext).toBe(true);
    expect(budget.effectiveMaxGenerationTokens).toBe(MIN_REPORT_GENERATION_TOKENS);
  });

  it("returns open budget for unknown custom model", () => {
    const budget = resolveModelTokenBudget({
      modelId: "custom/org-private-model",
      sourceTokens: 9000,
    });

    expect(budget.blockedByContext).toBe(false);
    expect(budget.effectiveMaxGenerationTokens).toBeUndefined();
  });

  it("resolves max tokens for UI setting from model metadata", () => {
    expect(resolveSuggestedModelMaxTokens("openai/gpt-oss-120b")).toBe(131072);
    expect(resolveSuggestedModelMaxTokens("meta-llama/Llama-3.1-70B-Instruct")).toBe(127488);
    expect(resolveSuggestedModelMaxTokens("custom/model")).toBeUndefined();
  });

  it("adapts long-input chunking to known model context window", () => {
    const profile = resolveLongInputChunkingProfile({
      modelId: "openai/gpt-oss-120b",
      configuredMaxTokens: 131072,
    });

    expect(profile.contextEstimated).toBe(false);
    expect(profile.contextWindowTokens).toBe(131072);
    expect(profile.thresholdTokens).toBeGreaterThan(100000);
    expect(profile.chunkTokens).toBeGreaterThan(4000);
    expect(profile.chunkOverlapTokens).toBeGreaterThanOrEqual(64);
    expect(profile.chunkOverlapTokens).toBeLessThan(profile.chunkTokens);
  });

  it("derives chunking profile for custom models from configured max tokens", () => {
    const profile = resolveLongInputChunkingProfile({
      modelId: "custom/my-model",
      configuredMaxTokens: 2048,
    });

    expect(profile.contextEstimated).toBe(true);
    expect(profile.contextWindowTokens).toBeGreaterThanOrEqual(8192);
    expect(profile.thresholdTokens).toBeGreaterThan(0);
    expect(profile.chunkTokens).toBeGreaterThan(0);
    expect(profile.chunkOverlapTokens).toBeLessThan(profile.chunkTokens);
  });

  it("uses runtime context limits for non-catalogued models", () => {
    const budget = resolveModelTokenBudget({
      modelId: "mistral-medium-latest",
      sourceTokens: 4000,
      runtimeLimits: { contextWindowTokens: 32768 },
    });

    expect(budget.contextWindowTokens).toBe(32768);
    expect(budget.blockedByContext).toBe(false);

    const profile = resolveLongInputChunkingProfile({
      modelId: "mistral-medium-latest",
      configuredMaxTokens: 8192,
      runtimeLimits: { contextWindowTokens: 32768 },
    });

    expect(profile.contextEstimated).toBe(false);
    expect(profile.contextWindowTokens).toBe(32768);
  });
});
