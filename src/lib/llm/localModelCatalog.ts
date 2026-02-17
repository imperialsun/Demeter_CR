import type { BackendImplementation, ModelDtype } from "@/store/asr-store";

export type LlmLocalModelProfile = "qwen_1_7b" | "ministral_3_3b";

export interface LocalLlmModelProfile {
  id: LlmLocalModelProfile;
  label: string;
  modelId: string;
  description: string;
  contextWindowTokens: number;
  maxGenerationTokens: number;
  recommendedDtype: Record<BackendImplementation, ModelDtype>;
  allowedBackends: BackendImplementation[];
  heavy: boolean;
  heavyWarning?: string;
  appendNoThinkDirective?: boolean;
}

export interface ResolveLocalLlmBackendParams {
  profile: LocalLlmModelProfile;
  webGpuSupported: boolean;
  wasmAvailable: boolean;
}

export interface ResolveLocalLlmBackendResult {
  backend?: BackendImplementation;
  error?: string;
}

export interface LocalLlmModelSettingsDefaults {
  modelId: string;
  temperature: number;
  maxTokens: number;
  dtypeWebgpu: ModelDtype;
  dtypeWasm: ModelDtype;
  appendNoThinkDirective: boolean;
}

export const DEFAULT_LLM_LOCAL_PROFILE: LlmLocalModelProfile = "qwen_1_7b";
export const DEFAULT_LLM_LOCAL_MODEL_ID = "onnx-community/Qwen3-1.7B-Instruct-2507-ONNX";
export const DEFAULT_LLM_LOCAL_TEMPERATURE = 0.2;
export const DEFAULT_LLM_LOCAL_MAX_TOKENS = 4096;

const MODELS: LocalLlmModelProfile[] = [
  {
    id: "qwen_1_7b",
    label: "Qwen 3 1.7B Instruct",
    modelId: "onnx-community/Qwen3-1.7B-Instruct-2507-ONNX",
    description: "Profil standard local. Bon compromis qualite/latence pour CRI/CRO/CRS.",
    contextWindowTokens: 40_960,
    maxGenerationTokens: 4_096,
    recommendedDtype: {
      webgpu: "q4f16",
      wasm: "q8",
    },
    allowedBackends: ["webgpu", "wasm"],
    heavy: false,
    appendNoThinkDirective: true,
  },
  {
    id: "ministral_3_3b",
    label: "Ministral 3 3B Instruct",
    modelId: "mistralai/Ministral-3-3B-Instruct-2512-ONNX",
    description: "Profil qualite elevee local. Plus lourd; fonctionne en WebGPU et en WASM (plus lent en WASM).",
    contextWindowTokens: 131_072,
    maxGenerationTokens: 8_192,
    recommendedDtype: {
      webgpu: "q4",
      wasm: "q8",
    },
    allowedBackends: ["webgpu", "wasm"],
    heavy: true,
    heavyWarning:
      "Ce modele est volumineux. Sur WASM, le temps de generation peut etre significativement plus long.",
  },
];

const MODEL_BY_ID = new Map<LlmLocalModelProfile, LocalLlmModelProfile>(
  MODELS.map((model) => [model.id, model])
);

export const LOCAL_LLM_MODEL_PROFILES: LocalLlmModelProfile[] = MODELS;

export function findLocalLlmModelProfile(profileId: string | null | undefined): LocalLlmModelProfile | undefined {
  if (!profileId) return undefined;
  return MODEL_BY_ID.get(profileId as LlmLocalModelProfile);
}

export function getLocalLlmModelProfile(profileId: LlmLocalModelProfile): LocalLlmModelProfile {
  return MODEL_BY_ID.get(profileId) ?? MODEL_BY_ID.get(DEFAULT_LLM_LOCAL_PROFILE)!;
}

export function resolveLocalLlmModelId(profileId: LlmLocalModelProfile): string {
  return getLocalLlmModelProfile(profileId).modelId;
}

export function resolveLocalLlmFallbackProfile(profileId: LlmLocalModelProfile): LlmLocalModelProfile | null {
  if (profileId === "ministral_3_3b") return "qwen_1_7b";
  return null;
}

export function resolveLocalLlmBackendCandidates(params: ResolveLocalLlmBackendParams): BackendImplementation[] {
  const candidates: BackendImplementation[] = [];

  if (params.profile.allowedBackends.includes("webgpu") && params.webGpuSupported) {
    candidates.push("webgpu");
  }

  if (params.profile.allowedBackends.includes("wasm") && params.wasmAvailable) {
    candidates.push("wasm");
  }

  return candidates;
}

export function resolveLocalLlmBackend(params: ResolveLocalLlmBackendParams): ResolveLocalLlmBackendResult {
  const candidates = resolveLocalLlmBackendCandidates(params);
  if (candidates.length > 0) {
    return { backend: candidates[0] };
  }

  if (!params.webGpuSupported && !params.wasmAvailable) {
    return {
      error:
        "Aucun backend local disponible (WebGPU indisponible et WASM non detecte). Verifiez la plateforme et les assets /onnx/.",
    };
  }

  return {
    error: "Aucun backend compatible disponible pour le modele local selectionne.",
  };
}

export function resolveLocalLlmDtype(
  profile: LocalLlmModelProfile,
  backend: BackendImplementation,
  overrides: { webgpu?: ModelDtype; wasm?: ModelDtype }
): ModelDtype {
  if (backend === "webgpu") {
    return overrides.webgpu ?? profile.recommendedDtype.webgpu;
  }
  return overrides.wasm ?? profile.recommendedDtype.wasm;
}

export function clampLocalMaxTokens(profile: LocalLlmModelProfile, maxTokens: number): number {
  const safe = Number.isFinite(maxTokens) ? Math.max(128, Math.round(maxTokens)) : DEFAULT_LLM_LOCAL_MAX_TOKENS;
  return Math.min(safe, profile.maxGenerationTokens);
}

export function createDefaultLocalModelSettings(profileId: LlmLocalModelProfile): LocalLlmModelSettingsDefaults {
  const profile = getLocalLlmModelProfile(profileId);

  return {
    modelId: profile.modelId,
    temperature: DEFAULT_LLM_LOCAL_TEMPERATURE,
    maxTokens: profile.maxGenerationTokens,
    dtypeWebgpu: profile.recommendedDtype.webgpu,
    dtypeWasm: profile.recommendedDtype.wasm,
    appendNoThinkDirective: Boolean(profile.appendNoThinkDirective),
  };
}

export function createDefaultLocalModelSettingsByProfile(): Record<LlmLocalModelProfile, LocalLlmModelSettingsDefaults> {
  return {
    qwen_1_7b: createDefaultLocalModelSettings("qwen_1_7b"),
    ministral_3_3b: createDefaultLocalModelSettings("ministral_3_3b"),
  };
}
