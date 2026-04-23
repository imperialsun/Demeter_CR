import { create } from "zustand";
import logger, { type LogLevel } from "@/lib/logger";
import {
  loadSettings,
  saveSettings,
  type PersistedSettings,
  type PersistedSettingsInput,
  DEFAULT_SETTINGS,
  clampDemeterChunkDurationSec,
  normalizeLlmReportGenerationMode,
  normalizeLlmReportChunkRatio,
  normalizeLlmReportMaxSubpartsPerPart,
  normalizeLlmReportMonoPassMaxTokens,
  normalizeLlmReportWorkflowTextMaxTokens,
  type LlmReportGenerationMode,
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
import type { ExportHeader, TranscriptionSegment } from "@/lib/export";
import {
  createEmptySessionTranscriptMemories,
  clearSessionTranscriptMemoriesFromSessionStorage,
  getSessionTranscriptSegmentCount,
  getSessionTranscriptText,
  loadSessionTranscriptMemoriesFromSessionStorage,
  saveSessionTranscriptMemoriesToSessionStorage,
  type SessionSource,
  type SessionTranscriptMemoryEntry,
  type SessionTranscriptMode,
} from "@/lib/sessionTranscriptMemory";
import type { SpeakerAssignment, SpeakerAssignmentMap } from "@/lib/speakerAssignments";
import type { TelemetryCollector, ChunkTelemetry, TelemetrySummary } from "@/lib/telemetry";
import {
  createDefaultAssistantWorkflowRuntime,
  createDefaultCloudTranscriptionSessionRuntime,
  type AssistantWorkflowRuntime,
  type CloudTranscriptionSessionRuntime,
} from "@/lib/cloud/transcriptionSession";
import {
  cloneReportJson,
  type ReportFormat,
  type ReportJson,
  type ReportResult,
  type ReportResultKey,
} from "@/lib/llm/reportSchema";
import {
  DEFAULT_REPORT_DETAIL_LEVELS,
  normalizeReportDetailLevel,
  normalizeReportDetailLevels,
  type ReportDetailLevel,
} from "@/lib/llm/reportDetail";
import {
  canonicalizeLocalLlmModelId,
  createDefaultLocalModelSettings,
  createDefaultLocalModelSettingsByProfile,
  DEFAULT_LLM_LOCAL_MAX_TOKENS,
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
const LOG_LEVEL_VALUES: readonly LogLevel[] = ["error", "warn", "info", "debug"] as const;
const ALLOWED_LOG_LEVELS = new Set<LogLevel>(LOG_LEVEL_VALUES);

function normalizeLogLevel(value: unknown, fallback: LogLevel = "info"): LogLevel {
  return typeof value === "string" && ALLOWED_LOG_LEVELS.has(value as LogLevel) ? (value as LogLevel) : fallback;
}

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
export type LlmApiProvider = "huggingface" | "mistral" | "demeter_sante";
export type LlmLocalModelProfile = "qwen_0_6b" | "qwen_1_7b" | "ministral_3_3b";
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
const DEFAULT_LLM_HF_TEMPERATURE = 0.2;
const DEFAULT_LLM_HF_MAX_TOKENS = 131072;
const DEFAULT_LLM_MISTRAL_TEMPERATURE = 0.2;
const DEFAULT_LLM_MISTRAL_MAX_TOKENS = 8192;
const DEFAULT_LLM_LOCAL_DTYPE_WEBGPU: ModelDtype = "q4f16";
const DEFAULT_LLM_LOCAL_DTYPE_WASM: ModelDtype = "q8";
const LLM_LOCAL_PROFILES: LlmLocalModelProfile[] = ["qwen_0_6b", "qwen_1_7b", "ministral_3_3b"];
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

export const normalizeMistralModel = (value: string | undefined, fallback: string) => {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return fallback;
  if (trimmed.toLowerCase() === LEGACY_MISTRAL_MODEL) {
    return DEFAULT_MISTRAL_MODEL;
  }
  return trimmed;
};

const normalizeLlmApiProvider = (value: string | undefined, fallback: LlmApiProvider): LlmApiProvider => {
  if (value === "huggingface" || value === "mistral" || value === "demeter_sante") return value;
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
  if (value === "qwen_0_6b" || value === "qwen_1_7b" || value === "ministral_3_3b") return value;
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

type ExportMode = ExportHeader["mode"];

const createEmptySpeakerAssignmentsByMode = (): Record<ExportMode, SpeakerAssignmentMap> => ({
  upload: {},
  mic: {},
  cloud: {},
});

const normalizeSpeakerId = (speakerId: string) => speakerId.trim();

const normalizeSpeakerAssignment = (value: SpeakerAssignment): SpeakerAssignment => ({
  firstName: value.firstName.trim(),
  lastName: value.lastName.trim(),
});

const hasSpeakerName = (value: SpeakerAssignment) =>
  value.firstName.length > 0 || value.lastName.length > 0;

const normalizeSpeakerAssignments = (assignments: SpeakerAssignmentMap): SpeakerAssignmentMap => {
  const normalized: SpeakerAssignmentMap = {};
  for (const [speakerId, value] of Object.entries(assignments)) {
    const normalizedSpeakerId = normalizeSpeakerId(speakerId);
    if (!normalizedSpeakerId) continue;
    const normalizedValue = normalizeSpeakerAssignment({
      firstName: typeof value?.firstName === "string" ? value.firstName : "",
      lastName: typeof value?.lastName === "string" ? value.lastName : "",
    });
    if (!hasSpeakerName(normalizedValue)) continue;
    normalized[normalizedSpeakerId] = normalizedValue;
  }
  return normalized;
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
  hfApiToken: string;
  cloudMistralApiUrl: string;
  mistralApiKey: string;
  cloudMistralModel: string;
  cloudMistralDiarizationEnabled: boolean;
  cloudDemeterModel: string;
  cloudDemeterDiarizationEnabled: boolean;
  cloudDemeterChunkDurationSec: number;
  cloudWhisperChunkDurationSec: number;
  cloudWhisperOverlapSec: number;
  cloudMistralChunkDurationSec: number;
  cloudMistralOverlapSec: number;
  cloudMaxTokens: number;
  cloudTemperature: number;
  cloudTopP: number;
  cloudDoSample: boolean;
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
  llmApiReportDetailLevels: Record<ReportFormat, ReportDetailLevel>;
  llmApiReportGenerationMode: LlmReportGenerationMode;
  llmApiReportChunkRatio: number;
  llmApiReportMaxSubpartsPerPart: number;
  llmApiReportMonoPassMaxTokens: number;
  llmApiReportWorkflowTextMaxTokens: number;
  llmApiStatus: LlmApiStatus;
  llmApiStatusDetail?: string;
  llmApiProgress: number;
  llmApiResults: Partial<Record<ReportResultKey, ReportResult>>;
  llmApiReportDrafts: Partial<Record<ReportResultKey, ReportJson>>;
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
  sessionTranscriptMemories: Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null>;
  cloudTranscriptionSession: CloudTranscriptionSessionRuntime;
  assistantWorkflow: AssistantWorkflowRuntime;
  // Persist the uploaded file in-memory so UI like pre-listen survives navigation
  uploadedFile: File | null;
  previewUrl: string | null;
  telemetrySummary: TelemetrySummary | null;
  runExportHeaders: Record<ExportMode, ExportHeader | null>;
  speakerAssignments: Record<ExportMode, SpeakerAssignmentMap>;
  transcriptionConfidence: number | null; // 0..1 overall transcript confidence or null if unavailable
  transcriptionConfidenceSource?: 'model' | 'estimated' | null;
  logLevel: LogLevel;
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
  setHfApiToken: (value: string) => void;
  setCloudMistralApiUrl: (value: string) => void;
  setMistralApiKey: (value: string) => void;
  setCloudMistralModel: (value: string) => void;
  setCloudMistralDiarizationEnabled: (value: boolean) => void;
  setCloudDemeterModel: (value: string) => void;
  setCloudDemeterDiarizationEnabled: (value: boolean) => void;
  setCloudDemeterChunking: (params: Partial<{
    chunkDurationSec: number;
  }>) => void;
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
  setLlmApiReportDetailLevel: (format: ReportFormat, value: ReportDetailLevel) => void;
  setLlmApiReportDetailLevels: (value: Partial<Record<ReportFormat, ReportDetailLevel>>) => void;
  setLlmApiReportGenerationMode: (value: LlmReportGenerationMode) => void;
  setLlmApiReportChunkRatio: (value: number) => void;
  setLlmApiReportMaxSubpartsPerPart: (value: number) => void;
  setLlmApiReportMonoPassMaxTokens: (value: number) => void;
  setLlmApiReportWorkflowTextMaxTokens: (value: number) => void;
  setLlmApiStatus: (status: LlmApiStatus, detail?: string) => void;
  setLlmApiProgress: (value: number) => void;
  setLlmApiResult: (format: ReportResultKey, value: ReportResult) => void;
  setLlmApiReportDraft: (format: ReportResultKey, value: ReportJson | undefined) => void;
  resetLlmApiReportDraft: (format: ReportResultKey) => void;
  resetLlmApiReportDrafts: () => void;
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
  setSessionTranscriptMemory: (mode: SessionTranscriptMode, entry: SessionTranscriptMemoryEntry | null) => void;
  clearSessionTranscriptMemory: (mode: SessionTranscriptMode) => void;
  clearAllSessionTranscriptMemories: () => void;
  setCloudTranscriptionSession: (patch: Partial<CloudTranscriptionSessionRuntime>) => void;
  resetCloudTranscriptionSession: () => void;
  setAssistantWorkflow: (patch: Partial<AssistantWorkflowRuntime>) => void;
  resetAssistantWorkflow: () => void;
  setChunkPlan: (plan: ChunkDefinition[]) => void;
  setSegments: (segments: TranscriptionSegment[]) => void;
  appendSegments: (segments: TranscriptionSegment[]) => void;
  pushChunkMetric: (metric: ChunkTelemetry) => void;
  setTelemetrySummary: (summary: TelemetrySummary | null) => void;
  setRunExportHeader: (mode: ExportMode, header: ExportHeader | null) => void;
  setSpeakerAssignments: (mode: ExportMode, assignments: SpeakerAssignmentMap) => void;
  setSpeakerAssignment: (mode: ExportMode, speakerId: string, value: SpeakerAssignment) => void;
  clearSpeakerAssignments: (mode: ExportMode) => void;
  clearAllSpeakerAssignments: () => void;
  setTranscriptionConfidence: (value: number | null) => void;
  setTranscriptionConfidenceSource: (value: 'model' | 'estimated' | null) => void;
  setLogLevel: (value: LogLevel) => void;
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

export function serializePersistedSettings(state: AsrConfigState): PersistedSettings {
  return {
    activePreset: state.activePreset,
    customModelId: state.customModelId,
    presetQuantizationOverrides: state.modelQuantizationOverrides,
    blockedPresets: state.blockedPresets,
    backendPreference: state.backendPreference,
    memoryMode: state.memoryMode,
    chunkStrategy: state.chunkStrategy,
    segmentationMode: state.segmentationMode,
    dedupeMode: state.dedupeMode,
    cleanIntraChunk: state.cleanIntraChunk,
    preprocessingMode: state.preprocessingMode,
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
    autoTunePreprocess: state.autoTunePreprocess,
    enableWordTimestamps: state.enableWordTimestamps,
    showSegmentConfidence: state.showSegmentConfidence,
    logLevel: state.logLevel,
    forceSingleThread: state.forceSingleThread,
    micActivePreset: state.micActivePreset,
    micCustomModelId: state.micCustomModelId,
    micBackendPreference: state.micBackendPreference,
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
    micEnableWordTimestamps: state.micEnableWordTimestamps,
    micShowSegmentConfidence: state.micShowSegmentConfidence,
    micForceSingleThread: state.micForceSingleThread,
    cloudMistralApiUrl: state.cloudMistralApiUrl,
    cloudMistralModel: state.cloudMistralModel,
    cloudMistralDiarizationEnabled: state.cloudMistralDiarizationEnabled,
    cloudDemeterModel: state.cloudDemeterModel,
    cloudDemeterDiarizationEnabled: state.cloudDemeterDiarizationEnabled,
    cloudDemeterChunkDurationSec: state.cloudDemeterChunkDurationSec,
    cloudWhisperChunkDurationSec: state.cloudWhisperChunkDurationSec,
    cloudWhisperOverlapSec: state.cloudWhisperOverlapSec,
    cloudMistralChunkDurationSec: state.cloudMistralChunkDurationSec,
    cloudMistralOverlapSec: state.cloudMistralOverlapSec,
    cloudMaxTokens: state.cloudMaxTokens,
    cloudTemperature: state.cloudTemperature,
    cloudTopP: state.cloudTopP,
    cloudDoSample: state.cloudDoSample,
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
    llmApiReportDetailLevels: state.llmApiReportDetailLevels,
    llmApiReportGenerationMode: state.llmApiReportGenerationMode,
    llmApiReportChunkRatio: state.llmApiReportChunkRatio,
    llmApiReportMaxSubpartsPerPart: state.llmApiReportMaxSubpartsPerPart,
    llmApiReportMonoPassMaxTokens: state.llmApiReportMonoPassMaxTokens,
    llmApiReportWorkflowTextMaxTokens: state.llmApiReportWorkflowTextMaxTokens,
    llmLocalModelProfile: state.llmLocalModelProfile,
    llmLocalModelId: state.llmLocalModelId,
    llmLocalTemperature: state.llmLocalTemperature,
    llmLocalMaxTokens: state.llmLocalMaxTokens,
    llmLocalBackendPreference: state.llmLocalBackendPreference,
    llmLocalDtypeWebgpu: state.llmLocalDtypeWebgpu,
    llmLocalDtypeWasm: state.llmLocalDtypeWasm,
    llmLocalSettingsByProfile: state.llmLocalSettingsByProfile,
    llmLocalForceSingleThread: state.llmLocalForceSingleThread,
  };
}

function getHydrationInputValue<K extends keyof PersistedSettings>(
  settings: PersistedSettingsInput,
  key: K,
  fallback: PersistedSettings[K]
): PersistedSettings[K] {
  return (settings[key] ?? fallback) as PersistedSettings[K];
}

const initialState: AsrConfigState = {
  hasHydrated: false,
  activePreset: DEFAULT_SETTINGS.activePreset,
  customModelId: DEFAULT_SETTINGS.customModelId,
  modelQuantizationOverrides: { ...DEFAULT_SETTINGS.presetQuantizationOverrides },
  blockedPresets: [...DEFAULT_SETTINGS.blockedPresets],
  backendPreference: DEFAULT_SETTINGS.backendPreference,
  webGpuSupported: true,
  wasmAvailable: true,
  status: "idle",
  statusDetail: undefined,
  cloudStatus: "idle",
  cloudStatusDetail: undefined,
  activeBackend: undefined,
  memoryMode: DEFAULT_SETTINGS.memoryMode,
  chunkStrategy: DEFAULT_SETTINGS.chunkStrategy,
  segmentationMode: DEFAULT_SETTINGS.segmentationMode,
  dedupeMode: DEFAULT_SETTINGS.dedupeMode,
  cleanIntraChunk: DEFAULT_SETTINGS.cleanIntraChunk,
  // Target chunk duration used when building chunks in 'silence' mode (seconds)
  chunkDurationSec: DEFAULT_SETTINGS.chunkDurationSec,
  overlapSec: DEFAULT_SETTINGS.overlapSec,
  progressiveSegmentDurationSec: DEFAULT_SETTINGS.progressiveSegmentDurationSec,
  silenceThresholdDb: DEFAULT_SETTINGS.silenceThresholdDb,
  minSilenceMs: DEFAULT_SETTINGS.minSilenceMs,
  minChunkMs: DEFAULT_SETTINGS.minChunkMs,
  maxChunkMs: DEFAULT_SETTINGS.maxChunkMs,
  showSegments: DEFAULT_SETTINGS.showSegments,
  showExportVtt: DEFAULT_SETTINGS.showExportVtt,
  showExportSrt: DEFAULT_SETTINGS.showExportSrt,
  showExportJson: DEFAULT_SETTINGS.showExportJson,
  showExportTelemetry: DEFAULT_SETTINGS.showExportTelemetry,
  preprocessingMode: DEFAULT_SETTINGS.preprocessingMode,
  denoiseNoiseFloorDb: DEFAULT_SETTINGS.denoiseNoiseFloorDb,
  denoiseReductionDb: DEFAULT_SETTINGS.denoiseReductionDb,
  denoiseSmoothing: DEFAULT_SETTINGS.denoiseSmoothing,
  denoiseCalibrationSeconds: DEFAULT_SETTINGS.denoiseCalibrationSeconds,
  preprocessEnableFilters: DEFAULT_SETTINGS.preprocessEnableFilters,
  preprocessHighpassHz: DEFAULT_SETTINGS.preprocessHighpassHz,
  preprocessLowpassHz: DEFAULT_SETTINGS.preprocessLowpassHz,
  preprocessEnableLufs: DEFAULT_SETTINGS.preprocessEnableLufs,
  preprocessTargetLufs: DEFAULT_SETTINGS.preprocessTargetLufs,
  preprocessLimiterEnabled: DEFAULT_SETTINGS.preprocessLimiterEnabled,
  preprocessLimiterThresholdDb: DEFAULT_SETTINGS.preprocessLimiterThresholdDb,
  preprocessLimiterSoftness: DEFAULT_SETTINGS.preprocessLimiterSoftness,
  preprocessVadEnabled: DEFAULT_SETTINGS.preprocessVadEnabled,
  preprocessVadThresholdDb: DEFAULT_SETTINGS.preprocessVadThresholdDb,
  preprocessVadMinSilenceMs: DEFAULT_SETTINGS.preprocessVadMinSilenceMs,
  preprocessOverlapAdd: DEFAULT_SETTINGS.preprocessOverlapAdd,
  preprocessOverlapBlockSec: DEFAULT_SETTINGS.preprocessOverlapBlockSec,
  preprocessOverlapSec: DEFAULT_SETTINGS.preprocessOverlapSec,
  // Mic defaults
  micActivePreset: DEFAULT_SETTINGS.micActivePreset,
  micCustomModelId: DEFAULT_SETTINGS.micCustomModelId,
  micBackendPreference: DEFAULT_SETTINGS.micBackendPreference,
  micPreprocessingMode: DEFAULT_SETTINGS.micPreprocessingMode,
  micSegmentationMode: DEFAULT_SETTINGS.micSegmentationMode,
  micSilenceThresholdDb: DEFAULT_SETTINGS.micSilenceThresholdDb,
  micNoiseCalibrationMarginDb: DEFAULT_SETTINGS.micNoiseCalibrationMarginDb,
  micMinSilenceMs: DEFAULT_SETTINGS.micMinSilenceMs,
  micMinChunkMs: DEFAULT_SETTINGS.micMinChunkMs,
  micMaxChunkMs: DEFAULT_SETTINGS.micMaxChunkMs,
  micShowExportVtt: DEFAULT_SETTINGS.micShowExportVtt,
  micShowExportSrt: DEFAULT_SETTINGS.micShowExportSrt,
  micShowExportJson: DEFAULT_SETTINGS.micShowExportJson,
  micShowExportTelemetry: DEFAULT_SETTINGS.micShowExportTelemetry,
  micDenoiseNoiseFloorDb: DEFAULT_SETTINGS.micDenoiseNoiseFloorDb,
  micDenoiseReductionDb: DEFAULT_SETTINGS.micDenoiseReductionDb,
  micDenoiseSmoothing: DEFAULT_SETTINGS.micDenoiseSmoothing,
  micDenoiseCalibrationSeconds: DEFAULT_SETTINGS.micDenoiseCalibrationSeconds,
  micPreprocessEnableFilters: DEFAULT_SETTINGS.micPreprocessEnableFilters,
  micPreprocessHighpassHz: DEFAULT_SETTINGS.micPreprocessHighpassHz,
  micPreprocessLowpassHz: DEFAULT_SETTINGS.micPreprocessLowpassHz,
  micPreprocessEnableLufs: DEFAULT_SETTINGS.micPreprocessEnableLufs,
  micPreprocessTargetLufs: DEFAULT_SETTINGS.micPreprocessTargetLufs,
  micPreprocessLimiterEnabled: DEFAULT_SETTINGS.micPreprocessLimiterEnabled,
  micPreprocessLimiterThresholdDb: DEFAULT_SETTINGS.micPreprocessLimiterThresholdDb,
  micPreprocessLimiterSoftness: DEFAULT_SETTINGS.micPreprocessLimiterSoftness,
  micPreprocessVadEnabled: DEFAULT_SETTINGS.micPreprocessVadEnabled,
  micPreprocessVadThresholdDb: DEFAULT_SETTINGS.micPreprocessVadThresholdDb,
  micPreprocessVadMinSilenceMs: DEFAULT_SETTINGS.micPreprocessVadMinSilenceMs,
  micPreprocessOverlapAdd: DEFAULT_SETTINGS.micPreprocessOverlapAdd,
  micPreprocessOverlapBlockSec: DEFAULT_SETTINGS.micPreprocessOverlapBlockSec,
  micPreprocessOverlapSec: DEFAULT_SETTINGS.micPreprocessOverlapSec,
  micAutoTunePreprocess: DEFAULT_SETTINGS.micAutoTunePreprocess,
  micEnableWordTimestamps: DEFAULT_SETTINGS.micEnableWordTimestamps,
  micShowSegmentConfidence: DEFAULT_SETTINGS.micShowSegmentConfidence,
  micForceSingleThread: DEFAULT_SETTINGS.micForceSingleThread,
  hfApiToken: "",
  cloudMistralApiUrl: DEFAULT_SETTINGS.cloudMistralApiUrl,
  mistralApiKey: "",
  cloudMistralModel: DEFAULT_SETTINGS.cloudMistralModel,
  cloudMistralDiarizationEnabled: DEFAULT_SETTINGS.cloudMistralDiarizationEnabled,
  cloudDemeterModel: DEFAULT_SETTINGS.cloudDemeterModel,
  cloudDemeterDiarizationEnabled: DEFAULT_SETTINGS.cloudDemeterDiarizationEnabled,
  cloudDemeterChunkDurationSec: DEFAULT_SETTINGS.cloudDemeterChunkDurationSec,
  cloudWhisperChunkDurationSec: DEFAULT_SETTINGS.cloudWhisperChunkDurationSec,
  cloudWhisperOverlapSec: DEFAULT_SETTINGS.cloudWhisperOverlapSec,
  cloudMistralChunkDurationSec: DEFAULT_SETTINGS.cloudMistralChunkDurationSec,
  cloudMistralOverlapSec: DEFAULT_SETTINGS.cloudMistralOverlapSec,
  cloudMaxTokens: DEFAULT_SETTINGS.cloudMaxTokens,
  cloudTemperature: DEFAULT_SETTINGS.cloudTemperature,
  cloudTopP: DEFAULT_SETTINGS.cloudTopP,
  cloudDoSample: DEFAULT_SETTINGS.cloudDoSample,
  cloudShowSegments: DEFAULT_SETTINGS.cloudShowSegments,
  cloudShowExportVtt: DEFAULT_SETTINGS.cloudShowExportVtt,
  cloudShowExportSrt: DEFAULT_SETTINGS.cloudShowExportSrt,
  cloudShowExportJson: DEFAULT_SETTINGS.cloudShowExportJson,
  cloudShowExportTelemetry: DEFAULT_SETTINGS.cloudShowExportTelemetry,
  cloudPreprocessingMode: DEFAULT_SETTINGS.cloudPreprocessingMode,
  cloudDenoiseNoiseFloorDb: DEFAULT_SETTINGS.cloudDenoiseNoiseFloorDb,
  cloudDenoiseReductionDb: DEFAULT_SETTINGS.cloudDenoiseReductionDb,
  cloudDenoiseSmoothing: DEFAULT_SETTINGS.cloudDenoiseSmoothing,
  cloudDenoiseCalibrationSeconds: DEFAULT_SETTINGS.cloudDenoiseCalibrationSeconds,
  cloudPreprocessEnableFilters: DEFAULT_SETTINGS.cloudPreprocessEnableFilters,
  cloudPreprocessHighpassHz: DEFAULT_SETTINGS.cloudPreprocessHighpassHz,
  cloudPreprocessLowpassHz: DEFAULT_SETTINGS.cloudPreprocessLowpassHz,
  cloudPreprocessEnableLufs: DEFAULT_SETTINGS.cloudPreprocessEnableLufs,
  cloudPreprocessTargetLufs: DEFAULT_SETTINGS.cloudPreprocessTargetLufs,
  cloudPreprocessLimiterEnabled: DEFAULT_SETTINGS.cloudPreprocessLimiterEnabled,
  cloudPreprocessLimiterThresholdDb: DEFAULT_SETTINGS.cloudPreprocessLimiterThresholdDb,
  cloudPreprocessLimiterSoftness: DEFAULT_SETTINGS.cloudPreprocessLimiterSoftness,
  cloudPreprocessVadEnabled: DEFAULT_SETTINGS.cloudPreprocessVadEnabled,
  cloudPreprocessVadThresholdDb: DEFAULT_SETTINGS.cloudPreprocessVadThresholdDb,
  cloudPreprocessVadMinSilenceMs: DEFAULT_SETTINGS.cloudPreprocessVadMinSilenceMs,
  cloudPreprocessOverlapAdd: DEFAULT_SETTINGS.cloudPreprocessOverlapAdd,
  cloudPreprocessOverlapBlockSec: DEFAULT_SETTINGS.cloudPreprocessOverlapBlockSec,
  cloudPreprocessOverlapSec: DEFAULT_SETTINGS.cloudPreprocessOverlapSec,
  cloudAutoTunePreprocess: DEFAULT_SETTINGS.cloudAutoTunePreprocess,
  cloudEnableWordTimestamps: DEFAULT_SETTINGS.cloudEnableWordTimestamps,
  cloudShowSegmentConfidence: DEFAULT_SETTINGS.cloudShowSegmentConfidence,
  llmApiProvider: DEFAULT_SETTINGS.llmApiProvider,
  llmApiHfModelId: DEFAULT_SETTINGS.llmApiHfModelId,
  llmApiHfTemperature: DEFAULT_SETTINGS.llmApiHfTemperature,
  llmApiHfMaxTokens: DEFAULT_SETTINGS.llmApiHfMaxTokens,
  llmApiMistralModelId: DEFAULT_SETTINGS.llmApiMistralModelId,
  llmApiMistralTemperature: DEFAULT_SETTINGS.llmApiMistralTemperature,
  llmApiMistralMaxTokens: DEFAULT_SETTINGS.llmApiMistralMaxTokens,
  llmApiReportDetailLevels: { ...DEFAULT_REPORT_DETAIL_LEVELS },
  llmApiReportGenerationMode: DEFAULT_SETTINGS.llmApiReportGenerationMode,
  llmApiReportChunkRatio: DEFAULT_SETTINGS.llmApiReportChunkRatio,
  llmApiReportMaxSubpartsPerPart: DEFAULT_SETTINGS.llmApiReportMaxSubpartsPerPart,
  llmApiReportMonoPassMaxTokens: DEFAULT_SETTINGS.llmApiReportMonoPassMaxTokens,
  llmApiReportWorkflowTextMaxTokens: DEFAULT_SETTINGS.llmApiReportWorkflowTextMaxTokens,
  llmApiStatus: "idle",
  llmApiStatusDetail: undefined,
  llmApiProgress: 0,
  llmApiResults: {},
  llmApiReportDrafts: {},
  llmLocalSettingsByProfile: normalizeLlmLocalSettingsByProfile(undefined, DEFAULT_LLM_LOCAL_SETTINGS_BY_PROFILE),
  llmLocalModelProfile: DEFAULT_SETTINGS.llmLocalModelProfile,
  llmLocalModelId: DEFAULT_SETTINGS.llmLocalModelId,
  llmLocalTemperature: DEFAULT_SETTINGS.llmLocalTemperature,
  llmLocalMaxTokens: DEFAULT_SETTINGS.llmLocalMaxTokens,
  llmLocalBackendPreference: DEFAULT_SETTINGS.llmLocalBackendPreference,
  llmLocalDtypeWebgpu: DEFAULT_SETTINGS.llmLocalDtypeWebgpu,
  llmLocalDtypeWasm: DEFAULT_SETTINGS.llmLocalDtypeWasm,
  llmLocalForceSingleThread: DEFAULT_SETTINGS.llmLocalForceSingleThread,
  llmLocalStatus: "idle",
  llmLocalStatusDetail: undefined,
  llmLocalProgress: 0,
  llmLocalResults: {},
  localUploadModelSizeAlert: null,
  llmLocalModelSizeAlert: null,
  noiseCalibrationRequestedAt: null,
  segmentationStatus: "idle",
  segmentationProgress: 0,
  autoTunePreprocess: DEFAULT_SETTINGS.autoTunePreprocess,
  lastAutoTuneParams: null,
  telemetryCollector: null,
  chunkPlan: [],
  chunkMetrics: [],
  segments: [],
  audioMetadata: null,
  audioSource: null,
  sessionTranscriptMemories: createEmptySessionTranscriptMemories(),
  cloudTranscriptionSession: createDefaultCloudTranscriptionSessionRuntime(),
  assistantWorkflow: createDefaultAssistantWorkflowRuntime(),
  // Persist uploaded file in-memory so pre-listen survives navigation
  uploadedFile: null,
  previewUrl: null,
  telemetrySummary: null,
  runExportHeaders: {
    upload: null,
    mic: null,
    cloud: null,
  },
  speakerAssignments: createEmptySpeakerAssignmentsByMode(),
  isTranscribing: false,
  stopRequested: false,
  progress: 0,
  resetCounter: 0,
  // preprocessing status
  preprocessingStatus: "idle",
  preprocessingProgress: 0,
  // defaults
  forceSingleThread: DEFAULT_SETTINGS.forceSingleThread,
  wasmThreads: null,
  // Whisper defaults
  enableWordTimestamps: DEFAULT_SETTINGS.enableWordTimestamps,
  // UI toggles
  showSegmentConfidence: DEFAULT_SETTINGS.showSegmentConfidence,
  // derived metrics
  transcriptionConfidence: null,
  transcriptionConfidenceSource: null,
  logLevel: DEFAULT_SETTINGS.logLevel,
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
    const persistedSessionTranscriptMemories = loadSessionTranscriptMemoriesFromSessionStorage();
    const settings = loadSettings();
    if (!settings) {
      logger.info("[asr-store] hydrate from storage using defaults");
      const currentTokens = normalizeSecureTokens({
        hfApiToken: get().hfApiToken,
        mistralApiKey: get().mistralApiKey,
      });
      lastPersistedSecureTokens = currentTokens;
      set(() => ({
        hasHydrated: true,
        hfApiToken: currentTokens.hfApiToken,
        mistralApiKey: currentTokens.mistralApiKey,
        llmApiReportDrafts: {},
        sessionTranscriptMemories: persistedSessionTranscriptMemories ?? get().sessionTranscriptMemories,
      }));
      void syncSecureTokensFromVault();
      return;
    }
    logger.info("[asr-store] hydrate from storage loaded persisted settings", {
      keyCount: Object.keys(settings).length,
    });
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
    const currentCloudDemeterModel = get().cloudDemeterModel;
    const normalizedCloudDemeterModel = normalizeMistralModel(
      settings.cloudDemeterModel ?? settings.cloudMistralModel ?? currentCloudDemeterModel,
      currentCloudDemeterModel
    );
    if (
      (settings.cloudDemeterModel ?? settings.cloudMistralModel ?? currentCloudDemeterModel) !==
      normalizedCloudDemeterModel
    ) {
      const storedValue = settings.cloudDemeterModel ?? settings.cloudMistralModel ?? currentCloudDemeterModel;
      logger.info("[asr-store] cloud demeter model normalized", {
        stored: storedValue,
        normalized: normalizedCloudDemeterModel,
      });
    }
    const resolvedLogLevel = normalizeLogLevel(
      settings.logLevel ?? (settings.debugConfidence ? "debug" : undefined),
      get().logLevel
    );
    logger.info("[asr-store] log level resolved during hydration", {
      stored: settings.logLevel ?? null,
      legacyDebugConfidence: Boolean(settings.debugConfidence),
      resolved: resolvedLogLevel,
    });
    set((state) => {
      const fallbackSettings = serializePersistedSettings(state);
      const persistedLlmProvider = normalizeLlmApiProvider(settings.llmApiProvider, fallbackSettings.llmApiProvider);
      const legacyLlmModelId = settings.llmApiModelId;
      const legacyLlmTemperature = settings.llmApiTemperature;
      const legacyLlmMaxTokens = settings.llmApiMaxTokens;

      const llmApiHfModelId =
        settings.llmApiHfModelId ??
        (persistedLlmProvider === "huggingface" ? legacyLlmModelId : undefined) ??
        fallbackSettings.llmApiHfModelId;
      const llmApiHfTemperature = normalizeLlmTemperature(
        settings.llmApiHfTemperature ??
          (persistedLlmProvider === "huggingface" ? legacyLlmTemperature : undefined),
        fallbackSettings.llmApiHfTemperature
      );
      const llmApiHfMaxTokens = normalizeLlmMaxTokens(
        settings.llmApiHfMaxTokens ??
          (persistedLlmProvider === "huggingface" ? legacyLlmMaxTokens : undefined),
        fallbackSettings.llmApiHfMaxTokens
      );

      const llmApiMistralModelId =
        settings.llmApiMistralModelId ??
        (persistedLlmProvider === "mistral" ? legacyLlmModelId : undefined) ??
        fallbackSettings.llmApiMistralModelId;
      const llmApiMistralTemperature = normalizeLlmTemperature(
        settings.llmApiMistralTemperature ??
          (persistedLlmProvider === "mistral" ? legacyLlmTemperature : undefined),
        fallbackSettings.llmApiMistralTemperature
      );
      const llmApiMistralMaxTokens = normalizeLlmMaxTokens(
        settings.llmApiMistralMaxTokens ??
          (persistedLlmProvider === "mistral" ? legacyLlmMaxTokens : undefined),
        fallbackSettings.llmApiMistralMaxTokens
      );
      const llmApiReportDetailLevels = normalizeReportDetailLevels(
        settings.llmApiReportDetailLevels,
        fallbackSettings.llmApiReportDetailLevels
      );
      const llmApiReportGenerationMode = normalizeLlmReportGenerationMode(
        settings.llmApiReportGenerationMode,
        fallbackSettings.llmApiReportGenerationMode
      );
      const llmApiReportChunkRatio = normalizeLlmReportChunkRatio(
        settings.llmApiReportChunkRatio,
        fallbackSettings.llmApiReportChunkRatio
      );
      const llmApiReportMaxSubpartsPerPart = normalizeLlmReportMaxSubpartsPerPart(
        settings.llmApiReportMaxSubpartsPerPart,
        fallbackSettings.llmApiReportMaxSubpartsPerPart
      );
      const llmApiReportMonoPassMaxTokens = normalizeLlmReportMonoPassMaxTokens(
        settings.llmApiReportMonoPassMaxTokens ?? settings.llmApiReportWorkflowTextMaxTokens,
        fallbackSettings.llmApiReportMonoPassMaxTokens
      );
      const llmApiReportWorkflowTextMaxTokens = normalizeLlmReportWorkflowTextMaxTokens(
        settings.llmApiReportWorkflowTextMaxTokens ?? settings.llmApiReportMonoPassMaxTokens,
        fallbackSettings.llmApiReportWorkflowTextMaxTokens
      );

      const llmLocalModelProfile = normalizeLlmLocalModelProfile(
        settings.llmLocalModelProfile,
        fallbackSettings.llmLocalModelProfile
      );
      const llmLocalSettingsByProfileFallback = normalizeLlmLocalSettingsByProfile(
        undefined,
        fallbackSettings.llmLocalSettingsByProfile
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
        fallbackSettings.llmLocalBackendPreference
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
      activePreset: sanitizePreset(getHydrationInputValue(settings, "activePreset", fallbackSettings.activePreset)),
      customModelId: getHydrationInputValue(settings, "customModelId", fallbackSettings.customModelId),
      modelQuantizationOverrides,
      blockedPresets,
      backendPreference: resolvedBackendPreference,
      micActivePreset: settings.micActivePreset ? sanitizePreset(settings.micActivePreset) : fallbackSettings.micActivePreset,
      micCustomModelId: getHydrationInputValue(settings, "micCustomModelId", fallbackSettings.micCustomModelId),
      micBackendPreference: resolvedMicBackendPreference,
      memoryMode: getHydrationInputValue(settings, "memoryMode", fallbackSettings.memoryMode),
      chunkStrategy: getHydrationInputValue(settings, "chunkStrategy", fallbackSettings.chunkStrategy),
      segmentationMode: getHydrationInputValue(settings, "segmentationMode", fallbackSettings.segmentationMode),
      dedupeMode:
        settings.dedupeMode === "normal" || settings.dedupeMode === "fuzzy"
          ? settings.dedupeMode
          : fallbackSettings.dedupeMode,
      cleanIntraChunk: getHydrationInputValue(settings, "cleanIntraChunk", fallbackSettings.cleanIntraChunk),
      chunkDurationSec: getHydrationInputValue(settings, "chunkDurationSec", fallbackSettings.chunkDurationSec),
      overlapSec: getHydrationInputValue(settings, "overlapSec", fallbackSettings.overlapSec),
      progressiveSegmentDurationSec: getHydrationInputValue(
        settings,
        "progressiveSegmentDurationSec",
        fallbackSettings.progressiveSegmentDurationSec
      ),
      silenceThresholdDb: getHydrationInputValue(settings, "silenceThresholdDb", fallbackSettings.silenceThresholdDb),
      minSilenceMs: getHydrationInputValue(settings, "minSilenceMs", fallbackSettings.minSilenceMs),
      minChunkMs: getHydrationInputValue(settings, "minChunkMs", fallbackSettings.minChunkMs),
      maxChunkMs: getHydrationInputValue(settings, "maxChunkMs", fallbackSettings.maxChunkMs),
      showSegments: getHydrationInputValue(settings, "showSegments", fallbackSettings.showSegments),
      showExportVtt: getHydrationInputValue(settings, "showExportVtt", fallbackSettings.showExportVtt),
      showExportSrt: getHydrationInputValue(settings, "showExportSrt", fallbackSettings.showExportSrt),
      showExportJson: getHydrationInputValue(settings, "showExportJson", fallbackSettings.showExportJson),
      showExportTelemetry: getHydrationInputValue(
        settings,
        "showExportTelemetry",
        fallbackSettings.showExportTelemetry
      ),
      logLevel: resolvedLogLevel,
      preprocessingMode: getHydrationInputValue(settings, "preprocessingMode", fallbackSettings.preprocessingMode),
      denoiseNoiseFloorDb: getHydrationInputValue(settings, "denoiseNoiseFloorDb", fallbackSettings.denoiseNoiseFloorDb),
      denoiseReductionDb: getHydrationInputValue(settings, "denoiseReductionDb", fallbackSettings.denoiseReductionDb),
      denoiseSmoothing: getHydrationInputValue(settings, "denoiseSmoothing", fallbackSettings.denoiseSmoothing),
      denoiseCalibrationSeconds: getHydrationInputValue(
        settings,
        "denoiseCalibrationSeconds",
        fallbackSettings.denoiseCalibrationSeconds
      ),
      preprocessEnableFilters: getHydrationInputValue(
        settings,
        "preprocessEnableFilters",
        fallbackSettings.preprocessEnableFilters
      ),
      preprocessHighpassHz: getHydrationInputValue(settings, "preprocessHighpassHz", fallbackSettings.preprocessHighpassHz),
      preprocessLowpassHz: getHydrationInputValue(settings, "preprocessLowpassHz", fallbackSettings.preprocessLowpassHz),
      preprocessEnableLufs: getHydrationInputValue(
        settings,
        "preprocessEnableLufs",
        fallbackSettings.preprocessEnableLufs
      ),
      preprocessTargetLufs: getHydrationInputValue(settings, "preprocessTargetLufs", fallbackSettings.preprocessTargetLufs),
      preprocessLimiterEnabled: getHydrationInputValue(
        settings,
        "preprocessLimiterEnabled",
        fallbackSettings.preprocessLimiterEnabled
      ),
      preprocessLimiterThresholdDb: getHydrationInputValue(
        settings,
        "preprocessLimiterThresholdDb",
        fallbackSettings.preprocessLimiterThresholdDb
      ),
      preprocessLimiterSoftness: getHydrationInputValue(
        settings,
        "preprocessLimiterSoftness",
        fallbackSettings.preprocessLimiterSoftness
      ),
      preprocessVadEnabled: getHydrationInputValue(settings, "preprocessVadEnabled", fallbackSettings.preprocessVadEnabled),
      preprocessVadThresholdDb: getHydrationInputValue(
        settings,
        "preprocessVadThresholdDb",
        fallbackSettings.preprocessVadThresholdDb
      ),
      preprocessVadMinSilenceMs: getHydrationInputValue(
        settings,
        "preprocessVadMinSilenceMs",
        fallbackSettings.preprocessVadMinSilenceMs
      ),
      preprocessOverlapAdd: getHydrationInputValue(settings, "preprocessOverlapAdd", fallbackSettings.preprocessOverlapAdd),
      preprocessOverlapBlockSec: getHydrationInputValue(
        settings,
        "preprocessOverlapBlockSec",
        fallbackSettings.preprocessOverlapBlockSec
      ),
      preprocessOverlapSec: getHydrationInputValue(settings, "preprocessOverlapSec", fallbackSettings.preprocessOverlapSec),
      micPreprocessingMode: getHydrationInputValue(
        settings,
        "micPreprocessingMode",
        fallbackSettings.micPreprocessingMode
      ),
      micSegmentationMode: getHydrationInputValue(settings, "micSegmentationMode", fallbackSettings.micSegmentationMode),
      micSilenceThresholdDb: getHydrationInputValue(
        settings,
        "micSilenceThresholdDb",
        fallbackSettings.micSilenceThresholdDb
      ),
      micNoiseCalibrationMarginDb:
        typeof settings.micNoiseCalibrationMarginDb === "number"
          ? settings.micNoiseCalibrationMarginDb
          : fallbackSettings.micNoiseCalibrationMarginDb,
      micMinSilenceMs: getHydrationInputValue(settings, "micMinSilenceMs", fallbackSettings.micMinSilenceMs),
      micMinChunkMs: getHydrationInputValue(settings, "micMinChunkMs", fallbackSettings.micMinChunkMs),
      micMaxChunkMs: getHydrationInputValue(settings, "micMaxChunkMs", fallbackSettings.micMaxChunkMs),
      micShowExportVtt: getHydrationInputValue(settings, "micShowExportVtt", fallbackSettings.micShowExportVtt),
      micShowExportSrt: getHydrationInputValue(settings, "micShowExportSrt", fallbackSettings.micShowExportSrt),
      micShowExportJson: getHydrationInputValue(settings, "micShowExportJson", fallbackSettings.micShowExportJson),
      micShowExportTelemetry: getHydrationInputValue(
        settings,
        "micShowExportTelemetry",
        fallbackSettings.micShowExportTelemetry
      ),
      micDenoiseNoiseFloorDb: getHydrationInputValue(
        settings,
        "micDenoiseNoiseFloorDb",
        fallbackSettings.micDenoiseNoiseFloorDb
      ),
      micDenoiseReductionDb: getHydrationInputValue(
        settings,
        "micDenoiseReductionDb",
        fallbackSettings.micDenoiseReductionDb
      ),
      micDenoiseSmoothing: getHydrationInputValue(settings, "micDenoiseSmoothing", fallbackSettings.micDenoiseSmoothing),
      micDenoiseCalibrationSeconds: getHydrationInputValue(
        settings,
        "micDenoiseCalibrationSeconds",
        fallbackSettings.micDenoiseCalibrationSeconds
      ),
      micPreprocessEnableFilters: getHydrationInputValue(
        settings,
        "micPreprocessEnableFilters",
        fallbackSettings.micPreprocessEnableFilters
      ),
      micPreprocessHighpassHz: getHydrationInputValue(
        settings,
        "micPreprocessHighpassHz",
        fallbackSettings.micPreprocessHighpassHz
      ),
      micPreprocessLowpassHz: getHydrationInputValue(
        settings,
        "micPreprocessLowpassHz",
        fallbackSettings.micPreprocessLowpassHz
      ),
      micPreprocessEnableLufs: getHydrationInputValue(
        settings,
        "micPreprocessEnableLufs",
        fallbackSettings.micPreprocessEnableLufs
      ),
      micPreprocessTargetLufs: getHydrationInputValue(
        settings,
        "micPreprocessTargetLufs",
        fallbackSettings.micPreprocessTargetLufs
      ),
      micPreprocessLimiterEnabled: getHydrationInputValue(
        settings,
        "micPreprocessLimiterEnabled",
        fallbackSettings.micPreprocessLimiterEnabled
      ),
      micPreprocessLimiterThresholdDb: getHydrationInputValue(
        settings,
        "micPreprocessLimiterThresholdDb",
        fallbackSettings.micPreprocessLimiterThresholdDb
      ),
      micPreprocessLimiterSoftness: getHydrationInputValue(
        settings,
        "micPreprocessLimiterSoftness",
        fallbackSettings.micPreprocessLimiterSoftness
      ),
      micPreprocessVadEnabled: getHydrationInputValue(
        settings,
        "micPreprocessVadEnabled",
        fallbackSettings.micPreprocessVadEnabled
      ),
      micPreprocessVadThresholdDb: getHydrationInputValue(
        settings,
        "micPreprocessVadThresholdDb",
        fallbackSettings.micPreprocessVadThresholdDb
      ),
      micPreprocessVadMinSilenceMs: getHydrationInputValue(
        settings,
        "micPreprocessVadMinSilenceMs",
        fallbackSettings.micPreprocessVadMinSilenceMs
      ),
      micPreprocessOverlapAdd: getHydrationInputValue(
        settings,
        "micPreprocessOverlapAdd",
        fallbackSettings.micPreprocessOverlapAdd
      ),
      micPreprocessOverlapBlockSec: getHydrationInputValue(
        settings,
        "micPreprocessOverlapBlockSec",
        fallbackSettings.micPreprocessOverlapBlockSec
      ),
      micPreprocessOverlapSec: getHydrationInputValue(
        settings,
        "micPreprocessOverlapSec",
        fallbackSettings.micPreprocessOverlapSec
      ),
      micAutoTunePreprocess: getHydrationInputValue(
        settings,
        "micAutoTunePreprocess",
        fallbackSettings.micAutoTunePreprocess
      ),
      micEnableWordTimestamps: getHydrationInputValue(
        settings,
        "micEnableWordTimestamps",
        fallbackSettings.micEnableWordTimestamps
      ),
      micShowSegmentConfidence: getHydrationInputValue(
        settings,
        "micShowSegmentConfidence",
        fallbackSettings.micShowSegmentConfidence
      ),
      micForceSingleThread: getHydrationInputValue(
        settings,
        "micForceSingleThread",
        fallbackSettings.micForceSingleThread
      ),
      hfApiToken: hydratedSecureTokens.hfApiToken,
      cloudMistralApiUrl: getHydrationInputValue(
        settings,
        "cloudMistralApiUrl",
        fallbackSettings.cloudMistralApiUrl
      ),
      mistralApiKey: hydratedSecureTokens.mistralApiKey,
      cloudMistralModel: normalizedCloudMistralModel,
      cloudMistralDiarizationEnabled:
        settings.cloudMistralDiarizationEnabled ?? fallbackSettings.cloudMistralDiarizationEnabled,
      cloudDemeterModel: normalizedCloudDemeterModel,
      cloudDemeterDiarizationEnabled:
        settings.cloudDemeterDiarizationEnabled ??
        settings.cloudMistralDiarizationEnabled ??
        fallbackSettings.cloudDemeterDiarizationEnabled,
      cloudDemeterChunkDurationSec: clampDemeterChunkDurationSec(
        getHydrationInputValue(settings, "cloudDemeterChunkDurationSec", fallbackSettings.cloudDemeterChunkDurationSec)
      ),
      cloudWhisperChunkDurationSec:
        getHydrationInputValue(settings, "cloudWhisperChunkDurationSec", fallbackSettings.cloudWhisperChunkDurationSec),
      cloudWhisperOverlapSec: getHydrationInputValue(
        settings,
        "cloudWhisperOverlapSec",
        fallbackSettings.cloudWhisperOverlapSec
      ),
      cloudMistralChunkDurationSec:
        getHydrationInputValue(settings, "cloudMistralChunkDurationSec", fallbackSettings.cloudMistralChunkDurationSec),
      cloudMistralOverlapSec: getHydrationInputValue(
        settings,
        "cloudMistralOverlapSec",
        fallbackSettings.cloudMistralOverlapSec
      ),
      cloudMaxTokens: getHydrationInputValue(settings, "cloudMaxTokens", fallbackSettings.cloudMaxTokens),
      cloudTemperature: getHydrationInputValue(settings, "cloudTemperature", fallbackSettings.cloudTemperature),
      cloudTopP: getHydrationInputValue(settings, "cloudTopP", fallbackSettings.cloudTopP),
      cloudDoSample: getHydrationInputValue(settings, "cloudDoSample", fallbackSettings.cloudDoSample),
      cloudShowSegments: getHydrationInputValue(settings, "cloudShowSegments", fallbackSettings.cloudShowSegments),
      cloudShowExportVtt: getHydrationInputValue(settings, "cloudShowExportVtt", fallbackSettings.cloudShowExportVtt),
      cloudShowExportSrt: getHydrationInputValue(settings, "cloudShowExportSrt", fallbackSettings.cloudShowExportSrt),
      cloudShowExportJson: getHydrationInputValue(settings, "cloudShowExportJson", fallbackSettings.cloudShowExportJson),
      cloudShowExportTelemetry: getHydrationInputValue(
        settings,
        "cloudShowExportTelemetry",
        fallbackSettings.cloudShowExportTelemetry
      ),
      cloudPreprocessingMode: getHydrationInputValue(
        settings,
        "cloudPreprocessingMode",
        fallbackSettings.cloudPreprocessingMode
      ),
      cloudDenoiseNoiseFloorDb: getHydrationInputValue(
        settings,
        "cloudDenoiseNoiseFloorDb",
        fallbackSettings.cloudDenoiseNoiseFloorDb
      ),
      cloudDenoiseReductionDb: getHydrationInputValue(
        settings,
        "cloudDenoiseReductionDb",
        fallbackSettings.cloudDenoiseReductionDb
      ),
      cloudDenoiseSmoothing: getHydrationInputValue(
        settings,
        "cloudDenoiseSmoothing",
        fallbackSettings.cloudDenoiseSmoothing
      ),
      cloudDenoiseCalibrationSeconds: getHydrationInputValue(
        settings,
        "cloudDenoiseCalibrationSeconds",
        fallbackSettings.cloudDenoiseCalibrationSeconds
      ),
      cloudPreprocessEnableFilters: getHydrationInputValue(
        settings,
        "cloudPreprocessEnableFilters",
        fallbackSettings.cloudPreprocessEnableFilters
      ),
      cloudPreprocessHighpassHz: getHydrationInputValue(
        settings,
        "cloudPreprocessHighpassHz",
        fallbackSettings.cloudPreprocessHighpassHz
      ),
      cloudPreprocessLowpassHz: getHydrationInputValue(
        settings,
        "cloudPreprocessLowpassHz",
        fallbackSettings.cloudPreprocessLowpassHz
      ),
      cloudPreprocessEnableLufs: getHydrationInputValue(
        settings,
        "cloudPreprocessEnableLufs",
        fallbackSettings.cloudPreprocessEnableLufs
      ),
      cloudPreprocessTargetLufs: getHydrationInputValue(
        settings,
        "cloudPreprocessTargetLufs",
        fallbackSettings.cloudPreprocessTargetLufs
      ),
      cloudPreprocessLimiterEnabled: getHydrationInputValue(
        settings,
        "cloudPreprocessLimiterEnabled",
        fallbackSettings.cloudPreprocessLimiterEnabled
      ),
      cloudPreprocessLimiterThresholdDb: getHydrationInputValue(
        settings,
        "cloudPreprocessLimiterThresholdDb",
        fallbackSettings.cloudPreprocessLimiterThresholdDb
      ),
      cloudPreprocessLimiterSoftness: getHydrationInputValue(
        settings,
        "cloudPreprocessLimiterSoftness",
        fallbackSettings.cloudPreprocessLimiterSoftness
      ),
      cloudPreprocessVadEnabled: getHydrationInputValue(
        settings,
        "cloudPreprocessVadEnabled",
        fallbackSettings.cloudPreprocessVadEnabled
      ),
      cloudPreprocessVadThresholdDb: getHydrationInputValue(
        settings,
        "cloudPreprocessVadThresholdDb",
        fallbackSettings.cloudPreprocessVadThresholdDb
      ),
      cloudPreprocessVadMinSilenceMs: getHydrationInputValue(
        settings,
        "cloudPreprocessVadMinSilenceMs",
        fallbackSettings.cloudPreprocessVadMinSilenceMs
      ),
      cloudPreprocessOverlapAdd: getHydrationInputValue(
        settings,
        "cloudPreprocessOverlapAdd",
        fallbackSettings.cloudPreprocessOverlapAdd
      ),
      cloudPreprocessOverlapBlockSec: getHydrationInputValue(
        settings,
        "cloudPreprocessOverlapBlockSec",
        fallbackSettings.cloudPreprocessOverlapBlockSec
      ),
      cloudPreprocessOverlapSec: getHydrationInputValue(
        settings,
        "cloudPreprocessOverlapSec",
        fallbackSettings.cloudPreprocessOverlapSec
      ),
      cloudAutoTunePreprocess: getHydrationInputValue(
        settings,
        "cloudAutoTunePreprocess",
        fallbackSettings.cloudAutoTunePreprocess
      ),
      cloudEnableWordTimestamps: getHydrationInputValue(
        settings,
        "cloudEnableWordTimestamps",
        fallbackSettings.cloudEnableWordTimestamps
      ),
      cloudShowSegmentConfidence: getHydrationInputValue(
        settings,
        "cloudShowSegmentConfidence",
        fallbackSettings.cloudShowSegmentConfidence
      ),
      llmApiProvider: persistedLlmProvider,
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiHfMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiMistralMaxTokens,
      llmApiReportDetailLevels,
      llmApiReportGenerationMode,
      llmApiReportChunkRatio,
      llmApiReportMaxSubpartsPerPart,
      llmApiReportMonoPassMaxTokens,
      llmApiReportWorkflowTextMaxTokens,
      llmLocalSettingsByProfile,
      llmLocalModelProfile,
      llmLocalModelId,
      llmLocalTemperature,
      llmLocalMaxTokens,
      llmLocalBackendPreference,
      llmLocalDtypeWebgpu,
      llmLocalDtypeWasm,
      llmLocalForceSingleThread: getHydrationInputValue(
        settings,
        "llmLocalForceSingleThread",
        fallbackSettings.llmLocalForceSingleThread
      ),
      llmApiReportDrafts: {},
      autoTunePreprocess: getHydrationInputValue(settings, "autoTunePreprocess", fallbackSettings.autoTunePreprocess),
      forceSingleThread: getHydrationInputValue(settings, "forceSingleThread", fallbackSettings.forceSingleThread),
      enableWordTimestamps: getHydrationInputValue(
        settings,
        "enableWordTimestamps",
        fallbackSettings.enableWordTimestamps
      ),
      showSegmentConfidence: getHydrationInputValue(
        settings,
        "showSegmentConfidence",
        fallbackSettings.showSegmentConfidence
      ),
      sessionTranscriptMemories: persistedSessionTranscriptMemories ?? state.sessionTranscriptMemories,
    };
    });
    logger.info("[asr-store] hydration applied", {
      logLevel: resolvedLogLevel,
      blockedPresetCount: blockedPresets.length,
    });
    void syncSecureTokensFromVault();
  },
  registerTelemetry: (collector) => set(() => ({ telemetryCollector: collector })),
  registerAudioSource: (source, metadata) =>
    set(() => ({ audioSource: source, audioMetadata: metadata ?? null })),
  setSessionTranscriptMemory: (mode, entry) =>
    set((state) => {
      const nextSessionTranscriptMemories = {
        ...state.sessionTranscriptMemories,
        [mode]: entry
          ? {
              mode: entry.mode,
              provider: entry.provider,
              label: entry.label,
              transcriptText: getSessionTranscriptText(entry),
              segmentCount: getSessionTranscriptSegmentCount(entry),
              audioSource: entry.audioSource ?? null,
              audioMetadata: entry.audioMetadata ?? null,
              updatedAt: entry.updatedAt,
            }
          : null,
      };
      saveSessionTranscriptMemoriesToSessionStorage(nextSessionTranscriptMemories);
      return {
        sessionTranscriptMemories: nextSessionTranscriptMemories,
      };
    }),
  clearSessionTranscriptMemory: (mode) =>
    set((state) => {
      const nextSessionTranscriptMemories = {
        ...state.sessionTranscriptMemories,
        [mode]: null,
      };
      saveSessionTranscriptMemoriesToSessionStorage(nextSessionTranscriptMemories);
      return {
        sessionTranscriptMemories: nextSessionTranscriptMemories,
      };
    }),
  clearAllSessionTranscriptMemories: () =>
    set(() => {
      const nextSessionTranscriptMemories = createEmptySessionTranscriptMemories();
      clearSessionTranscriptMemoriesFromSessionStorage();
      return {
        sessionTranscriptMemories: nextSessionTranscriptMemories,
      };
    }),
  setCloudTranscriptionSession: (patch) =>
    set((state) => ({
      cloudTranscriptionSession: {
        ...state.cloudTranscriptionSession,
        ...patch,
      },
    })),
  resetCloudTranscriptionSession: () => set(() => ({
    cloudTranscriptionSession: createDefaultCloudTranscriptionSessionRuntime(),
  })),
  setAssistantWorkflow: (patch) =>
    set((state) => ({
      assistantWorkflow: {
        ...state.assistantWorkflow,
        ...patch,
      },
    })),
  resetAssistantWorkflow: () => set(() => ({
    assistantWorkflow: createDefaultAssistantWorkflowRuntime(),
  })),
  setChunkPlan: (plan) => set(() => ({ chunkPlan: plan })),
  setSegments: (segments) => set(() => ({ segments })),
  appendSegments: (segments) =>
    set((state) => ({ segments: [...state.segments, ...segments] })),
  pushChunkMetric: (metric) =>
    set((state) => ({ chunkMetrics: [...state.chunkMetrics, metric] })),
  setTelemetrySummary: (summary) => set(() => ({ telemetrySummary: summary })),
  setRunExportHeader: (mode, header) =>
    set((state) => ({
      runExportHeaders: {
        ...state.runExportHeaders,
        [mode]: header,
      },
    })),
  setSpeakerAssignments: (mode, assignments) =>
    set((state) => ({
      speakerAssignments: {
        ...state.speakerAssignments,
        [mode]: normalizeSpeakerAssignments(assignments),
      },
    })),
  setSpeakerAssignment: (mode, speakerId, value) =>
    set((state) => {
      const normalizedSpeakerId = normalizeSpeakerId(speakerId);
      if (!normalizedSpeakerId) return {};

      const normalizedValue = normalizeSpeakerAssignment({
        firstName: typeof value?.firstName === "string" ? value.firstName : "",
        lastName: typeof value?.lastName === "string" ? value.lastName : "",
      });
      const nextModeAssignments = {
        ...state.speakerAssignments[mode],
      };
      if (hasSpeakerName(normalizedValue)) {
        nextModeAssignments[normalizedSpeakerId] = normalizedValue;
      } else {
        delete nextModeAssignments[normalizedSpeakerId];
      }

      return {
        speakerAssignments: {
          ...state.speakerAssignments,
          [mode]: nextModeAssignments,
        },
      };
    }),
  clearSpeakerAssignments: (mode) =>
    set((state) => ({
      speakerAssignments: {
        ...state.speakerAssignments,
        [mode]: {},
      },
    })),
  clearAllSpeakerAssignments: () =>
    set(() => ({
      speakerAssignments: createEmptySpeakerAssignmentsByMode(),
    })),
  setTranscriptionConfidence: (value: number | null) => set(() => ({ transcriptionConfidence: value })),
  setTranscriptionConfidenceSource: (value) => set(() => ({ transcriptionConfidenceSource: value })),
  setLogLevel: (value) => {
    const previous = get().logLevel;
    const next = normalizeLogLevel(value, previous);
    set(() => ({ logLevel: next }));
    logger.info("[asr-store] log level updated", {
      previous,
      next,
    });
    if (next === "debug") {
      logger.debug("[asr-store] debug logging enabled", {
        previous,
        next,
      });
    }
  },
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
  setHfApiToken: (value) => set(() => ({ hfApiToken: value })),
  setCloudMistralApiUrl: (value) => set(() => ({ cloudMistralApiUrl: value })),
  setMistralApiKey: (value) => set(() => ({ mistralApiKey: value })),
  setCloudMistralModel: (value) => set(() => ({ cloudMistralModel: value })),
  setCloudMistralDiarizationEnabled: (value) => set(() => ({ cloudMistralDiarizationEnabled: value })),
  setCloudDemeterModel: (value) => set(() => ({ cloudDemeterModel: value })),
  setCloudDemeterDiarizationEnabled: (value) => set(() => ({ cloudDemeterDiarizationEnabled: value })),
  setCloudDemeterChunking: (params) =>
    set((state) => ({
      cloudDemeterChunkDurationSec: clampDemeterChunkDurationSec(
        params.chunkDurationSec ?? state.cloudDemeterChunkDurationSec
      ),
    })),
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
  setLlmApiReportDetailLevel: (format, value) =>
    set((state) => ({
      llmApiReportDetailLevels: {
        ...state.llmApiReportDetailLevels,
        [format]: value,
      },
    })),
  setLlmApiReportDetailLevels: (value) =>
    set((state) => ({
      llmApiReportDetailLevels: {
        CRI: normalizeReportDetailLevel(value.CRI, state.llmApiReportDetailLevels.CRI),
        CRO: normalizeReportDetailLevel(value.CRO, state.llmApiReportDetailLevels.CRO),
        CRS: normalizeReportDetailLevel(value.CRS, state.llmApiReportDetailLevels.CRS),
      },
    })),
  setLlmApiReportGenerationMode: (value) =>
    set(() => ({
      llmApiReportGenerationMode: normalizeLlmReportGenerationMode(
        value,
        DEFAULT_SETTINGS.llmApiReportGenerationMode
      ),
    })),
  setLlmApiReportChunkRatio: (value) =>
    set(() => ({
      llmApiReportChunkRatio: normalizeLlmReportChunkRatio(value, DEFAULT_SETTINGS.llmApiReportChunkRatio),
    })),
  setLlmApiReportMaxSubpartsPerPart: (value) =>
    set(() => ({
      llmApiReportMaxSubpartsPerPart: normalizeLlmReportMaxSubpartsPerPart(
        value,
        DEFAULT_SETTINGS.llmApiReportMaxSubpartsPerPart
      ),
    })),
  setLlmApiReportMonoPassMaxTokens: (value) =>
    set(() => ({
      llmApiReportMonoPassMaxTokens: normalizeLlmReportMonoPassMaxTokens(
        value,
        DEFAULT_SETTINGS.llmApiReportMonoPassMaxTokens
      ),
    })),
  setLlmApiReportWorkflowTextMaxTokens: (value) =>
    set(() => ({
      llmApiReportWorkflowTextMaxTokens: normalizeLlmReportWorkflowTextMaxTokens(
        value,
        DEFAULT_SETTINGS.llmApiReportWorkflowTextMaxTokens
      ),
    })),
  setLlmApiStatus: (status, detail) => set(() => ({ llmApiStatus: status, llmApiStatusDetail: detail ?? undefined })),
  setLlmApiProgress: (value) =>
    set(() => ({ llmApiProgress: Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0 })),
  setLlmApiResult: (format, value) =>
    set((state) => ({ llmApiResults: { ...state.llmApiResults, [format]: value } })),
  setLlmApiReportDraft: (format, value) =>
    set((state) => {
      const nextDrafts = { ...state.llmApiReportDrafts };
      if (value) {
        nextDrafts[format] = cloneReportJson(value);
      } else {
        delete nextDrafts[format];
      }
      return { llmApiReportDrafts: nextDrafts };
    }),
  resetLlmApiReportDraft: (format) =>
    set((state) => {
      if (!(format in state.llmApiReportDrafts)) return {};
      const nextDrafts = { ...state.llmApiReportDrafts };
      delete nextDrafts[format];
      return { llmApiReportDrafts: nextDrafts };
    }),
  resetLlmApiReportDrafts: () => set(() => ({ llmApiReportDrafts: {} })),
  setLlmApiResults: (value) => set(() => ({ llmApiResults: value })),
  resetLlmApiSession: () =>
    set(() => ({
      llmApiStatus: "idle",
      llmApiStatusDetail: undefined,
      llmApiProgress: 0,
      llmApiResults: {},
      llmApiReportDrafts: {},
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
    set((state) => {
      logger.info("[asr-store] session reset", {
        previousStatus: state.status,
        segmentCount: state.segments.length,
        chunkMetricCount: state.chunkMetrics.length,
      });
      return {
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
        runExportHeaders: {
          upload: null,
          mic: null,
          cloud: null,
        },
        speakerAssignments: createEmptySpeakerAssignmentsByMode(),
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
        llmApiReportDrafts: {},
        llmLocalStatus: "idle",
        llmLocalStatusDetail: undefined,
        llmLocalProgress: 0,
        llmLocalResults: {},
        localUploadModelSizeAlert: null,
        llmLocalModelSizeAlert: null,
        cloudTranscriptionSession: createDefaultCloudTranscriptionSessionRuntime(),
        assistantWorkflow: createDefaultAssistantWorkflowRuntime(),
        previewUrl: state.previewUrl,
      };
    }),

  resetApp: () =>
    set((state) => {
      logger.warn("[asr-store] app reset requested", {
        previousStatus: state.status,
        segmentCount: state.segments.length,
        chunkMetricCount: state.chunkMetrics.length,
      });
      // Persist default settings and reset in-memory state
      try {
        saveSettings(DEFAULT_SETTINGS);
        lastPersistedSettingsSignature = JSON.stringify(DEFAULT_SETTINGS);
      } catch (e) {
        // Use logger so debug toggle controls this output
        logger.warn("resetApp: failed to persist default settings", e);
      }
      void clearSecureTokens();
      clearSessionTranscriptMemoriesFromSessionStorage();
      const nextState: Partial<AsrConfigStore> = {
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
        speakerAssignments: createEmptySpeakerAssignmentsByMode(),
        cloudTranscriptionSession: createDefaultCloudTranscriptionSessionRuntime(),
        assistantWorkflow: createDefaultAssistantWorkflowRuntime(),
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
      logger.info("[asr-store] app reset applied");
      return nextState;
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
let lastPersistedSettingsSignature = "";

useAsrStore.subscribe((state) => {
  if (!state.hasHydrated) {
    return;
  }
  const payload = serializePersistedSettings(state);
  const payloadSignature = JSON.stringify(payload);
  if (payloadSignature !== lastPersistedSettingsSignature) {
    lastPersistedSettingsSignature = payloadSignature;
    saveSettings(payload);
  }
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
