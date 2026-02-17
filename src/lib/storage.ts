import type {
  BackendImplementation,
  DedupeMode,
  LlmApiProvider,
  LlmLocalModelSettings,
  LlmLocalModelProfile,
  ModelDtype,
  PresetKey,
} from "@/store/asr-store";
import {
  createDefaultLocalModelSettingsByProfile,
  DEFAULT_LLM_LOCAL_MAX_TOKENS,
  DEFAULT_LLM_LOCAL_MODEL_ID,
  DEFAULT_LLM_LOCAL_PROFILE,
  DEFAULT_LLM_LOCAL_TEMPERATURE,
} from "@/lib/llm/localModelCatalog";
import logger from "@/lib/logger";

const STORAGE_KEY = "demeter-asr-settings";

export interface PersistedSettings {
  activePreset: PresetKey;
  customModelId: string;
  presetQuantizationOverrides?: Partial<
    Record<Exclude<PresetKey, "custom">, Partial<Record<BackendImplementation, ModelDtype>>>
  >;
  blockedPresets?: PresetKey[];
  backendPreference: BackendImplementation;
  memoryMode: "full" | "progressive";
  chunkStrategy: "sequential" | "overlap" | "silence";
  segmentationMode: "chunks" | "silence";
  dedupeMode?: DedupeMode;
  cleanIntraChunk?: boolean;
  preprocessingMode: "quick" | "full";
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
  autoTunePreprocess?: boolean;
  // Whisper options
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
  // Debug toggles
  debugConfidence?: boolean;
  // performance
  forceSingleThread?: boolean;
  // Mic-specific settings
  micActivePreset?: PresetKey;
  micCustomModelId?: string;
  micBackendPreference?: BackendImplementation;
  micPreprocessingMode?: "quick" | "full";
  micSegmentationMode?: "chunks" | "silence";
  micSilenceThresholdDb?: number;
  micNoiseCalibrationMarginDb?: number;
  micMinSilenceMs?: number;
  micMinChunkMs?: number;
  micMaxChunkMs?: number;
  micShowExportVtt?: boolean;
  micShowExportSrt?: boolean;
  micShowExportJson?: boolean;
  micShowExportTelemetry?: boolean;
  micDenoiseNoiseFloorDb?: number;
  micDenoiseReductionDb?: number;
  micDenoiseSmoothing?: number;
  micDenoiseCalibrationSeconds?: number;
  micPreprocessEnableFilters?: boolean;
  micPreprocessHighpassHz?: number;
  micPreprocessLowpassHz?: number;
  micPreprocessEnableLufs?: boolean;
  micPreprocessTargetLufs?: number;
  micPreprocessLimiterEnabled?: boolean;
  micPreprocessLimiterThresholdDb?: number;
  micPreprocessLimiterSoftness?: number;
  micPreprocessVadEnabled?: boolean;
  micPreprocessVadThresholdDb?: number;
  micPreprocessVadMinSilenceMs?: number;
  micPreprocessOverlapAdd?: boolean;
  micPreprocessOverlapBlockSec?: number;
  micPreprocessOverlapSec?: number;
  micAutoTunePreprocess?: boolean;
  micEnableWordTimestamps?: boolean;
  micShowSegmentConfidence?: boolean;
  micForceSingleThread?: boolean;
  // Cloud-specific settings
  cloudApiUrl?: string;
  cloudHfToken?: string;
  cloudMistralApiUrl?: string;
  cloudMistralApiKey?: string;
  cloudMistralModel?: string;
  cloudMistralDiarizationEnabled?: boolean;
  cloudWhisperChunkDurationSec?: number;
  cloudWhisperOverlapSec?: number;
  cloudMistralChunkDurationSec?: number;
  cloudMistralOverlapSec?: number;
  cloudMaxTokens?: number;
  cloudTemperature?: number;
  cloudTopP?: number;
  cloudDoSample?: boolean;
  cloudContextPreset?: string;
  cloudShowSegments?: boolean;
  cloudShowExportVtt?: boolean;
  cloudShowExportSrt?: boolean;
  cloudShowExportJson?: boolean;
  cloudShowExportTelemetry?: boolean;
  cloudPreprocessingMode?: "quick" | "full";
  cloudDenoiseNoiseFloorDb?: number;
  cloudDenoiseReductionDb?: number;
  cloudDenoiseSmoothing?: number;
  cloudDenoiseCalibrationSeconds?: number;
  cloudPreprocessEnableFilters?: boolean;
  cloudPreprocessHighpassHz?: number;
  cloudPreprocessLowpassHz?: number;
  cloudPreprocessEnableLufs?: boolean;
  cloudPreprocessTargetLufs?: number;
  cloudPreprocessLimiterEnabled?: boolean;
  cloudPreprocessLimiterThresholdDb?: number;
  cloudPreprocessLimiterSoftness?: number;
  cloudPreprocessVadEnabled?: boolean;
  cloudPreprocessVadThresholdDb?: number;
  cloudPreprocessVadMinSilenceMs?: number;
  cloudPreprocessOverlapAdd?: boolean;
  cloudPreprocessOverlapBlockSec?: number;
  cloudPreprocessOverlapSec?: number;
  cloudAutoTunePreprocess?: boolean;
  cloudEnableWordTimestamps?: boolean;
  cloudShowSegmentConfidence?: boolean;
  // LLM API settings
  llmApiProvider?: LlmApiProvider;
  llmApiHfToken?: string;
  llmApiHfModelId?: string;
  llmApiHfTemperature?: number;
  llmApiHfMaxTokens?: number;
  llmApiMistralModelId?: string;
  llmApiMistralTemperature?: number;
  llmApiMistralMaxTokens?: number;
  // LLM local settings
  llmLocalModelProfile?: LlmLocalModelProfile;
  llmLocalModelId?: string;
  llmLocalTemperature?: number;
  llmLocalMaxTokens?: number;
  llmLocalBackendPreference?: BackendImplementation;
  llmLocalDtypeWebgpu?: ModelDtype;
  llmLocalDtypeWasm?: ModelDtype;
  llmLocalSettingsByProfile?: Record<LlmLocalModelProfile, LlmLocalModelSettings>;
  // Legacy shared llm pipeline settings (read-only fallback migration)
  llmApiModelId?: string;
  llmApiTemperature?: number;
  llmApiMaxTokens?: number;
}

export function loadSettings(): Partial<PersistedSettings> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSettings;
  } catch (error) {
    logger.warn("Impossible de charger les paramètres depuis le stockage local", error);
    return null;
  }
}

export function saveSettings(settings: PersistedSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    logger.warn("Impossible d'enregistrer les paramètres", error);
  }
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  activePreset: "fast",
  customModelId: "",
  presetQuantizationOverrides: {},
  blockedPresets: [],
  backendPreference: "webgpu",
  memoryMode: "full",
  chunkStrategy: "overlap",
  segmentationMode: "chunks",
  dedupeMode: "fuzzy",
  cleanIntraChunk: true,
  chunkDurationSec: 15,
  overlapSec: 1.5,
  progressiveSegmentDurationSec: 600,
  silenceThresholdDb: -35,
  minSilenceMs: 600,
  minChunkMs: 3000,
  maxChunkMs: 30000,
  showSegments: true,
  showExportVtt: false,
  showExportSrt: false,
  showExportJson: false,
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
  preprocessVadThresholdDb: -42,
  preprocessVadMinSilenceMs: 250,
  preprocessOverlapAdd: true,
  preprocessOverlapBlockSec: 1.4,
  preprocessOverlapSec: 0.3,
  autoTunePreprocess: true,
  // Whisper: enable word timestamps (disabled by default to save CPU/memory)
  enableWordTimestamps: false,
  showSegmentConfidence: false,
  // Debug toggles
  debugConfidence: false,
  // default performance settings
  forceSingleThread: false,
  // mic defaults
  micActivePreset: "fast",
  micCustomModelId: "",
  micBackendPreference: "webgpu",
  micPreprocessingMode: "full",
  micSegmentationMode: "silence",
  micSilenceThresholdDb: -35,
  micNoiseCalibrationMarginDb: 6,
  micMinSilenceMs: 300,
  micMinChunkMs: 10000,
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
  micPreprocessVadThresholdDb: -42,
  micPreprocessVadMinSilenceMs: 250,
  micPreprocessOverlapAdd: true,
  micPreprocessOverlapBlockSec: 1.4,
  micPreprocessOverlapSec: 0.3,
  micAutoTunePreprocess: true,
  micEnableWordTimestamps: false,
  micShowSegmentConfidence: false,
  micForceSingleThread: false,
  // cloud defaults
  cloudApiUrl: "https://transcode.demeter-sante.fr/gradio",
  cloudHfToken: "",
  cloudMistralApiUrl: "https://api.mistral.ai",
  cloudMistralApiKey: "",
  cloudMistralModel: "voxtral-mini-latest",
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
  cloudShowExportVtt: false,
  cloudShowExportSrt: false,
  cloudShowExportJson: false,
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
  // llm cloud defaults
  llmApiProvider: "huggingface",
  llmApiHfToken: "",
  llmApiHfModelId: "openai/gpt-oss-20b",
  llmApiHfTemperature: 0.2,
  llmApiHfMaxTokens: 131072,
  llmApiMistralModelId: "mistral-medium-latest",
  llmApiMistralTemperature: 0.2,
  llmApiMistralMaxTokens: 8192,
  // llm local defaults
  llmLocalModelProfile: DEFAULT_LLM_LOCAL_PROFILE,
  llmLocalModelId: DEFAULT_LLM_LOCAL_MODEL_ID,
  llmLocalTemperature: DEFAULT_LLM_LOCAL_TEMPERATURE,
  llmLocalMaxTokens: DEFAULT_LLM_LOCAL_MAX_TOKENS,
  llmLocalBackendPreference: "webgpu",
  llmLocalDtypeWebgpu: "q4f16",
  llmLocalDtypeWasm: "q8",
  llmLocalSettingsByProfile: createDefaultLocalModelSettingsByProfile(),
};
