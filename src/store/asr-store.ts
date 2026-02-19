import { create } from "zustand";
import logger from "@/lib/logger";
import {
  loadSettings,
  saveSettings,
  type PersistedSettings,
  DEFAULT_SETTINGS,
} from "@/lib/storage";
import {
  clearSecureTokens,
  loadSecureTokens,
  saveSecureTokens,
  type SecureTokens,
} from "@/lib/secure-token-vault";
import type { AudioMetadata } from "@/lib/audio";
import { computeDefaultOverlap } from "@/lib/chunking";
import type { ChunkDefinition } from "@/lib/chunking";
import type { TranscriptionSegment } from "@/lib/export";
import type { TelemetryCollector, ChunkTelemetry, TelemetrySummary } from "@/lib/telemetry";
import type { ReportResult, ReportResultKey } from "@/lib/llm/reportSchema";
import {
  canonicalizeLocalLlmModelId,
  createDefaultLocalModelSettings,
  createDefaultLocalModelSettingsByProfile,
  DEFAULT_LLM_LOCAL_MAX_TOKENS,
  DEFAULT_LLM_LOCAL_MODEL_ID,
  DEFAULT_LLM_LOCAL_PROFILE,
  DEFAULT_LLM_LOCAL_TEMPERATURE,
  getLocalLlmModelProfile,
  resolveLocalLlmModelId,
} from "@/lib/llm/localModelCatalog";

export type PresetKey = "fast" | "balanced" | "medium" | "quality" | "mms" | "turbo" | "custom";
export type BuiltInPresetKey = Exclude<PresetKey, "custom">;

export type BackendImplementation = "webgpu" | "wasm";
export type ModelDtype = "auto" | "fp32" | "fp16" | "q8" | "q4" | "q4f16" | "int8" | "uint8" | "bnb4";
export type PresetQuantizationOverrides = Partial<
  Record<BuiltInPresetKey, Partial<Record<BackendImplementation, ModelDtype>>>
>;
export type DedupeMode = "normal" | "fuzzy";

const MODEL_DTYPE_VALUES: readonly ModelDtype[] = [
  "auto",
  "fp32",
  "fp16",
  "q8",
  "q4",
  "q4f16",
  "int8",
  "uint8",
  "bnb4",
] as const;
const ALLOWED_MODEL_DTYPES = new Set<ModelDtype>(MODEL_DTYPE_VALUES);

export type PipelineStatus =
  | "idle"
  | "downloading"
  | "loading"
  | "ready"
  | "transcribing"
  | "stopping"
  | "error";

export type CloudTranscriptionStatus =
  | "idle"
  | "preprocessing"
  | "uploading"
  | "transcribing"
  | "stopping"
  | "done"
  | "error";

export type LlmApiStatus = "idle" | "preparing" | "generating" | "formatting" | "done" | "error";
export type LlmApiProvider = "huggingface" | "mistral";
export type LlmLocalModelProfile = "qwen_1_7b" | "ministral_3_3b";
export type ModelSizeForegroundAlert = {
  title: string;
  description: string;
  severity: "warning" | "error";
  signature: string;
};
export interface LlmLocalModelSettings {
  modelId: string;
  temperature: number;
  maxTokens: number;
  dtypeWebgpu: ModelDtype;
  dtypeWasm: ModelDtype;
  appendNoThinkDirective: boolean;
}

export interface ModelPreset {
  key: PresetKey;
  label: string;
  modelId: string;
  description: string;
  quantization: Partial<Record<BackendImplementation, ModelDtype>>;
}

export const MODEL_PRESETS: Record<Exclude<PresetKey, "custom">, ModelPreset> = {
  fast: {
    key: "fast",
    label: "Rapide (Whisper Tiny)",
    modelId: "Xenova/whisper-tiny",
    description: "Latence minimale, qualité correcte pour des itérations rapides.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
  balanced: {
    key: "balanced",
    label: "Équilibre (Whisper Base)",
    modelId: "Xenova/whisper-base",
    description: "Bon compromis précision/temps pour la production quotidienne.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
  medium: {
    key: "medium",
    label: "Intermédiaire (Whisper Small)",
    modelId: "Xenova/whisper-small",
    description: "Meilleure précision que l'option Équilibre, latence et mémoire modérées.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
  quality: {
    key: "quality",
    label: "Qualité (Whisper Medium)",
    modelId: "Xenova/whisper-medium",
    description: "Précision supérieure à l'option Intermédiaire, avec un coût mémoire plus élevé.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
  mms: {
    key: "mms",
    label: "Multilingue (MMS 1B)",
    modelId: "Xenova/mms-1b-all",
    description: "Modèle multilingue (MMS) pour une couverture de langues étendue.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
  turbo: {
    key: "turbo",
    label: "Très haute qualité (Mistral Turbo)",
    modelId: "onnx-community/whisper-large-v3-turbo",
    description: "Niveau de qualité maximal, plus lent et plus gourmand en mémoire.",
    quantization: {
      webgpu: "q8",
      wasm: "q8",
    },
  },
};

const FALLBACK_PRESET: PresetKey = "balanced";
const MEMORY_FALLBACK_PRESETS: Record<PresetKey, BuiltInPresetKey[]> = {
  fast: [],
  balanced: ["fast"],
  medium: ["balanced", "fast"],
  quality: ["medium", "balanced", "fast"],
  mms: ["balanced", "fast"],
  turbo: ["quality", "medium", "balanced", "fast"],
  custom: ["balanced", "fast"],
};
const DEFAULT_MISTRAL_MODEL = "voxtral-mini-latest";
const LEGACY_MISTRAL_MODEL = "voxtral-mini-transcribe-26-02";
const DEFAULT_LLM_HF_MODEL_ID = "openai/gpt-oss-20b";
const DEFAULT_LLM_HF_TEMPERATURE = 0.2;
const DEFAULT_LLM_HF_MAX_TOKENS = 131072;
const DEFAULT_LLM_MISTRAL_MODEL_ID = "mistral-medium-latest";
const DEFAULT_LLM_MISTRAL_TEMPERATURE = 0.2;
const DEFAULT_LLM_MISTRAL_MAX_TOKENS = 8192;
const DEFAULT_LLM_LOCAL_MODEL_PROFILE: LlmLocalModelProfile = DEFAULT_LLM_LOCAL_PROFILE;
const DEFAULT_LLM_LOCAL_BACKEND: BackendImplementation = "webgpu";
const DEFAULT_LLM_LOCAL_DTYPE_WEBGPU: ModelDtype = "q4f16";
const DEFAULT_LLM_LOCAL_DTYPE_WASM: ModelDtype = "q8";
const LLM_LOCAL_PROFILES: LlmLocalModelProfile[] = ["qwen_1_7b", "ministral_3_3b"];
const DEFAULT_LLM_LOCAL_SETTINGS_BY_PROFILE: Record<LlmLocalModelProfile, LlmLocalModelSettings> =
  createDefaultLocalModelSettingsByProfile();
const allowedActivePresets = new Set<PresetKey>([
  ...(Object.keys(MODEL_PRESETS) as Array<Exclude<PresetKey, "custom">>),
  "custom",
]);
const sanitizePreset = (preset: string | undefined): PresetKey =>
  preset && allowedActivePresets.has(preset as PresetKey) ? (preset as PresetKey) : FALLBACK_PRESET;

const allowedBlockedPresets = new Set<Exclude<PresetKey, "custom">>(
  Object.keys(MODEL_PRESETS) as Array<Exclude<PresetKey, "custom">>
);

const sanitizeBlockedPresets = (presets: PresetKey[] | undefined, fallback: PresetKey[] = []) => {
  if (!Array.isArray(presets)) return fallback;
  const filtered = presets.filter((preset) => allowedBlockedPresets.has(preset as Exclude<PresetKey, "custom">));
  return filtered.length ? filtered : [];
};

const sanitizePresetQuantizationOverrides = (
  overrides: PresetQuantizationOverrides | undefined,
  fallback: PresetQuantizationOverrides = {}
): PresetQuantizationOverrides => {
  if (!overrides || typeof overrides !== "object") return fallback;
  const sanitized: PresetQuantizationOverrides = {};
  const presetEntries = Object.entries(overrides as Record<string, unknown>);
  for (const [presetKey, value] of presetEntries) {
    if (!allowedBlockedPresets.has(presetKey as BuiltInPresetKey)) continue;
    if (!value || typeof value !== "object") continue;
    const backendMap = value as Partial<Record<BackendImplementation, unknown>>;
    const nextBackendMap: Partial<Record<BackendImplementation, ModelDtype>> = {};
    for (const backend of ["webgpu", "wasm"] as const) {
      const dtype = backendMap[backend];
      if (typeof dtype === "string" && ALLOWED_MODEL_DTYPES.has(dtype as ModelDtype)) {
        nextBackendMap[backend] = dtype as ModelDtype;
      }
    }
    if (Object.keys(nextBackendMap).length > 0) {
      sanitized[presetKey as BuiltInPresetKey] = nextBackendMap;
    }
  }
  return sanitized;
};

const resolveBackendPreference = (
  stored: BackendImplementation | undefined,
  supports: { webGpuSupported: boolean; wasmAvailable: boolean },
  fallback: BackendImplementation
): BackendImplementation => {
  if (stored === "webgpu" && supports.webGpuSupported) return "webgpu";
  if (stored === "wasm" && supports.wasmAvailable) return "wasm";
  if (supports.webGpuSupported) return "webgpu";
  if (supports.wasmAvailable) return "wasm";
  return fallback;
};

export const normalizeCloudApiUrl = (value: string | undefined, fallback: string) => {
  if (!value) return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname.startsWith("/gradio_api")) {
      return parsed.origin;
    }
    if (parsed.pathname === "/gradio" || parsed.pathname.startsWith("/gradio/")) {
      return `${parsed.origin}/gradio`;
    }
  } catch {
    // Ignore invalid URLs and fall back to trimmed value.
  }
  return withoutTrailingSlash;
};

export const normalizeMistralModel = (value: string | undefined, fallback: string) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.toLowerCase() === LEGACY_MISTRAL_MODEL) {
    return DEFAULT_MISTRAL_MODEL;
  }
  return trimmed;
};

const normalizeLlmApiProvider = (value: string | undefined, fallback: LlmApiProvider): LlmApiProvider => {
  if (value === "huggingface" || value === "mistral") return value;
  return fallback;
};

const normalizeLlmTemperature = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(2, value as number));
};

const normalizeLlmMaxTokens = (value: number | undefined, fallback: number): number => {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(128, Math.round(value as number));
};

const normalizeLlmLocalModelProfile = (
  value: string | undefined,
  fallback: LlmLocalModelProfile
): LlmLocalModelProfile => {
  if (value === "qwen_1_7b" || value === "ministral_3_3b") return value;
  return fallback;
};

const normalizeLlmLocalDtype = (value: string | undefined, fallback: ModelDtype): ModelDtype => {
  if (value && ALLOWED_MODEL_DTYPES.has(value as ModelDtype)) {
    return value as ModelDtype;
  }
  return fallback;
};

const normalizeLlmLocalModelId = (
  profile: LlmLocalModelProfile,
  value: string | undefined,
  fallback: string
): string => {
  const trimmed = value?.trim() ?? "";
  if (trimmed) return canonicalizeLocalLlmModelId(trimmed);
  const fallbackTrimmed = fallback.trim();
  if (fallbackTrimmed) return canonicalizeLocalLlmModelId(fallbackTrimmed);
  return resolveLocalLlmModelId(profile);
};

const normalizeLlmLocalModelSettings = (
  profile: LlmLocalModelProfile,
  value: Partial<LlmLocalModelSettings> | undefined,
  fallback: LlmLocalModelSettings
): LlmLocalModelSettings => {
  const defaultSettings = createDefaultLocalModelSettings(profile);
  const baseline: LlmLocalModelSettings = {
    modelId: fallback.modelId || defaultSettings.modelId,
    temperature: fallback.temperature,
    maxTokens: fallback.maxTokens,
    dtypeWebgpu: fallback.dtypeWebgpu,
    dtypeWasm: fallback.dtypeWasm,
    appendNoThinkDirective: fallback.appendNoThinkDirective,
  };
  const profileConfig = getLocalLlmModelProfile(profile);

  return {
    modelId: normalizeLlmLocalModelId(profile, value?.modelId, baseline.modelId),
    temperature: normalizeLlmTemperature(value?.temperature, baseline.temperature),
    maxTokens: Math.min(
      normalizeLlmMaxTokens(value?.maxTokens, baseline.maxTokens),
      profileConfig.maxGenerationTokens
    ),
    dtypeWebgpu: normalizeLlmLocalDtype(value?.dtypeWebgpu, baseline.dtypeWebgpu),
    dtypeWasm: normalizeLlmLocalDtype(value?.dtypeWasm, baseline.dtypeWasm),
    appendNoThinkDirective:
      typeof value?.appendNoThinkDirective === "boolean"
        ? value.appendNoThinkDirective
        : baseline.appendNoThinkDirective,
  };
};

const normalizeLlmLocalSettingsByProfile = (
  value: Partial<Record<LlmLocalModelProfile, Partial<LlmLocalModelSettings>>> | undefined,
  fallback: Record<LlmLocalModelProfile, LlmLocalModelSettings>
): Record<LlmLocalModelProfile, LlmLocalModelSettings> => {
  const normalized = {} as Record<LlmLocalModelProfile, LlmLocalModelSettings>;

  for (const profile of LLM_LOCAL_PROFILES) {
    normalized[profile] = normalizeLlmLocalModelSettings(profile, value?.[profile], fallback[profile]);
  }

  return normalized;
};

function normalizeSecureTokens(input: Partial<SecureTokens> | null | undefined): SecureTokens {
  return {
    hfApiToken: typeof input?.hfApiToken === "string" ? input.hfApiToken : "",
    mistralApiKey: typeof input?.mistralApiKey === "string" ? input.mistralApiKey : "",
  };
}

function hasAnySecureToken(tokens: SecureTokens) {
  return tokens.hfApiToken.trim().length > 0 || tokens.mistralApiKey.trim().length > 0;
}

type SessionSource = {
  id: string;
  label: string;
  type: "file" | "mic";
};

interface AsrConfigState {
  hasHydrated: boolean;
  activePreset: PresetKey;
  customModelId: string;
  modelQuantizationOverrides: PresetQuantizationOverrides;
  blockedPresets: PresetKey[];
  backendPreference: BackendImplementation;
  webGpuSupported: boolean;
  wasmAvailable: boolean;
  status: PipelineStatus;
  statusDetail?: string;
  cloudStatus: CloudTranscriptionStatus;
  cloudStatusDetail?: string;
  activeBackend?: BackendImplementation;
  memoryMode: "full" | "progressive";
  chunkStrategy: "sequential" | "overlap" | "silence";
  segmentationMode: "chunks" | "silence";
  dedupeMode: DedupeMode;
  cleanIntraChunk: boolean;
  chunkDurationSec: number;
  overlapSec: number;
  progressiveSegmentDurationSec: number;
  silenceThresholdDb: number;
  minSilenceMs: number;
  minChunkMs: number;
  maxChunkMs: number;
  showSegments: boolean;
  showExportVtt: boolean;
  showExportSrt: boolean;
  showExportJson: boolean;
  showExportTelemetry: boolean;
  preprocessingMode: "quick" | "full";
  preprocessingStatus: "idle" | "calibrating" | "processing" | "done";
  preprocessingProgress: number;
  segmentationStatus: "idle" | "segmenting" | "done" | "stopped" | "error";
  segmentationProgress: number;
  denoiseNoiseFloorDb: number;
  denoiseReductionDb: number;
  denoiseSmoothing: number;
  denoiseCalibrationSeconds: number;
  preprocessEnableFilters: boolean;
  preprocessHighpassHz: number;
  preprocessLowpassHz: number;
  preprocessEnableLufs: boolean;
  preprocessTargetLufs: number;
  preprocessLimiterEnabled: boolean;
  preprocessLimiterThresholdDb: number;
  preprocessLimiterSoftness: number;
  preprocessVadEnabled: boolean;
  preprocessVadThresholdDb: number;
  preprocessVadMinSilenceMs: number;
  preprocessOverlapAdd: boolean;
  preprocessOverlapBlockSec: number;
  preprocessOverlapSec: number;
  // Mic-specific settings
  micActivePreset: PresetKey;
  micCustomModelId: string;
  micBackendPreference: BackendImplementation;
  micPreprocessingMode: "quick" | "full";
  micSegmentationMode: "chunks" | "silence";
  micSilenceThresholdDb: number;
  micNoiseCalibrationMarginDb: number;
  micMinSilenceMs: number;
  micMinChunkMs: number;
  micMaxChunkMs: number;
  micShowExportVtt: boolean;
  micShowExportSrt: boolean;
  micShowExportJson: boolean;
  micShowExportTelemetry: boolean;
  micDenoiseNoiseFloorDb: number;
  micDenoiseReductionDb: number;
  micDenoiseSmoothing: number;
  micDenoiseCalibrationSeconds: number;
  micPreprocessEnableFilters: boolean;
  micPreprocessHighpassHz: number;
  micPreprocessLowpassHz: number;
  micPreprocessEnableLufs: boolean;
  micPreprocessTargetLufs: number;
  micPreprocessLimiterEnabled: boolean;
  micPreprocessLimiterThresholdDb: number;
  micPreprocessLimiterSoftness: number;
  micPreprocessVadEnabled: boolean;
  micPreprocessVadThresholdDb: number;
  micPreprocessVadMinSilenceMs: number;
  micPreprocessOverlapAdd: boolean;
  micPreprocessOverlapBlockSec: number;
  micPreprocessOverlapSec: number;
  micAutoTunePreprocess: boolean;
  micEnableWordTimestamps: boolean;
  micShowSegmentConfidence: boolean;
  micForceSingleThread: boolean;
  // Cloud-specific settings
  cloudApiUrl: string;
  hfApiToken: string;
  cloudMistralApiUrl: string;
  mistralApiKey: string;
  cloudMistralModel: string;
  cloudMistralDiarizationEnabled: boolean;
  cloudWhisperChunkDurationSec: number;
  cloudWhisperOverlapSec: number;
  cloudMistralChunkDurationSec: number;
  cloudMistralOverlapSec: number;
  cloudMaxTokens: number;
  cloudTemperature: number;
  cloudTopP: number;
  cloudDoSample: boolean;
  cloudContextPreset: string;
  cloudShowSegments: boolean;
  cloudShowExportVtt: boolean;
  cloudShowExportSrt: boolean;
  cloudShowExportJson: boolean;
  cloudShowExportTelemetry: boolean;
  cloudPreprocessingMode: "quick" | "full";
  cloudDenoiseNoiseFloorDb: number;
  cloudDenoiseReductionDb: number;
  cloudDenoiseSmoothing: number;
  cloudDenoiseCalibrationSeconds: number;
  cloudPreprocessEnableFilters: boolean;
  cloudPreprocessHighpassHz: number;
  cloudPreprocessLowpassHz: number;
  cloudPreprocessEnableLufs: boolean;
  cloudPreprocessTargetLufs: number;
  cloudPreprocessLimiterEnabled: boolean;
  cloudPreprocessLimiterThresholdDb: number;
  cloudPreprocessLimiterSoftness: number;
  cloudPreprocessVadEnabled: boolean;
  cloudPreprocessVadThresholdDb: number;
  cloudPreprocessVadMinSilenceMs: number;
  cloudPreprocessOverlapAdd: boolean;
  cloudPreprocessOverlapBlockSec: number;
  cloudPreprocessOverlapSec: number;
  cloudAutoTunePreprocess: boolean;
  cloudEnableWordTimestamps: boolean;
  cloudShowSegmentConfidence: boolean;
  // LLM API specific settings/runtime
  llmApiProvider: LlmApiProvider;
  llmApiHfModelId: string;
  llmApiHfTemperature: number;
  llmApiHfMaxTokens: number;
  llmApiMistralModelId: string;
  llmApiMistralTemperature: number;
  llmApiMistralMaxTokens: number;
  llmApiStatus: LlmApiStatus;
  llmApiStatusDetail?: string;
  llmApiProgress: number;
  llmApiResults: Partial<Record<ReportResultKey, ReportResult>>;
  // LLM local specific settings/runtime
  llmLocalModelProfile: LlmLocalModelProfile;
  llmLocalModelId: string;
  llmLocalTemperature: number;
  llmLocalMaxTokens: number;
  llmLocalBackendPreference: BackendImplementation;
  llmLocalDtypeWebgpu: ModelDtype;
  llmLocalDtypeWasm: ModelDtype;
  llmLocalSettingsByProfile: Record<LlmLocalModelProfile, LlmLocalModelSettings>;
  llmLocalForceSingleThread: boolean;
  llmLocalStatus: LlmApiStatus;
  llmLocalStatusDetail?: string;
  llmLocalProgress: number;
  llmLocalResults: Partial<Record<ReportResultKey, ReportResult>>;
  localUploadModelSizeAlert: ModelSizeForegroundAlert | null;
  llmLocalModelSizeAlert: ModelSizeForegroundAlert | null;
  noiseCalibrationRequestedAt?: number | null;
  autoTunePreprocess: boolean;
  lastAutoTuneParams?: {
    noiseFloorDb: number;
    reductionDb: number;
    smoothing: number;
    targetLufs: number;
    highpassHz: number;
    lowpassHz: number;
    limiterThresholdDb: number;
    limiterSoftness: number;
    vadThresholdDb: number;
    overlapBlockSec: number;
    overlapSec: number;
  } | null;
  telemetryCollector: TelemetryCollector | null;
  // Whisper specific
  enableWordTimestamps: boolean;
  showSegmentConfidence: boolean;
  chunkPlan: ChunkDefinition[];
  chunkMetrics: ChunkTelemetry[];
  segments: TranscriptionSegment[];
  audioMetadata: AudioMetadata | null;
  audioSource: SessionSource | null;
  // Persist the uploaded file in-memory so UI like pre-listen survives navigation
  uploadedFile: File | null;
  previewUrl: string | null;
  telemetrySummary: TelemetrySummary | null;
  transcriptionConfidence: number | null; // 0..1 overall transcript confidence or null if unavailable
  transcriptionConfidenceSource?: 'model' | 'estimated' | null;
  debugConfidence: boolean;
  isTranscribing: boolean;
  stopRequested: boolean;
  progress: number; 
  resetCounter: number;

  // Performance options
  forceSingleThread: boolean; // when true, force single-threaded WASM
  wasmThreads: number | null; // effective number of threads in use (null = unknown)
}

interface AsrConfigActions {
  setPreset: (preset: PresetKey, customModelId?: string) => void;
  setPresetQuantization: (preset: BuiltInPresetKey, backend: BackendImplementation, dtype: ModelDtype) => void;
  setBlockedPresets: (presets: PresetKey[]) => void;
  setBackendPreference: (backend: BackendImplementation) => void;
  setStatus: (status: PipelineStatus, detail?: string) => void;
  setActiveBackend: (backend: BackendImplementation | undefined) => void;
  setMemoryMode: (mode: "full" | "progressive") => void;
  setChunkStrategy: (strategy: "sequential" | "overlap" | "silence") => void;
  setSegmentationMode: (mode: "chunks" | "silence") => void;
  setDedupeMode: (mode: DedupeMode) => void;
  setCleanIntraChunk: (value: boolean) => void;
  updateChunkParameters: (params: Partial<{
    chunkDurationSec: number;
    overlapSec: number;
    silenceThresholdDb: number;
    minSilenceMs: number;
    minChunkMs: number;
    maxChunkMs: number;
  }>) => void;
  setProgressiveSegmentDurationSec: (value: number) => void;
  setShowSegments: (value: boolean) => void;
  setShowExportVtt: (value: boolean) => void;
  setShowExportSrt: (value: boolean) => void;
  setShowExportJson: (value: boolean) => void;
  setShowExportTelemetry: (value: boolean) => void;
  setPreprocessingMode: (mode: "quick" | "full") => void;
  setPreprocessingStatus: (status: "idle" | "calibrating" | "processing" | "done") => void;
  setPreprocessingProgress: (value: number) => void;
  setSegmentationStatus: (status: "idle" | "segmenting" | "done" | "stopped" | "error") => void;
  setSegmentationProgress: (value: number) => void;
  setDenoiseParams: (params: Partial<{
    denoiseNoiseFloorDb: number;
    denoiseReductionDb: number;
    denoiseSmoothing: number;
    denoiseCalibrationSeconds: number;
  }>) => void;
  setPreprocessParams: (params: Partial<{
    preprocessEnableFilters: boolean;
    preprocessHighpassHz: number;
    preprocessLowpassHz: number;
    preprocessEnableLufs: boolean;
    preprocessTargetLufs: number;
    preprocessLimiterEnabled: boolean;
    preprocessLimiterThresholdDb: number;
    preprocessLimiterSoftness: number;
    preprocessVadEnabled: boolean;
    preprocessVadThresholdDb: number;
    preprocessVadMinSilenceMs: number;
    preprocessOverlapAdd: boolean;
    preprocessOverlapBlockSec: number;
    preprocessOverlapSec: number;
  }>) => void;
  // Mic-specific actions
  setMicPreset: (preset: PresetKey, customModelId?: string) => void;
  setMicBackendPreference: (backend: BackendImplementation) => void;
  setMicPreprocessingMode: (mode: "quick" | "full") => void;
  setMicSegmentationMode: (mode: "chunks" | "silence") => void;
  setMicNoiseCalibrationMarginDb: (value: number) => void;
  setMicSilenceParams: (params: Partial<{
    silenceThresholdDb: number;
    minSilenceMs: number;
    minChunkMs: number;
    maxChunkMs: number;
  }>) => void;
  setMicShowExportVtt: (value: boolean) => void;
  setMicShowExportSrt: (value: boolean) => void;
  setMicShowExportJson: (value: boolean) => void;
  setMicShowExportTelemetry: (value: boolean) => void;
  setMicDenoiseParams: (params: Partial<{
    denoiseNoiseFloorDb: number;
    denoiseReductionDb: number;
    denoiseSmoothing: number;
    denoiseCalibrationSeconds: number;
  }>) => void;
  setMicPreprocessParams: (params: Partial<{
    preprocessEnableFilters: boolean;
    preprocessHighpassHz: number;
    preprocessLowpassHz: number;
    preprocessEnableLufs: boolean;
    preprocessTargetLufs: number;
    preprocessLimiterEnabled: boolean;
    preprocessLimiterThresholdDb: number;
    preprocessLimiterSoftness: number;
    preprocessVadEnabled: boolean;
    preprocessVadThresholdDb: number;
    preprocessVadMinSilenceMs: number;
    preprocessOverlapAdd: boolean;
    preprocessOverlapBlockSec: number;
    preprocessOverlapSec: number;
  }>) => void;
  setMicAutoTunePreprocess: (value: boolean) => void;
  setMicEnableWordTimestamps: (value: boolean) => void;
  setMicShowSegmentConfidence: (value: boolean) => void;
  setMicForceSingleThread: (value: boolean) => void;
  setCloudStatus: (status: CloudTranscriptionStatus, detail?: string) => void;
  setCloudApiUrl: (value: string) => void;
  setHfApiToken: (value: string) => void;
  setCloudMistralApiUrl: (value: string) => void;
  setMistralApiKey: (value: string) => void;
  setCloudMistralModel: (value: string) => void;
  setCloudMistralDiarizationEnabled: (value: boolean) => void;
  setCloudWhisperChunking: (params: Partial<{
    chunkDurationSec: number;
    overlapSec: number;
  }>) => void;
  setCloudMistralChunking: (params: Partial<{
    chunkDurationSec: number;
    overlapSec: number;
  }>) => void;
  setCloudMaxTokens: (value: number) => void;
  setCloudTemperature: (value: number) => void;
  setCloudTopP: (value: number) => void;
  setCloudDoSample: (value: boolean) => void;
  setCloudContextPreset: (value: string) => void;
  setCloudShowSegments: (value: boolean) => void;
  setCloudShowExportVtt: (value: boolean) => void;
  setCloudShowExportSrt: (value: boolean) => void;
  setCloudShowExportJson: (value: boolean) => void;
  setCloudShowExportTelemetry: (value: boolean) => void;
  setCloudPreprocessingMode: (mode: "quick" | "full") => void;
  setCloudDenoiseParams: (params: Partial<{
    denoiseNoiseFloorDb: number;
    denoiseReductionDb: number;
    denoiseSmoothing: number;
    denoiseCalibrationSeconds: number;
  }>) => void;
  setCloudPreprocessParams: (params: Partial<{
    preprocessEnableFilters: boolean;
    preprocessHighpassHz: number;
    preprocessLowpassHz: number;
    preprocessEnableLufs: boolean;
    preprocessTargetLufs: number;
    preprocessLimiterEnabled: boolean;
    preprocessLimiterThresholdDb: number;
    preprocessLimiterSoftness: number;
    preprocessVadEnabled: boolean;
    preprocessVadThresholdDb: number;
    preprocessVadMinSilenceMs: number;
    preprocessOverlapAdd: boolean;
    preprocessOverlapBlockSec: number;
    preprocessOverlapSec: number;
  }>) => void;
  setCloudAutoTunePreprocess: (value: boolean) => void;
  setCloudEnableWordTimestamps: (value: boolean) => void;
  setCloudShowSegmentConfidence: (value: boolean) => void;
  setLlmApiProvider: (value: LlmApiProvider) => void;
  setLlmApiHfModelId: (value: string) => void;
  setLlmApiHfTemperature: (value: number) => void;
  setLlmApiHfMaxTokens: (value: number) => void;
  setLlmApiMistralModelId: (value: string) => void;
  setLlmApiMistralTemperature: (value: number) => void;
  setLlmApiMistralMaxTokens: (value: number) => void;
  setLlmApiStatus: (status: LlmApiStatus, detail?: string) => void;
  setLlmApiProgress: (value: number) => void;
  setLlmApiResult: (format: ReportResultKey, value: ReportResult) => void;
  setLlmApiResults: (value: Partial<Record<ReportResultKey, ReportResult>>) => void;
  resetLlmApiSession: () => void;
  setLlmLocalModelProfile: (value: LlmLocalModelProfile) => void;
  setLlmLocalModelId: (value: string) => void;
  setLlmLocalTemperature: (value: number) => void;
  setLlmLocalMaxTokens: (value: number) => void;
  setLlmLocalBackendPreference: (value: BackendImplementation) => void;
  setLlmLocalDtypeWebgpu: (value: ModelDtype) => void;
  setLlmLocalDtypeWasm: (value: ModelDtype) => void;
  setLlmLocalForceSingleThread: (value: boolean) => void;
  setLlmLocalModelSettings: (profile: LlmLocalModelProfile, patch: Partial<LlmLocalModelSettings>) => void;
  resetLlmLocalModelSettings: (profile: LlmLocalModelProfile) => void;
  setLlmLocalStatus: (status: LlmApiStatus, detail?: string) => void;
  setLlmLocalProgress: (value: number) => void;
  setLlmLocalResult: (format: ReportResultKey, value: ReportResult) => void;
  setLlmLocalResults: (value: Partial<Record<ReportResultKey, ReportResult>>) => void;
  setLocalUploadModelSizeAlert: (alert: ModelSizeForegroundAlert | null) => void;
  clearLocalUploadModelSizeAlert: () => void;
  setLlmLocalModelSizeAlert: (alert: ModelSizeForegroundAlert | null) => void;
  clearLlmLocalModelSizeAlert: () => void;
  resetLlmLocalSession: () => void;
  setAutoTunePreprocess: (value: boolean) => void;
  setLastAutoTuneParams: (params: {
    noiseFloorDb: number;
    reductionDb: number;
    smoothing: number;
    targetLufs: number;
    highpassHz: number;
    lowpassHz: number;
    limiterThresholdDb: number;
    limiterSoftness: number;
    vadThresholdDb: number;
    overlapBlockSec: number;
    overlapSec: number;
  } | null) => void;
  requestNoiseCalibration: () => void;
  clearNoiseCalibrationRequest: () => void;
  hydrateFromStorage: () => void;
  registerTelemetry: (collector: TelemetryCollector | null) => void;
  registerAudioSource: (source: SessionSource | null, metadata?: AudioMetadata | null) => void;
  setChunkPlan: (plan: ChunkDefinition[]) => void;
  setSegments: (segments: TranscriptionSegment[]) => void;
  appendSegments: (segments: TranscriptionSegment[]) => void;
  pushChunkMetric: (metric: ChunkTelemetry) => void;
  setTelemetrySummary: (summary: TelemetrySummary | null) => void;
  setTranscriptionConfidence: (value: number | null) => void;
  setTranscriptionConfidenceSource: (value: 'model' | 'estimated' | null) => void;
  setDebugConfidence: (value: boolean) => void;
  setIsTranscribing: (value: boolean) => void; 
  setProgress: (value: number) => void;
  requestStop: () => void;
  resetStopRequest: () => void;
  resetSession: () => void;
  resetApp: () => void;
  setWebGpuSupport: (supported: boolean) => void;
  setWasmAvailable: (available: boolean) => void;
  setEnableWordTimestamps: (value: boolean) => void;
  setShowSegmentConfidence: (value: boolean) => void;
  // Keep the uploaded File in-memory so pre-listen persists across navigation
  setUploadedFile: (file: File | null) => void;
  setPreviewUrl: (url: string | null) => void;
  // performance
  setForceSingleThread: (value: boolean) => void;
  setWasmThreads: (value: number | null) => void;
} 

export type AsrConfigStore = AsrConfigState & AsrConfigActions;

const initialState: AsrConfigState = {
  hasHydrated: false,
  activePreset: "fast",
  customModelId: "",
  modelQuantizationOverrides: {},
  blockedPresets: [],
  backendPreference: "webgpu",
  webGpuSupported: true,
  wasmAvailable: true,
  status: "idle",
  statusDetail: undefined,
  cloudStatus: "idle",
  cloudStatusDetail: undefined,
  activeBackend: undefined,
  memoryMode: "full",
  chunkStrategy: "overlap",
  segmentationMode: "silence",
  dedupeMode: "fuzzy",
  cleanIntraChunk: true,
  // Target chunk duration used when building chunks in 'silence' mode (seconds)
  chunkDurationSec: 15,
  overlapSec: computeDefaultOverlap(15),
  progressiveSegmentDurationSec: 600,
  silenceThresholdDb: -32,
  minSilenceMs: 800,
  minChunkMs: 4000,
  // Max chunk size default is target + 5s (automatically recalculated when target changes)
  maxChunkMs: (15 + 5) * 1000,
  showSegments: true,
  showExportVtt: true,
  showExportSrt: true,
  showExportJson: true,
  showExportTelemetry: false,
  preprocessingMode: "full",
  denoiseNoiseFloorDb: -28,
  denoiseReductionDb: 10,
  denoiseSmoothing: 0.85,
  denoiseCalibrationSeconds: 6,
  preprocessEnableFilters: true,
  preprocessHighpassHz: 90,
  preprocessLowpassHz: 7500,
  preprocessEnableLufs: true,
  preprocessTargetLufs: -20,
  preprocessLimiterEnabled: true,
  preprocessLimiterThresholdDb: -1,
  preprocessLimiterSoftness: 0.65,
  preprocessVadEnabled: true,
  preprocessVadThresholdDb: -38,
  preprocessVadMinSilenceMs: 300,
  preprocessOverlapAdd: true,
  preprocessOverlapBlockSec: 1.4,
  preprocessOverlapSec: 0.3,
  // Mic defaults
  micActivePreset: "fast",
  micCustomModelId: "",
  micBackendPreference: "webgpu",
  micPreprocessingMode: "full",
  micSegmentationMode: "silence",
  micSilenceThresholdDb: -32,
  micNoiseCalibrationMarginDb: 6,
  micMinSilenceMs: 700,
  micMinChunkMs: 12000,
  micMaxChunkMs: 20000,
  micShowExportVtt: false,
  micShowExportSrt: false,
  micShowExportJson: false,
  micShowExportTelemetry: false,
  micDenoiseNoiseFloorDb: -28,
  micDenoiseReductionDb: 10,
  micDenoiseSmoothing: 0.85,
  micDenoiseCalibrationSeconds: 6,
  micPreprocessEnableFilters: true,
  micPreprocessHighpassHz: 90,
  micPreprocessLowpassHz: 7500,
  micPreprocessEnableLufs: true,
  micPreprocessTargetLufs: -20,
  micPreprocessLimiterEnabled: true,
  micPreprocessLimiterThresholdDb: -1,
  micPreprocessLimiterSoftness: 0.65,
  micPreprocessVadEnabled: true,
  micPreprocessVadThresholdDb: -38,
  micPreprocessVadMinSilenceMs: 300,
  micPreprocessOverlapAdd: true,
  micPreprocessOverlapBlockSec: 1.4,
  micPreprocessOverlapSec: 0.3,
  micAutoTunePreprocess: true,
  micEnableWordTimestamps: false,
  micShowSegmentConfidence: false,
  micForceSingleThread: false,
  cloudApiUrl: "https://transcode.demeter-sante.fr/gradio",
  hfApiToken: "",
  cloudMistralApiUrl: "https://api.mistral.ai",
  mistralApiKey: "",
  cloudMistralModel: DEFAULT_MISTRAL_MODEL,
  cloudMistralDiarizationEnabled: true,
  cloudWhisperChunkDurationSec: 30,
  cloudWhisperOverlapSec: 0,
  cloudMistralChunkDurationSec: 1800,
  cloudMistralOverlapSec: 0,
  cloudMaxTokens: 32768,
  cloudTemperature: 0,
  cloudTopP: 1,
  cloudDoSample: false,
  cloudContextPreset: "",
  cloudShowSegments: true,
  cloudShowExportVtt: true,
  cloudShowExportSrt: true,
  cloudShowExportJson: true,
  cloudShowExportTelemetry: false,
  cloudPreprocessingMode: "full",
  cloudDenoiseNoiseFloorDb: -28,
  cloudDenoiseReductionDb: 10,
  cloudDenoiseSmoothing: 0.85,
  cloudDenoiseCalibrationSeconds: 6,
  cloudPreprocessEnableFilters: true,
  cloudPreprocessHighpassHz: 90,
  cloudPreprocessLowpassHz: 7500,
  cloudPreprocessEnableLufs: true,
  cloudPreprocessTargetLufs: -20,
  cloudPreprocessLimiterEnabled: true,
  cloudPreprocessLimiterThresholdDb: -1,
  cloudPreprocessLimiterSoftness: 0.65,
  cloudPreprocessVadEnabled: true,
  cloudPreprocessVadThresholdDb: -42,
  cloudPreprocessVadMinSilenceMs: 250,
  cloudPreprocessOverlapAdd: true,
  cloudPreprocessOverlapBlockSec: 1.4,
  cloudPreprocessOverlapSec: 0.3,
  cloudAutoTunePreprocess: true,
  cloudEnableWordTimestamps: false,
  cloudShowSegmentConfidence: false,
  llmApiProvider: "huggingface",
  llmApiHfModelId: DEFAULT_LLM_HF_MODEL_ID,
  llmApiHfTemperature: DEFAULT_LLM_HF_TEMPERATURE,
  llmApiHfMaxTokens: DEFAULT_LLM_HF_MAX_TOKENS,
  llmApiMistralModelId: DEFAULT_LLM_MISTRAL_MODEL_ID,
  llmApiMistralTemperature: DEFAULT_LLM_MISTRAL_TEMPERATURE,
  llmApiMistralMaxTokens: DEFAULT_LLM_MISTRAL_MAX_TOKENS,
  llmApiStatus: "idle",
  llmApiStatusDetail: undefined,
  llmApiProgress: 0,
  llmApiResults: {},
  llmLocalSettingsByProfile: normalizeLlmLocalSettingsByProfile(undefined, DEFAULT_LLM_LOCAL_SETTINGS_BY_PROFILE),
  llmLocalModelProfile: DEFAULT_LLM_LOCAL_MODEL_PROFILE,
  llmLocalModelId: DEFAULT_LLM_LOCAL_MODEL_ID,
  llmLocalTemperature: DEFAULT_LLM_LOCAL_TEMPERATURE,
  llmLocalMaxTokens: DEFAULT_LLM_LOCAL_MAX_TOKENS,
  llmLocalBackendPreference: DEFAULT_LLM_LOCAL_BACKEND,
  llmLocalDtypeWebgpu: DEFAULT_LLM_LOCAL_DTYPE_WEBGPU,
  llmLocalDtypeWasm: DEFAULT_LLM_LOCAL_DTYPE_WASM,
  llmLocalForceSingleThread: false,
  llmLocalStatus: "idle",
  llmLocalStatusDetail: undefined,
  llmLocalProgress: 0,
  llmLocalResults: {},
  localUploadModelSizeAlert: null,
  llmLocalModelSizeAlert: null,
  noiseCalibrationRequestedAt: null,
  segmentationStatus: "idle",
  segmentationProgress: 0,
  autoTunePreprocess: true,
  lastAutoTuneParams: null,
  telemetryCollector: null,
  chunkPlan: [],
  chunkMetrics: [],
  segments: [],
  audioMetadata: null,
  audioSource: null,
  // Persist uploaded file in-memory so pre-listen survives navigation
  uploadedFile: null,
  previewUrl: null,
  telemetrySummary: null,
  isTranscribing: false,
  stopRequested: false,
  progress: 0,
  resetCounter: 0,
  // preprocessing status
  preprocessingStatus: "idle",
  preprocessingProgress: 0,
  // defaults
  forceSingleThread: false,
  wasmThreads: null,
  // Whisper defaults
  enableWordTimestamps: false,
  // UI toggles
  showSegmentConfidence: false,
  // derived metrics
  transcriptionConfidence: null,
  transcriptionConfidenceSource: null,
  debugConfidence: false,
};

export const useAsrStore = create<AsrConfigStore>((set, get): AsrConfigStore => ({
  ...initialState,
  setPreset: (preset, customId) =>
    set(() => ({
      activePreset: sanitizePreset(preset),
      customModelId: customId ?? "",
    })),
  setPresetQuantization: (preset, backend, dtype) =>
    set((state) => {
      const currentPresetOverrides = { ...(state.modelQuantizationOverrides[preset] ?? {}) };
      const defaultDtype = MODEL_PRESETS[preset].quantization[backend];
      if (dtype === defaultDtype) {
        delete currentPresetOverrides[backend];
      } else {
        currentPresetOverrides[backend] = dtype;
      }

      const nextOverrides = { ...state.modelQuantizationOverrides };
      if (Object.keys(currentPresetOverrides).length > 0) {
        nextOverrides[preset] = currentPresetOverrides;
      } else {
        delete nextOverrides[preset];
      }
      return { modelQuantizationOverrides: nextOverrides };
    }),
  setBlockedPresets: (presets) => {
    const sanitized = sanitizeBlockedPresets(presets);
    logger.info("[asr-store] blocked presets updated", { blocked: sanitized });
    set(() => ({ blockedPresets: sanitized }));
  },
  setBackendPreference: (backend) =>
    set((state) => {
      if (backend === "webgpu" && !state.webGpuSupported) {
        if (state.backendPreference === "wasm") {
          return {};
        }
        return { backendPreference: "wasm" };
      }
      return { backendPreference: backend };
    }),
  setStatus: (status, detail) => set(() => ({ status, statusDetail: detail })),
  setActiveBackend: (backend) => set(() => ({ activeBackend: backend })),
  setMemoryMode: (mode) => set(() => ({ memoryMode: mode })),
  setChunkStrategy: (strategy) => set(() => ({ chunkStrategy: strategy })),
  setSegmentationMode: (mode) => set(() => ({ segmentationMode: mode })),
  setDedupeMode: (mode) => set(() => ({ dedupeMode: mode })),
  setCleanIntraChunk: (value) => set(() => ({ cleanIntraChunk: value })),
  setProgressiveSegmentDurationSec: (value) => set(() => ({ progressiveSegmentDurationSec: value })),
  updateChunkParameters: (params) => set((state) => {
    const merged = { ...state, ...params } as AsrConfigState;
    // If user updated the target chunk duration but did not provide an explicit maxChunkMs,
    // recompute maxChunkMs as (chunkDurationSec + 5) seconds expressed in ms.
    if (Object.prototype.hasOwnProperty.call(params, "chunkDurationSec") && !Object.prototype.hasOwnProperty.call(params, "maxChunkMs")) {
      merged.maxChunkMs = Math.round((params.chunkDurationSec ?? state.chunkDurationSec + 5) * 1000);
    }

    // If user updated the chunk duration but did not explicitly set overlapSec,
    // set overlapSec to 10% of the new chunk duration (minimum 0.5s to avoid tiny overlaps).
    if (Object.prototype.hasOwnProperty.call(params, "chunkDurationSec") && !Object.prototype.hasOwnProperty.call(params, "overlapSec")) {
      const newChunkSec = (params.chunkDurationSec ?? state.chunkDurationSec) as number;
      // Use centralised computation
      merged.overlapSec = computeDefaultOverlap(newChunkSec);
    }

    return merged;
  }),
  setShowSegments: (value) => set(() => ({ showSegments: value })),
  setShowExportVtt: (value) => set(() => ({ showExportVtt: value })),
  setShowExportSrt: (value) => set(() => ({ showExportSrt: value })),
  setShowExportJson: (value) => set(() => ({ showExportJson: value })),
  setShowExportTelemetry: (value) => set(() => ({ showExportTelemetry: value })),
  hydrateFromStorage: () => {
    const syncSecureTokensFromVault = async () => {
      const secureTokens = normalizeSecureTokens(await loadSecureTokens());
      lastPersistedSecureTokens = secureTokens;
      if (hasAnySecureToken(secureTokens)) {
        set(() => ({
          hfApiToken: secureTokens.hfApiToken,
          mistralApiKey: secureTokens.mistralApiKey,
        }));
      }
    };
    const settings = loadSettings();
    if (!settings) {
      const currentTokens = normalizeSecureTokens({
        hfApiToken: get().hfApiToken,
        mistralApiKey: get().mistralApiKey,
      });
      lastPersistedSecureTokens = currentTokens;
      set(() => ({
        hasHydrated: true,
        hfApiToken: currentTokens.hfApiToken,
        mistralApiKey: currentTokens.mistralApiKey,
      }));
      void syncSecureTokensFromVault();
      return;
    }
    const modelQuantizationOverrides = sanitizePresetQuantizationOverrides(
      settings.presetQuantizationOverrides,
      get().modelQuantizationOverrides
    );
    const blockedPresets = sanitizeBlockedPresets(settings.blockedPresets, get().blockedPresets);
    const support = { webGpuSupported: get().webGpuSupported, wasmAvailable: get().wasmAvailable };
    const resolvedBackendPreference = resolveBackendPreference(
      settings.backendPreference,
      support,
      get().backendPreference
    );
    const resolvedMicBackendPreference = resolveBackendPreference(
      settings.micBackendPreference,
      support,
      get().micBackendPreference
    );
    if (blockedPresets.length > 0) {
      logger.info("[asr-store] hydrated blocked presets", { blocked: blockedPresets });
    }
    if (settings.backendPreference && resolvedBackendPreference !== settings.backendPreference) {
      logger.info("[asr-store] backend preference adjusted", {
        stored: settings.backendPreference,
        resolved: resolvedBackendPreference,
        ...support,
      });
    }
    if (settings.micBackendPreference && resolvedMicBackendPreference !== settings.micBackendPreference) {
      logger.info("[asr-store] mic backend preference adjusted", {
        stored: settings.micBackendPreference,
        resolved: resolvedMicBackendPreference,
        ...support,
      });
    }
    const currentCloudApiUrl = get().cloudApiUrl;
    const normalizedCloudApiUrl = normalizeCloudApiUrl(settings.cloudApiUrl ?? currentCloudApiUrl, currentCloudApiUrl);
    if ((settings.cloudApiUrl ?? currentCloudApiUrl) !== normalizedCloudApiUrl) {
      const storedValue = settings.cloudApiUrl ?? currentCloudApiUrl;
      logger.info("[asr-store] cloud api url normalized", {
        stored: storedValue,
        normalized: normalizedCloudApiUrl,
      });
    }
    const currentCloudMistralModel = get().cloudMistralModel;
    const normalizedCloudMistralModel = normalizeMistralModel(
      settings.cloudMistralModel ?? currentCloudMistralModel,
      currentCloudMistralModel
    );
    if ((settings.cloudMistralModel ?? currentCloudMistralModel) !== normalizedCloudMistralModel) {
      const storedValue = settings.cloudMistralModel ?? currentCloudMistralModel;
      logger.info("[asr-store] cloud mistral model normalized", {
        stored: storedValue,
        normalized: normalizedCloudMistralModel,
      });
    }
    set((state) => {
      const persistedLlmProvider = normalizeLlmApiProvider(settings.llmApiProvider, state.llmApiProvider);
      const legacyLlmModelId = settings.llmApiModelId;
      const legacyLlmTemperature = settings.llmApiTemperature;
      const legacyLlmMaxTokens = settings.llmApiMaxTokens;

      const llmApiHfModelId =
        settings.llmApiHfModelId ??
        (persistedLlmProvider === "huggingface" ? legacyLlmModelId : undefined) ??
        state.llmApiHfModelId;
      const llmApiHfTemperature = normalizeLlmTemperature(
        settings.llmApiHfTemperature ??
          (persistedLlmProvider === "huggingface" ? legacyLlmTemperature : undefined),
        state.llmApiHfTemperature
      );
      const llmApiHfMaxTokens = normalizeLlmMaxTokens(
        settings.llmApiHfMaxTokens ??
          (persistedLlmProvider === "huggingface" ? legacyLlmMaxTokens : undefined),
        state.llmApiHfMaxTokens
      );

      const llmApiMistralModelId =
        settings.llmApiMistralModelId ??
        (persistedLlmProvider === "mistral" ? legacyLlmModelId : undefined) ??
        state.llmApiMistralModelId;
      const llmApiMistralTemperature = normalizeLlmTemperature(
        settings.llmApiMistralTemperature ??
          (persistedLlmProvider === "mistral" ? legacyLlmTemperature : undefined),
        state.llmApiMistralTemperature
      );
      const llmApiMistralMaxTokens = normalizeLlmMaxTokens(
        settings.llmApiMistralMaxTokens ??
          (persistedLlmProvider === "mistral" ? legacyLlmMaxTokens : undefined),
        state.llmApiMistralMaxTokens
      );

      const llmLocalModelProfile = normalizeLlmLocalModelProfile(
        settings.llmLocalModelProfile,
        state.llmLocalModelProfile
      );
      const llmLocalSettingsByProfileFallback = normalizeLlmLocalSettingsByProfile(
        undefined,
        state.llmLocalSettingsByProfile
      );
      let llmLocalSettingsByProfile = normalizeLlmLocalSettingsByProfile(
        settings.llmLocalSettingsByProfile,
        llmLocalSettingsByProfileFallback
      );
      if (!settings.llmLocalSettingsByProfile) {
        llmLocalSettingsByProfile = {
          ...llmLocalSettingsByProfile,
          [llmLocalModelProfile]: normalizeLlmLocalModelSettings(
            llmLocalModelProfile,
            {
              modelId: settings.llmLocalModelId,
              temperature: settings.llmLocalTemperature,
              maxTokens: settings.llmLocalMaxTokens,
              dtypeWebgpu: settings.llmLocalDtypeWebgpu,
              dtypeWasm: settings.llmLocalDtypeWasm,
            },
            llmLocalSettingsByProfile[llmLocalModelProfile]
          ),
        };
      }
      const activeLlmLocalSettings = llmLocalSettingsByProfile[llmLocalModelProfile];
      const llmLocalModelId = activeLlmLocalSettings.modelId;
      const llmLocalTemperature = activeLlmLocalSettings.temperature;
      const llmLocalMaxTokens = activeLlmLocalSettings.maxTokens;
      const llmLocalBackendPreference = resolveBackendPreference(
        settings.llmLocalBackendPreference,
        support,
        state.llmLocalBackendPreference
      );
      const llmLocalDtypeWebgpu = activeLlmLocalSettings.dtypeWebgpu;
      const llmLocalDtypeWasm = activeLlmLocalSettings.dtypeWasm;
      const hydratedSecureTokens = normalizeSecureTokens({
        hfApiToken: state.hfApiToken,
        mistralApiKey: state.mistralApiKey,
      });
      lastPersistedSecureTokens = hydratedSecureTokens;

      return {
      ...state,
      hasHydrated: true,
      activePreset: sanitizePreset(settings.activePreset ?? state.activePreset),
      customModelId: settings.customModelId,
      modelQuantizationOverrides,
      blockedPresets,
      backendPreference: resolvedBackendPreference,
      micActivePreset: settings.micActivePreset ? sanitizePreset(settings.micActivePreset) : state.micActivePreset,
      micCustomModelId: settings.micCustomModelId ?? state.micCustomModelId,
      micBackendPreference: resolvedMicBackendPreference,
      memoryMode: settings.memoryMode,
      chunkStrategy: settings.chunkStrategy,
      segmentationMode: settings.segmentationMode,
      dedupeMode:
        settings.dedupeMode === "normal" || settings.dedupeMode === "fuzzy"
          ? settings.dedupeMode
          : state.dedupeMode,
      cleanIntraChunk:
        typeof settings.cleanIntraChunk === "boolean" ? settings.cleanIntraChunk : state.cleanIntraChunk,
      chunkDurationSec: settings.chunkDurationSec,
      overlapSec: settings.overlapSec,
      progressiveSegmentDurationSec: settings.progressiveSegmentDurationSec ?? state.progressiveSegmentDurationSec,
      silenceThresholdDb: settings.silenceThresholdDb,
      minSilenceMs: settings.minSilenceMs,
      minChunkMs: settings.minChunkMs,
      maxChunkMs: settings.maxChunkMs,
      showSegments: settings.showSegments ?? state.showSegments,
      showExportVtt: settings.showExportVtt ?? state.showExportVtt,
      showExportSrt: settings.showExportSrt ?? state.showExportSrt,
      showExportJson: settings.showExportJson ?? state.showExportJson,
      showExportTelemetry: settings.showExportTelemetry ?? state.showExportTelemetry,
      // Persisted debug toggle
      debugConfidence: settings.debugConfidence ?? state.debugConfidence,
      preprocessingMode: settings.preprocessingMode ?? state.preprocessingMode,
      denoiseNoiseFloorDb: settings.denoiseNoiseFloorDb ?? state.denoiseNoiseFloorDb,
      denoiseReductionDb: settings.denoiseReductionDb ?? state.denoiseReductionDb,
      denoiseSmoothing: settings.denoiseSmoothing ?? state.denoiseSmoothing,
      denoiseCalibrationSeconds: settings.denoiseCalibrationSeconds ?? state.denoiseCalibrationSeconds,
      preprocessEnableFilters: settings.preprocessEnableFilters ?? state.preprocessEnableFilters,
      preprocessHighpassHz: settings.preprocessHighpassHz ?? state.preprocessHighpassHz,
      preprocessLowpassHz: settings.preprocessLowpassHz ?? state.preprocessLowpassHz,
      preprocessEnableLufs: settings.preprocessEnableLufs ?? state.preprocessEnableLufs,
      preprocessTargetLufs: settings.preprocessTargetLufs ?? state.preprocessTargetLufs,
      preprocessLimiterEnabled: settings.preprocessLimiterEnabled ?? state.preprocessLimiterEnabled,
      preprocessLimiterThresholdDb: settings.preprocessLimiterThresholdDb ?? state.preprocessLimiterThresholdDb,
      preprocessLimiterSoftness: settings.preprocessLimiterSoftness ?? state.preprocessLimiterSoftness,
      preprocessVadEnabled: settings.preprocessVadEnabled ?? state.preprocessVadEnabled,
      preprocessVadThresholdDb: settings.preprocessVadThresholdDb ?? state.preprocessVadThresholdDb,
      preprocessVadMinSilenceMs: settings.preprocessVadMinSilenceMs ?? state.preprocessVadMinSilenceMs,
      preprocessOverlapAdd: settings.preprocessOverlapAdd ?? state.preprocessOverlapAdd,
      preprocessOverlapBlockSec: settings.preprocessOverlapBlockSec ?? state.preprocessOverlapBlockSec,
      preprocessOverlapSec: settings.preprocessOverlapSec ?? state.preprocessOverlapSec,
      micPreprocessingMode: settings.micPreprocessingMode ?? state.micPreprocessingMode,
      micSegmentationMode: settings.micSegmentationMode ?? state.micSegmentationMode,
      micSilenceThresholdDb: settings.micSilenceThresholdDb ?? state.micSilenceThresholdDb,
      micNoiseCalibrationMarginDb:
        typeof settings.micNoiseCalibrationMarginDb === "number"
          ? settings.micNoiseCalibrationMarginDb
          : state.micNoiseCalibrationMarginDb,
      micMinSilenceMs: settings.micMinSilenceMs ?? state.micMinSilenceMs,
      micMinChunkMs: settings.micMinChunkMs ?? state.micMinChunkMs,
      micMaxChunkMs: settings.micMaxChunkMs ?? state.micMaxChunkMs,
      micShowExportVtt: settings.micShowExportVtt ?? state.micShowExportVtt,
      micShowExportSrt: settings.micShowExportSrt ?? state.micShowExportSrt,
      micShowExportJson: settings.micShowExportJson ?? state.micShowExportJson,
      micShowExportTelemetry: settings.micShowExportTelemetry ?? state.micShowExportTelemetry,
      micDenoiseNoiseFloorDb: settings.micDenoiseNoiseFloorDb ?? state.micDenoiseNoiseFloorDb,
      micDenoiseReductionDb: settings.micDenoiseReductionDb ?? state.micDenoiseReductionDb,
      micDenoiseSmoothing: settings.micDenoiseSmoothing ?? state.micDenoiseSmoothing,
      micDenoiseCalibrationSeconds: settings.micDenoiseCalibrationSeconds ?? state.micDenoiseCalibrationSeconds,
      micPreprocessEnableFilters: settings.micPreprocessEnableFilters ?? state.micPreprocessEnableFilters,
      micPreprocessHighpassHz: settings.micPreprocessHighpassHz ?? state.micPreprocessHighpassHz,
      micPreprocessLowpassHz: settings.micPreprocessLowpassHz ?? state.micPreprocessLowpassHz,
      micPreprocessEnableLufs: settings.micPreprocessEnableLufs ?? state.micPreprocessEnableLufs,
      micPreprocessTargetLufs: settings.micPreprocessTargetLufs ?? state.micPreprocessTargetLufs,
      micPreprocessLimiterEnabled: settings.micPreprocessLimiterEnabled ?? state.micPreprocessLimiterEnabled,
      micPreprocessLimiterThresholdDb: settings.micPreprocessLimiterThresholdDb ?? state.micPreprocessLimiterThresholdDb,
      micPreprocessLimiterSoftness: settings.micPreprocessLimiterSoftness ?? state.micPreprocessLimiterSoftness,
      micPreprocessVadEnabled: settings.micPreprocessVadEnabled ?? state.micPreprocessVadEnabled,
      micPreprocessVadThresholdDb: settings.micPreprocessVadThresholdDb ?? state.micPreprocessVadThresholdDb,
      micPreprocessVadMinSilenceMs: settings.micPreprocessVadMinSilenceMs ?? state.micPreprocessVadMinSilenceMs,
      micPreprocessOverlapAdd: settings.micPreprocessOverlapAdd ?? state.micPreprocessOverlapAdd,
      micPreprocessOverlapBlockSec: settings.micPreprocessOverlapBlockSec ?? state.micPreprocessOverlapBlockSec,
      micPreprocessOverlapSec: settings.micPreprocessOverlapSec ?? state.micPreprocessOverlapSec,
      micAutoTunePreprocess: settings.micAutoTunePreprocess ?? state.micAutoTunePreprocess,
      micEnableWordTimestamps: settings.micEnableWordTimestamps ?? state.micEnableWordTimestamps,
      micShowSegmentConfidence: settings.micShowSegmentConfidence ?? state.micShowSegmentConfidence,
      micForceSingleThread: settings.micForceSingleThread ?? state.micForceSingleThread,
      cloudApiUrl: normalizedCloudApiUrl,
      hfApiToken: hydratedSecureTokens.hfApiToken,
      cloudMistralApiUrl: settings.cloudMistralApiUrl ?? state.cloudMistralApiUrl,
      mistralApiKey: hydratedSecureTokens.mistralApiKey,
      cloudMistralModel: normalizedCloudMistralModel,
      cloudMistralDiarizationEnabled:
        settings.cloudMistralDiarizationEnabled ?? state.cloudMistralDiarizationEnabled,
      cloudWhisperChunkDurationSec:
        settings.cloudWhisperChunkDurationSec ?? state.cloudWhisperChunkDurationSec,
      cloudWhisperOverlapSec: settings.cloudWhisperOverlapSec ?? state.cloudWhisperOverlapSec,
      cloudMistralChunkDurationSec:
        settings.cloudMistralChunkDurationSec ?? state.cloudMistralChunkDurationSec,
      cloudMistralOverlapSec: settings.cloudMistralOverlapSec ?? state.cloudMistralOverlapSec,
      cloudMaxTokens: settings.cloudMaxTokens ?? state.cloudMaxTokens,
      cloudTemperature: settings.cloudTemperature ?? state.cloudTemperature,
      cloudTopP: settings.cloudTopP ?? state.cloudTopP,
      cloudDoSample: settings.cloudDoSample ?? state.cloudDoSample,
      cloudContextPreset: settings.cloudContextPreset ?? state.cloudContextPreset,
      cloudShowSegments: settings.cloudShowSegments ?? state.cloudShowSegments,
      cloudShowExportVtt: settings.cloudShowExportVtt ?? state.cloudShowExportVtt,
      cloudShowExportSrt: settings.cloudShowExportSrt ?? state.cloudShowExportSrt,
      cloudShowExportJson: settings.cloudShowExportJson ?? state.cloudShowExportJson,
      cloudShowExportTelemetry: settings.cloudShowExportTelemetry ?? state.cloudShowExportTelemetry,
      cloudPreprocessingMode: settings.cloudPreprocessingMode ?? state.cloudPreprocessingMode,
      cloudDenoiseNoiseFloorDb: settings.cloudDenoiseNoiseFloorDb ?? state.cloudDenoiseNoiseFloorDb,
      cloudDenoiseReductionDb: settings.cloudDenoiseReductionDb ?? state.cloudDenoiseReductionDb,
      cloudDenoiseSmoothing: settings.cloudDenoiseSmoothing ?? state.cloudDenoiseSmoothing,
      cloudDenoiseCalibrationSeconds: settings.cloudDenoiseCalibrationSeconds ?? state.cloudDenoiseCalibrationSeconds,
      cloudPreprocessEnableFilters: settings.cloudPreprocessEnableFilters ?? state.cloudPreprocessEnableFilters,
      cloudPreprocessHighpassHz: settings.cloudPreprocessHighpassHz ?? state.cloudPreprocessHighpassHz,
      cloudPreprocessLowpassHz: settings.cloudPreprocessLowpassHz ?? state.cloudPreprocessLowpassHz,
      cloudPreprocessEnableLufs: settings.cloudPreprocessEnableLufs ?? state.cloudPreprocessEnableLufs,
      cloudPreprocessTargetLufs: settings.cloudPreprocessTargetLufs ?? state.cloudPreprocessTargetLufs,
      cloudPreprocessLimiterEnabled: settings.cloudPreprocessLimiterEnabled ?? state.cloudPreprocessLimiterEnabled,
      cloudPreprocessLimiterThresholdDb: settings.cloudPreprocessLimiterThresholdDb ?? state.cloudPreprocessLimiterThresholdDb,
      cloudPreprocessLimiterSoftness: settings.cloudPreprocessLimiterSoftness ?? state.cloudPreprocessLimiterSoftness,
      cloudPreprocessVadEnabled: settings.cloudPreprocessVadEnabled ?? state.cloudPreprocessVadEnabled,
      cloudPreprocessVadThresholdDb: settings.cloudPreprocessVadThresholdDb ?? state.cloudPreprocessVadThresholdDb,
      cloudPreprocessVadMinSilenceMs: settings.cloudPreprocessVadMinSilenceMs ?? state.cloudPreprocessVadMinSilenceMs,
      cloudPreprocessOverlapAdd: settings.cloudPreprocessOverlapAdd ?? state.cloudPreprocessOverlapAdd,
      cloudPreprocessOverlapBlockSec: settings.cloudPreprocessOverlapBlockSec ?? state.cloudPreprocessOverlapBlockSec,
      cloudPreprocessOverlapSec: settings.cloudPreprocessOverlapSec ?? state.cloudPreprocessOverlapSec,
      cloudAutoTunePreprocess: settings.cloudAutoTunePreprocess ?? state.cloudAutoTunePreprocess,
      cloudEnableWordTimestamps: settings.cloudEnableWordTimestamps ?? state.cloudEnableWordTimestamps,
      cloudShowSegmentConfidence: settings.cloudShowSegmentConfidence ?? state.cloudShowSegmentConfidence,
      llmApiProvider: persistedLlmProvider,
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiHfMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiMistralMaxTokens,
      llmLocalSettingsByProfile,
      llmLocalModelProfile,
      llmLocalModelId,
      llmLocalTemperature,
      llmLocalMaxTokens,
      llmLocalBackendPreference,
      llmLocalDtypeWebgpu,
      llmLocalDtypeWasm,
      llmLocalForceSingleThread: settings.llmLocalForceSingleThread ?? state.llmLocalForceSingleThread,
      autoTunePreprocess: settings.autoTunePreprocess ?? state.autoTunePreprocess,
      forceSingleThread: settings.forceSingleThread ?? state.forceSingleThread,
      enableWordTimestamps: settings.enableWordTimestamps ?? state.enableWordTimestamps,
      showSegmentConfidence: settings.showSegmentConfidence ?? state.showSegmentConfidence,
    };
    });
    void syncSecureTokensFromVault();
  },
  registerTelemetry: (collector) => set(() => ({ telemetryCollector: collector })),
  registerAudioSource: (source, metadata) =>
    set(() => ({ audioSource: source, audioMetadata: metadata ?? null })),
  setChunkPlan: (plan) => set(() => ({ chunkPlan: plan })),
  setSegments: (segments) => set(() => ({ segments })),
  appendSegments: (segments) =>
    set((state) => ({ segments: [...state.segments, ...segments] })),
  pushChunkMetric: (metric) =>
    set((state) => ({ chunkMetrics: [...state.chunkMetrics, metric] })),
  setTelemetrySummary: (summary) => set(() => ({ telemetrySummary: summary })),
  setTranscriptionConfidence: (value: number | null) => set(() => ({ transcriptionConfidence: value })),
  setTranscriptionConfidenceSource: (value) => set(() => ({ transcriptionConfidenceSource: value })),
  setDebugConfidence: (value) => set(() => ({ debugConfidence: value })),
  setUploadedFile: (file: File | null) => set(() => ({ uploadedFile: file })),
  setPreviewUrl: (url: string | null) => set(() => ({ previewUrl: url })),

  setForceSingleThread: (value: boolean) => set(() => ({ forceSingleThread: value })),
  setWasmThreads: (value: number | null) => set(() => ({ wasmThreads: value })),
  setIsTranscribing: (value) => set(() => ({ isTranscribing: value })),

  setProgress: (value) => set(() => ({ progress: value })),

  setPreprocessingMode: (mode) => set(() => ({ preprocessingMode: mode })),
  setPreprocessingStatus: (status) => set(() => ({ preprocessingStatus: status })),
  setPreprocessingProgress: (value) => set(() => ({ preprocessingProgress: value })),
  setSegmentationStatus: (status) => set(() => ({ segmentationStatus: status })),
  setSegmentationProgress: (value) => set(() => ({ segmentationProgress: value })),
  setDenoiseParams: (params) => set((state) => ({ ...state, ...params })),
  setPreprocessParams: (params) => set((state) => ({ ...state, ...params })),
  setMicPreset: (preset, customId) =>
    set(() => ({
      micActivePreset: sanitizePreset(preset),
      micCustomModelId: customId ?? "",
    })),
  setMicBackendPreference: (backend) =>
    set((state) => {
      if (backend === "webgpu" && !state.webGpuSupported) {
        if (state.micBackendPreference === "wasm") {
          return {};
        }
        return { micBackendPreference: "wasm" };
      }
      return { micBackendPreference: backend };
    }),
  setMicPreprocessingMode: (mode) => set(() => ({ micPreprocessingMode: mode })),
  setMicSegmentationMode: (mode) => set(() => ({ micSegmentationMode: mode })),
  setMicNoiseCalibrationMarginDb: (value) =>
    set(() => ({
      micNoiseCalibrationMarginDb: Number.isFinite(value) ? value : initialState.micNoiseCalibrationMarginDb,
    })),
  setMicSilenceParams: (params) =>
    set((state) => ({
      micSilenceThresholdDb: params.silenceThresholdDb ?? state.micSilenceThresholdDb,
      micMinSilenceMs: params.minSilenceMs ?? state.micMinSilenceMs,
      micMinChunkMs: params.minChunkMs ?? state.micMinChunkMs,
      micMaxChunkMs: params.maxChunkMs ?? state.micMaxChunkMs,
    })),
  setMicShowExportVtt: (value) => set(() => ({ micShowExportVtt: value })),
  setMicShowExportSrt: (value) => set(() => ({ micShowExportSrt: value })),
  setMicShowExportJson: (value) => set(() => ({ micShowExportJson: value })),
  setMicShowExportTelemetry: (value) => set(() => ({ micShowExportTelemetry: value })),
  setMicDenoiseParams: (params) =>
    set((state) => ({
      micDenoiseNoiseFloorDb: params.denoiseNoiseFloorDb ?? state.micDenoiseNoiseFloorDb,
      micDenoiseReductionDb: params.denoiseReductionDb ?? state.micDenoiseReductionDb,
      micDenoiseSmoothing: params.denoiseSmoothing ?? state.micDenoiseSmoothing,
      micDenoiseCalibrationSeconds: params.denoiseCalibrationSeconds ?? state.micDenoiseCalibrationSeconds,
    })),
  setMicPreprocessParams: (params) =>
    set((state) => ({
      micPreprocessEnableFilters: params.preprocessEnableFilters ?? state.micPreprocessEnableFilters,
      micPreprocessHighpassHz: params.preprocessHighpassHz ?? state.micPreprocessHighpassHz,
      micPreprocessLowpassHz: params.preprocessLowpassHz ?? state.micPreprocessLowpassHz,
      micPreprocessEnableLufs: params.preprocessEnableLufs ?? state.micPreprocessEnableLufs,
      micPreprocessTargetLufs: params.preprocessTargetLufs ?? state.micPreprocessTargetLufs,
      micPreprocessLimiterEnabled: params.preprocessLimiterEnabled ?? state.micPreprocessLimiterEnabled,
      micPreprocessLimiterThresholdDb: params.preprocessLimiterThresholdDb ?? state.micPreprocessLimiterThresholdDb,
      micPreprocessLimiterSoftness: params.preprocessLimiterSoftness ?? state.micPreprocessLimiterSoftness,
      micPreprocessVadEnabled: params.preprocessVadEnabled ?? state.micPreprocessVadEnabled,
      micPreprocessVadThresholdDb: params.preprocessVadThresholdDb ?? state.micPreprocessVadThresholdDb,
      micPreprocessVadMinSilenceMs: params.preprocessVadMinSilenceMs ?? state.micPreprocessVadMinSilenceMs,
      micPreprocessOverlapAdd: params.preprocessOverlapAdd ?? state.micPreprocessOverlapAdd,
      micPreprocessOverlapBlockSec: params.preprocessOverlapBlockSec ?? state.micPreprocessOverlapBlockSec,
      micPreprocessOverlapSec: params.preprocessOverlapSec ?? state.micPreprocessOverlapSec,
    })),
  setMicAutoTunePreprocess: (value) => set(() => ({ micAutoTunePreprocess: value })),
  setMicEnableWordTimestamps: (value) => set(() => ({ micEnableWordTimestamps: value })),
  setMicShowSegmentConfidence: (value) => set(() => ({ micShowSegmentConfidence: value })),
  setMicForceSingleThread: (value) => set(() => ({ micForceSingleThread: value })),
  setCloudStatus: (status, detail) =>
    set(() => ({
      cloudStatus: status,
      cloudStatusDetail: detail ?? undefined,
    })),
  setCloudApiUrl: (value) => set(() => ({ cloudApiUrl: value })),
  setHfApiToken: (value) => set(() => ({ hfApiToken: value })),
  setCloudMistralApiUrl: (value) => set(() => ({ cloudMistralApiUrl: value })),
  setMistralApiKey: (value) => set(() => ({ mistralApiKey: value })),
  setCloudMistralModel: (value) => set(() => ({ cloudMistralModel: value })),
  setCloudMistralDiarizationEnabled: (value) => set(() => ({ cloudMistralDiarizationEnabled: value })),
  setCloudWhisperChunking: (params) =>
    set((state) => ({
      cloudWhisperChunkDurationSec: params.chunkDurationSec ?? state.cloudWhisperChunkDurationSec,
      cloudWhisperOverlapSec: params.overlapSec ?? state.cloudWhisperOverlapSec,
    })),
  setCloudMistralChunking: (params) =>
    set((state) => ({
      cloudMistralChunkDurationSec: params.chunkDurationSec ?? state.cloudMistralChunkDurationSec,
      cloudMistralOverlapSec: params.overlapSec ?? state.cloudMistralOverlapSec,
    })),
  setCloudMaxTokens: (value) => set(() => ({ cloudMaxTokens: value })),
  setCloudTemperature: (value) => set(() => ({ cloudTemperature: value })),
  setCloudTopP: (value) => set(() => ({ cloudTopP: value })),
  setCloudDoSample: (value) => set(() => ({ cloudDoSample: value })),
  setCloudContextPreset: (value) => set(() => ({ cloudContextPreset: value })),
  setCloudShowSegments: (value) => set(() => ({ cloudShowSegments: value })),
  setCloudShowExportVtt: (value) => set(() => ({ cloudShowExportVtt: value })),
  setCloudShowExportSrt: (value) => set(() => ({ cloudShowExportSrt: value })),
  setCloudShowExportJson: (value) => set(() => ({ cloudShowExportJson: value })),
  setCloudShowExportTelemetry: (value) => set(() => ({ cloudShowExportTelemetry: value })),
  setCloudPreprocessingMode: (mode) => set(() => ({ cloudPreprocessingMode: mode })),
  setCloudDenoiseParams: (params) =>
    set((state) => ({
      cloudDenoiseNoiseFloorDb: params.denoiseNoiseFloorDb ?? state.cloudDenoiseNoiseFloorDb,
      cloudDenoiseReductionDb: params.denoiseReductionDb ?? state.cloudDenoiseReductionDb,
      cloudDenoiseSmoothing: params.denoiseSmoothing ?? state.cloudDenoiseSmoothing,
      cloudDenoiseCalibrationSeconds: params.denoiseCalibrationSeconds ?? state.cloudDenoiseCalibrationSeconds,
    })),
  setCloudPreprocessParams: (params) =>
    set((state) => ({
      cloudPreprocessEnableFilters: params.preprocessEnableFilters ?? state.cloudPreprocessEnableFilters,
      cloudPreprocessHighpassHz: params.preprocessHighpassHz ?? state.cloudPreprocessHighpassHz,
      cloudPreprocessLowpassHz: params.preprocessLowpassHz ?? state.cloudPreprocessLowpassHz,
      cloudPreprocessEnableLufs: params.preprocessEnableLufs ?? state.cloudPreprocessEnableLufs,
      cloudPreprocessTargetLufs: params.preprocessTargetLufs ?? state.cloudPreprocessTargetLufs,
      cloudPreprocessLimiterEnabled: params.preprocessLimiterEnabled ?? state.cloudPreprocessLimiterEnabled,
      cloudPreprocessLimiterThresholdDb:
        params.preprocessLimiterThresholdDb ?? state.cloudPreprocessLimiterThresholdDb,
      cloudPreprocessLimiterSoftness: params.preprocessLimiterSoftness ?? state.cloudPreprocessLimiterSoftness,
      cloudPreprocessVadEnabled: params.preprocessVadEnabled ?? state.cloudPreprocessVadEnabled,
      cloudPreprocessVadThresholdDb: params.preprocessVadThresholdDb ?? state.cloudPreprocessVadThresholdDb,
      cloudPreprocessVadMinSilenceMs: params.preprocessVadMinSilenceMs ?? state.cloudPreprocessVadMinSilenceMs,
      cloudPreprocessOverlapAdd: params.preprocessOverlapAdd ?? state.cloudPreprocessOverlapAdd,
      cloudPreprocessOverlapBlockSec: params.preprocessOverlapBlockSec ?? state.cloudPreprocessOverlapBlockSec,
      cloudPreprocessOverlapSec: params.preprocessOverlapSec ?? state.cloudPreprocessOverlapSec,
    })),
  setCloudAutoTunePreprocess: (value) => set(() => ({ cloudAutoTunePreprocess: value })),
  setCloudEnableWordTimestamps: (value) => set(() => ({ cloudEnableWordTimestamps: value })),
  setCloudShowSegmentConfidence: (value) => set(() => ({ cloudShowSegmentConfidence: value })),
  setLlmApiProvider: (value) => set(() => ({ llmApiProvider: value })),
  setLlmApiHfModelId: (value) => set(() => ({ llmApiHfModelId: value })),
  setLlmApiHfTemperature: (value) =>
    set(() => ({ llmApiHfTemperature: normalizeLlmTemperature(value, DEFAULT_LLM_HF_TEMPERATURE) })),
  setLlmApiHfMaxTokens: (value) =>
    set(() => ({ llmApiHfMaxTokens: normalizeLlmMaxTokens(value, DEFAULT_LLM_HF_MAX_TOKENS) })),
  setLlmApiMistralModelId: (value) => set(() => ({ llmApiMistralModelId: value })),
  setLlmApiMistralTemperature: (value) =>
    set(() => ({ llmApiMistralTemperature: normalizeLlmTemperature(value, DEFAULT_LLM_MISTRAL_TEMPERATURE) })),
  setLlmApiMistralMaxTokens: (value) =>
    set(() => ({ llmApiMistralMaxTokens: normalizeLlmMaxTokens(value, DEFAULT_LLM_MISTRAL_MAX_TOKENS) })),
  setLlmApiStatus: (status, detail) => set(() => ({ llmApiStatus: status, llmApiStatusDetail: detail ?? undefined })),
  setLlmApiProgress: (value) =>
    set(() => ({ llmApiProgress: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 })),
  setLlmApiResult: (format, value) =>
    set((state) => ({ llmApiResults: { ...state.llmApiResults, [format]: value } })),
  setLlmApiResults: (value) => set(() => ({ llmApiResults: value })),
  resetLlmApiSession: () =>
    set(() => ({
      llmApiStatus: "idle",
      llmApiStatusDetail: undefined,
      llmApiProgress: 0,
      llmApiResults: {},
    })),
  setLlmLocalModelProfile: (value) =>
    set((state) => {
      const profile = normalizeLlmLocalModelProfile(value, state.llmLocalModelProfile);
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const nextSettings = normalizeLlmLocalModelSettings(
        profile,
        state.llmLocalSettingsByProfile[profile],
        fallback
      );
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: nextSettings,
        },
        llmLocalModelProfile: profile,
        llmLocalModelId: nextSettings.modelId,
        llmLocalTemperature: nextSettings.temperature,
        llmLocalMaxTokens: nextSettings.maxTokens,
        llmLocalDtypeWebgpu: nextSettings.dtypeWebgpu,
        llmLocalDtypeWasm: nextSettings.dtypeWasm,
      };
    }),
  setLlmLocalModelId: (value) =>
    set((state) => {
      const profile = state.llmLocalModelProfile;
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const current = normalizeLlmLocalModelSettings(profile, state.llmLocalSettingsByProfile[profile], fallback);
      const updated = normalizeLlmLocalModelSettings(profile, { modelId: value }, current);
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: updated,
        },
        llmLocalModelId: updated.modelId,
      };
    }),
  setLlmLocalTemperature: (value) =>
    set((state) => {
      const profile = state.llmLocalModelProfile;
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const current = normalizeLlmLocalModelSettings(profile, state.llmLocalSettingsByProfile[profile], fallback);
      const updated = normalizeLlmLocalModelSettings(
        profile,
        { temperature: normalizeLlmTemperature(value, DEFAULT_LLM_LOCAL_TEMPERATURE) },
        current
      );
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: updated,
        },
        llmLocalTemperature: updated.temperature,
      };
    }),
  setLlmLocalMaxTokens: (value) =>
    set((state) => {
      const profile = state.llmLocalModelProfile;
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const current = normalizeLlmLocalModelSettings(profile, state.llmLocalSettingsByProfile[profile], fallback);
      const updated = normalizeLlmLocalModelSettings(
        profile,
        { maxTokens: normalizeLlmMaxTokens(value, DEFAULT_LLM_LOCAL_MAX_TOKENS) },
        current
      );
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: updated,
        },
        llmLocalMaxTokens: updated.maxTokens,
      };
    }),
  setLlmLocalBackendPreference: (value) =>
    set((state) => {
      if (value === "webgpu" && !state.webGpuSupported) {
        if (state.llmLocalBackendPreference === "wasm") return {};
        return { llmLocalBackendPreference: "wasm" };
      }
      if (value === "wasm" && !state.wasmAvailable) {
        return { llmLocalBackendPreference: "webgpu" };
      }
      return { llmLocalBackendPreference: value };
    }),
  setLlmLocalDtypeWebgpu: (value) =>
    set((state) => {
      const profile = state.llmLocalModelProfile;
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const current = normalizeLlmLocalModelSettings(profile, state.llmLocalSettingsByProfile[profile], fallback);
      const updated = normalizeLlmLocalModelSettings(
        profile,
        { dtypeWebgpu: normalizeLlmLocalDtype(value, DEFAULT_LLM_LOCAL_DTYPE_WEBGPU) },
        current
      );
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: updated,
        },
        llmLocalDtypeWebgpu: updated.dtypeWebgpu,
      };
    }),
  setLlmLocalDtypeWasm: (value) =>
    set((state) => {
      const profile = state.llmLocalModelProfile;
      const fallback = normalizeLlmLocalModelSettings(
        profile,
        undefined,
        createDefaultLocalModelSettings(profile)
      );
      const current = normalizeLlmLocalModelSettings(profile, state.llmLocalSettingsByProfile[profile], fallback);
      const updated = normalizeLlmLocalModelSettings(
        profile,
        { dtypeWasm: normalizeLlmLocalDtype(value, DEFAULT_LLM_LOCAL_DTYPE_WASM) },
        current
      );
      return {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [profile]: updated,
        },
        llmLocalDtypeWasm: updated.dtypeWasm,
      };
    }),
  setLlmLocalForceSingleThread: (value) => set(() => ({ llmLocalForceSingleThread: value })),
  setLlmLocalModelSettings: (profile, patch) =>
    set((state) => {
      const normalizedProfile = normalizeLlmLocalModelProfile(profile, state.llmLocalModelProfile);
      const fallback = normalizeLlmLocalModelSettings(
        normalizedProfile,
        undefined,
        createDefaultLocalModelSettings(normalizedProfile)
      );
      const current = normalizeLlmLocalModelSettings(
        normalizedProfile,
        state.llmLocalSettingsByProfile[normalizedProfile],
        fallback
      );
      const updated = normalizeLlmLocalModelSettings(normalizedProfile, patch, current);
      const next = {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [normalizedProfile]: updated,
        },
      } as Partial<AsrConfigStore>;

      if (normalizedProfile === state.llmLocalModelProfile) {
        next.llmLocalModelId = updated.modelId;
        next.llmLocalTemperature = updated.temperature;
        next.llmLocalMaxTokens = updated.maxTokens;
        next.llmLocalDtypeWebgpu = updated.dtypeWebgpu;
        next.llmLocalDtypeWasm = updated.dtypeWasm;
      }

      return next as Partial<AsrConfigStore>;
    }),
  resetLlmLocalModelSettings: (profile) =>
    set((state) => {
      const normalizedProfile = normalizeLlmLocalModelProfile(profile, state.llmLocalModelProfile);
      const resetSettings = normalizeLlmLocalModelSettings(
        normalizedProfile,
        undefined,
        createDefaultLocalModelSettings(normalizedProfile)
      );
      const next = {
        llmLocalSettingsByProfile: {
          ...state.llmLocalSettingsByProfile,
          [normalizedProfile]: resetSettings,
        },
      } as Partial<AsrConfigStore>;

      if (normalizedProfile === state.llmLocalModelProfile) {
        next.llmLocalModelId = resetSettings.modelId;
        next.llmLocalTemperature = resetSettings.temperature;
        next.llmLocalMaxTokens = resetSettings.maxTokens;
        next.llmLocalDtypeWebgpu = resetSettings.dtypeWebgpu;
        next.llmLocalDtypeWasm = resetSettings.dtypeWasm;
      }

      return next as Partial<AsrConfigStore>;
    }),
  setLlmLocalStatus: (status, detail) =>
    set(() => ({ llmLocalStatus: status, llmLocalStatusDetail: detail ?? undefined })),
  setLlmLocalProgress: (value) =>
    set(() => ({ llmLocalProgress: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 })),
  setLlmLocalResult: (format, value) =>
    set((state) => ({ llmLocalResults: { ...state.llmLocalResults, [format]: value } })),
  setLlmLocalResults: (value) => set(() => ({ llmLocalResults: value })),
  setLocalUploadModelSizeAlert: (alert) => set(() => ({ localUploadModelSizeAlert: alert })),
  clearLocalUploadModelSizeAlert: () => set(() => ({ localUploadModelSizeAlert: null })),
  setLlmLocalModelSizeAlert: (alert) => set(() => ({ llmLocalModelSizeAlert: alert })),
  clearLlmLocalModelSizeAlert: () => set(() => ({ llmLocalModelSizeAlert: null })),
  resetLlmLocalSession: () =>
    set(() => ({
      llmLocalStatus: "idle",
      llmLocalStatusDetail: undefined,
      llmLocalProgress: 0,
      llmLocalResults: {},
      llmLocalModelSizeAlert: null,
    })),
  setAutoTunePreprocess: (value: boolean) => set(() => ({ autoTunePreprocess: value })),
  setLastAutoTuneParams: (params) => set(() => ({ lastAutoTuneParams: params })),
  requestNoiseCalibration: () => set(() => ({ noiseCalibrationRequestedAt: Date.now() })),
  clearNoiseCalibrationRequest: () => set(() => ({ noiseCalibrationRequestedAt: null })),
  requestStop: () => set(() => ({ stopRequested: true })),
  resetStopRequest: () => set(() => ({ stopRequested: false })),
  resetSession: () =>
    set((state) => ({
      ...state,
      resetCounter: state.resetCounter + 1,
      status: "idle",
      statusDetail: undefined,
      cloudStatus: "idle",
      cloudStatusDetail: undefined,
      activeBackend: undefined,
      telemetryCollector: null,
      chunkPlan: [],
      chunkMetrics: [],
      segments: [],
      audioMetadata: null,
      audioSource: null,
      isTranscribing: false,
      stopRequested: false,
      progress: 0,
      preprocessingStatus: "idle",
      preprocessingProgress: 0,
      segmentationStatus: "idle",
      segmentationProgress: 0,
      transcriptionConfidence: null,
      transcriptionConfidenceSource: null,
      llmApiStatus: "idle",
      llmApiStatusDetail: undefined,
      llmApiProgress: 0,
      llmApiResults: {},
      llmLocalStatus: "idle",
      llmLocalStatusDetail: undefined,
      llmLocalProgress: 0,
      llmLocalResults: {},
      localUploadModelSizeAlert: null,
      llmLocalModelSizeAlert: null,
      // Preserve debug toggle across session resets
      debugConfidence: state.debugConfidence,
      previewUrl: state.previewUrl,
    })),

  resetApp: () =>
    set((state) => {
      // Persist default settings and reset in-memory state
      try {
        saveSettings(DEFAULT_SETTINGS);
      } catch (e) {
        // Use logger so debug toggle controls this output
        logger.warn("resetApp: failed to persist default settings", e);
      }
      void clearSecureTokens();
      return {
        ...initialState,
        hasHydrated: true,
        resetCounter: state.resetCounter + 1,
        // Preserve runtime capability detection
        webGpuSupported: state.webGpuSupported,
        wasmAvailable: state.wasmAvailable,
        status: "idle",
        statusDetail: undefined,
        activeBackend: undefined,
        telemetryCollector: null,
        chunkPlan: [],
        chunkMetrics: [],
        segments: [],
        audioMetadata: null,
        audioSource: null,
        telemetrySummary: null,
        transcriptionConfidence: null,
        transcriptionConfidenceSource: null,
        isTranscribing: false,
        stopRequested: false,
        progress: 0,
        preprocessingStatus: "idle",
        preprocessingProgress: 0,
        segmentationStatus: "idle",
        segmentationProgress: 0,
      };
    }),

  setWebGpuSupport: (supported) => set(() => ({ webGpuSupported: supported })),
  setWasmAvailable: (available) => set(() => ({ wasmAvailable: available })),
  setEnableWordTimestamps: (value: boolean) => set(() => ({ enableWordTimestamps: value })),
  setShowSegmentConfidence: (value: boolean) => set(() => ({ showSegmentConfidence: value })), 

}));

export function resolveModelId(activePreset: PresetKey, customModelId: string) {
  if (activePreset === "custom" && customModelId.trim().length > 0) {
    return customModelId.trim();
  }
  if (activePreset === "custom") {
    return MODEL_PRESETS.fast.modelId;
  }
  return MODEL_PRESETS[activePreset].modelId;
}

export function resolveLighterPresetForMemoryFallback(
  activePreset: PresetKey,
  blockedPresets: PresetKey[] = []
): BuiltInPresetKey | null {
  const blocked = new Set(blockedPresets);
  const candidates = MEMORY_FALLBACK_PRESETS[activePreset] ?? [];
  for (const preset of candidates) {
    if (!blocked.has(preset)) {
      return preset;
    }
  }
  return null;
}

export function resolveModelDtype(activePreset: PresetKey, backend: BackendImplementation): ModelDtype | undefined {
  if (activePreset === "custom") {
    return undefined;
  }
  return MODEL_PRESETS[activePreset].quantization[backend];
}

export function resolveEffectiveModelDtype(
  activePreset: PresetKey,
  backend: BackendImplementation,
  overrides: PresetQuantizationOverrides | undefined
): ModelDtype | undefined {
  if (activePreset === "custom") {
    return undefined;
  }
  return overrides?.[activePreset]?.[backend] ?? MODEL_PRESETS[activePreset].quantization[backend];
}

let lastPersistedSecureTokens: SecureTokens = normalizeSecureTokens(null);

useAsrStore.subscribe((state) => {
  if (!state.hasHydrated) {
    return;
  }
  const payload: PersistedSettings = {
      activePreset: state.activePreset,
      customModelId: state.customModelId,
      presetQuantizationOverrides: state.modelQuantizationOverrides,
      blockedPresets: state.blockedPresets,
      backendPreference: state.backendPreference,
    micActivePreset: state.micActivePreset,
    micCustomModelId: state.micCustomModelId,
    micBackendPreference: state.micBackendPreference,
    memoryMode: state.memoryMode,
    chunkStrategy: state.chunkStrategy,
    segmentationMode: state.segmentationMode,
    dedupeMode: state.dedupeMode,
    cleanIntraChunk: state.cleanIntraChunk,
    chunkDurationSec: state.chunkDurationSec,
    overlapSec: state.overlapSec,
    progressiveSegmentDurationSec: state.progressiveSegmentDurationSec,
    silenceThresholdDb: state.silenceThresholdDb,
    minSilenceMs: state.minSilenceMs,
    minChunkMs: state.minChunkMs,
    maxChunkMs: state.maxChunkMs,
    showSegments: state.showSegments,
    showExportVtt: state.showExportVtt,
    showExportSrt: state.showExportSrt,
    showExportJson: state.showExportJson,
    showExportTelemetry: state.showExportTelemetry,
    preprocessingMode: state.preprocessingMode,
    denoiseNoiseFloorDb: state.denoiseNoiseFloorDb,
    denoiseReductionDb: state.denoiseReductionDb,
    denoiseSmoothing: state.denoiseSmoothing,
    denoiseCalibrationSeconds: state.denoiseCalibrationSeconds,
    preprocessEnableFilters: state.preprocessEnableFilters,
    preprocessHighpassHz: state.preprocessHighpassHz,
    preprocessLowpassHz: state.preprocessLowpassHz,
    preprocessEnableLufs: state.preprocessEnableLufs,
    preprocessTargetLufs: state.preprocessTargetLufs,
    preprocessLimiterEnabled: state.preprocessLimiterEnabled,
    preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
    preprocessLimiterSoftness: state.preprocessLimiterSoftness,
    preprocessVadEnabled: state.preprocessVadEnabled,
    preprocessVadThresholdDb: state.preprocessVadThresholdDb,
    preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
    preprocessOverlapAdd: state.preprocessOverlapAdd,
    preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
    preprocessOverlapSec: state.preprocessOverlapSec,
    micPreprocessingMode: state.micPreprocessingMode,
    micSegmentationMode: state.micSegmentationMode,
    micSilenceThresholdDb: state.micSilenceThresholdDb,
    micNoiseCalibrationMarginDb: state.micNoiseCalibrationMarginDb,
    micMinSilenceMs: state.micMinSilenceMs,
    micMinChunkMs: state.micMinChunkMs,
    micMaxChunkMs: state.micMaxChunkMs,
    micShowExportVtt: state.micShowExportVtt,
    micShowExportSrt: state.micShowExportSrt,
    micShowExportJson: state.micShowExportJson,
    micShowExportTelemetry: state.micShowExportTelemetry,
    micDenoiseNoiseFloorDb: state.micDenoiseNoiseFloorDb,
    micDenoiseReductionDb: state.micDenoiseReductionDb,
    micDenoiseSmoothing: state.micDenoiseSmoothing,
    micDenoiseCalibrationSeconds: state.micDenoiseCalibrationSeconds,
    micPreprocessEnableFilters: state.micPreprocessEnableFilters,
    micPreprocessHighpassHz: state.micPreprocessHighpassHz,
    micPreprocessLowpassHz: state.micPreprocessLowpassHz,
    micPreprocessEnableLufs: state.micPreprocessEnableLufs,
    micPreprocessTargetLufs: state.micPreprocessTargetLufs,
    micPreprocessLimiterEnabled: state.micPreprocessLimiterEnabled,
    micPreprocessLimiterThresholdDb: state.micPreprocessLimiterThresholdDb,
    micPreprocessLimiterSoftness: state.micPreprocessLimiterSoftness,
    micPreprocessVadEnabled: state.micPreprocessVadEnabled,
    micPreprocessVadThresholdDb: state.micPreprocessVadThresholdDb,
    micPreprocessVadMinSilenceMs: state.micPreprocessVadMinSilenceMs,
    micPreprocessOverlapAdd: state.micPreprocessOverlapAdd,
    micPreprocessOverlapBlockSec: state.micPreprocessOverlapBlockSec,
    micPreprocessOverlapSec: state.micPreprocessOverlapSec,
    micAutoTunePreprocess: state.micAutoTunePreprocess,
    // performance
    forceSingleThread: state.forceSingleThread,
    micForceSingleThread: state.micForceSingleThread,
    // cloud
    cloudApiUrl: state.cloudApiUrl,
    cloudMistralApiUrl: state.cloudMistralApiUrl,
    cloudMistralModel: state.cloudMistralModel,
    cloudMistralDiarizationEnabled: state.cloudMistralDiarizationEnabled,
    cloudWhisperChunkDurationSec: state.cloudWhisperChunkDurationSec,
    cloudWhisperOverlapSec: state.cloudWhisperOverlapSec,
    cloudMistralChunkDurationSec: state.cloudMistralChunkDurationSec,
    cloudMistralOverlapSec: state.cloudMistralOverlapSec,
    cloudMaxTokens: state.cloudMaxTokens,
    cloudTemperature: state.cloudTemperature,
    cloudTopP: state.cloudTopP,
    cloudDoSample: state.cloudDoSample,
    cloudContextPreset: state.cloudContextPreset,
    cloudShowSegments: state.cloudShowSegments,
    cloudShowExportVtt: state.cloudShowExportVtt,
    cloudShowExportSrt: state.cloudShowExportSrt,
    cloudShowExportJson: state.cloudShowExportJson,
    cloudShowExportTelemetry: state.cloudShowExportTelemetry,
    cloudPreprocessingMode: state.cloudPreprocessingMode,
    cloudDenoiseNoiseFloorDb: state.cloudDenoiseNoiseFloorDb,
    cloudDenoiseReductionDb: state.cloudDenoiseReductionDb,
    cloudDenoiseSmoothing: state.cloudDenoiseSmoothing,
    cloudDenoiseCalibrationSeconds: state.cloudDenoiseCalibrationSeconds,
    cloudPreprocessEnableFilters: state.cloudPreprocessEnableFilters,
    cloudPreprocessHighpassHz: state.cloudPreprocessHighpassHz,
    cloudPreprocessLowpassHz: state.cloudPreprocessLowpassHz,
    cloudPreprocessEnableLufs: state.cloudPreprocessEnableLufs,
    cloudPreprocessTargetLufs: state.cloudPreprocessTargetLufs,
    cloudPreprocessLimiterEnabled: state.cloudPreprocessLimiterEnabled,
    cloudPreprocessLimiterThresholdDb: state.cloudPreprocessLimiterThresholdDb,
    cloudPreprocessLimiterSoftness: state.cloudPreprocessLimiterSoftness,
    cloudPreprocessVadEnabled: state.cloudPreprocessVadEnabled,
    cloudPreprocessVadThresholdDb: state.cloudPreprocessVadThresholdDb,
    cloudPreprocessVadMinSilenceMs: state.cloudPreprocessVadMinSilenceMs,
    cloudPreprocessOverlapAdd: state.cloudPreprocessOverlapAdd,
    cloudPreprocessOverlapBlockSec: state.cloudPreprocessOverlapBlockSec,
    cloudPreprocessOverlapSec: state.cloudPreprocessOverlapSec,
    cloudAutoTunePreprocess: state.cloudAutoTunePreprocess,
    cloudEnableWordTimestamps: state.cloudEnableWordTimestamps,
    cloudShowSegmentConfidence: state.cloudShowSegmentConfidence,
    llmApiProvider: state.llmApiProvider,
    llmApiHfModelId: state.llmApiHfModelId,
    llmApiHfTemperature: state.llmApiHfTemperature,
    llmApiHfMaxTokens: state.llmApiHfMaxTokens,
    llmApiMistralModelId: state.llmApiMistralModelId,
    llmApiMistralTemperature: state.llmApiMistralTemperature,
    llmApiMistralMaxTokens: state.llmApiMistralMaxTokens,
    llmLocalModelProfile: state.llmLocalModelProfile,
    llmLocalModelId: state.llmLocalModelId,
    llmLocalTemperature: state.llmLocalTemperature,
    llmLocalMaxTokens: state.llmLocalMaxTokens,
    llmLocalBackendPreference: state.llmLocalBackendPreference,
    llmLocalDtypeWebgpu: state.llmLocalDtypeWebgpu,
    llmLocalDtypeWasm: state.llmLocalDtypeWasm,
    llmLocalSettingsByProfile: state.llmLocalSettingsByProfile,
    llmLocalForceSingleThread: state.llmLocalForceSingleThread,
    // whisper
    enableWordTimestamps: state.enableWordTimestamps,
    showSegmentConfidence: state.showSegmentConfidence,
    micEnableWordTimestamps: state.micEnableWordTimestamps,
    micShowSegmentConfidence: state.micShowSegmentConfidence,
    // debug
    debugConfidence: state.debugConfidence,
  };
  saveSettings(payload);
  const secureTokens = normalizeSecureTokens({
    hfApiToken: state.hfApiToken,
    mistralApiKey: state.mistralApiKey,
  });
  const secureTokensChanged =
    secureTokens.hfApiToken !== lastPersistedSecureTokens.hfApiToken ||
    secureTokens.mistralApiKey !== lastPersistedSecureTokens.mistralApiKey;
  if (secureTokensChanged) {
    lastPersistedSecureTokens = secureTokens;
    if (hasAnySecureToken(secureTokens)) {
      void saveSecureTokens(secureTokens);
    } else {
      void clearSecureTokens();
    }
  }
});
