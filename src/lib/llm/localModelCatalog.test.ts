import { describe, expect, it } from "vitest";
import {
  DEFAULT_LLM_LOCAL_PROFILE,
  LOCAL_LLM_MODEL_PROFILES,
  clampLocalMaxTokens,
  createDefaultLocalModelSettings,
  createDefaultLocalModelSettingsByProfile,
  getLocalLlmModelProfile,
  resolveLocalLlmBackend,
  resolveLocalLlmBackendCandidates,
  resolveLocalLlmFallbackProfile,
} from "@/lib/llm/localModelCatalog";

describe("localModelCatalog", () => {
  it("defines qwen as default local profile", () => {
    expect(DEFAULT_LLM_LOCAL_PROFILE).toBe("qwen_1_7b");
    expect(getLocalLlmModelProfile(DEFAULT_LLM_LOCAL_PROFILE).modelId).toContain("Qwen3-1.7B");
  });

  it("keeps exactly three local profiles", () => {
    expect(LOCAL_LLM_MODEL_PROFILES.map((model) => model.id)).toEqual(["qwen_0_6b", "qwen_1_7b", "ministral_3_3b"]);
  });

  it("falls back from ministral to qwen", () => {
    expect(resolveLocalLlmFallbackProfile("ministral_3_3b")).toBe("qwen_1_7b");
    expect(resolveLocalLlmFallbackProfile("qwen_0_6b")).toBeNull();
    expect(resolveLocalLlmFallbackProfile("qwen_1_7b")).toBeNull();
  });

  it("allows wasm fallback for ministral profile", () => {
    const ministral = getLocalLlmModelProfile("ministral_3_3b");
    const result = resolveLocalLlmBackend({
      profile: ministral,
      wasmAvailable: true,
      webGpuSupported: false,
    });

    expect(result.backend).toBe("wasm");
    expect(result.error).toBeUndefined();
  });

  it("prefers webgpu then wasm in automatic backend order", () => {
    const qwen = getLocalLlmModelProfile("qwen_1_7b");
    expect(resolveLocalLlmBackendCandidates({ profile: qwen, webGpuSupported: true, wasmAvailable: true })).toEqual([
      "webgpu",
      "wasm",
    ]);
    expect(resolveLocalLlmBackendCandidates({ profile: qwen, webGpuSupported: false, wasmAvailable: true })).toEqual([
      "wasm",
    ]);
  });

  it("clamps max tokens to model limit", () => {
    const qwen = getLocalLlmModelProfile("qwen_1_7b");
    expect(clampLocalMaxTokens(qwen, 999999)).toBe(qwen.maxGenerationTokens);
    expect(clampLocalMaxTokens(qwen, 512)).toBe(512);
  });

  it("builds default local settings for each profile", () => {
    const qwenLight = createDefaultLocalModelSettings("qwen_0_6b");
    const qwen = createDefaultLocalModelSettings("qwen_1_7b");
    const ministral = createDefaultLocalModelSettings("ministral_3_3b");

    expect(qwenLight.modelId).toContain("Qwen3-0.6B");
    expect(qwenLight.appendNoThinkDirective).toBe(true);
    expect(qwen.modelId).toContain("Qwen3-1.7B");
    expect(qwen.appendNoThinkDirective).toBe(true);
    expect(ministral.modelId).toContain("Ministral-3-3B");
    expect(qwenLight.maxTokens).toBe(getLocalLlmModelProfile("qwen_0_6b").maxGenerationTokens);
    expect(qwen.maxTokens).toBe(getLocalLlmModelProfile("qwen_1_7b").maxGenerationTokens);
    expect(ministral.maxTokens).toBe(getLocalLlmModelProfile("ministral_3_3b").maxGenerationTokens);
  });

  it("exposes defaults by profile map", () => {
    const defaults = createDefaultLocalModelSettingsByProfile();
    expect(defaults.qwen_0_6b.modelId).toContain("Qwen3-0.6B");
    expect(defaults.qwen_1_7b.modelId).toContain("Qwen3-1.7B");
    expect(defaults.ministral_3_3b.modelId).toContain("Ministral-3-3B");
  });
});
