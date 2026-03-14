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
import logger, { type LogLevel } from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import { isBackendAuthenticated } from "@/lib/backend-session";
import { queueBackendSettingsSync } from "@/lib/backend-settings-sync";

const STORAGE_KEY = "demeter-asr-settings";
export const SETTINGS_STORAGE_KEY = STORAGE_KEY;
const SENSITIVE_SETTING_KEYS = [
  "hfApiToken",
  "mistralApiKey",
  "cloudHfToken",
  "cloudMistralApiKey",
  "llmApiHfToken",
] as const;
const LEGACY_SETTING_KEYS = ["cloudApiUrl", "cloudContextPreset"] as const;

export interface PersistedSettings {
  activePreset: PresetKey;
  customModelId: string;
  presetQuantizationOverrides: Partial<
    Record<Exclude<PresetKey, "custom">, Partial<Record<BackendImplementation, ModelDtype>>>
  >;
  blockedPresets: PresetKey[];
  backendPreference: BackendImplementation;
  memoryMode: "full" | "progressive";
  chunkStrategy: "sequential" | "overlap" | "silence";
  segmentationMode: "chunks" | "silence";
  dedupeMode: DedupeMode;
  cleanIntraChunk: boolean;
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
  autoTunePreprocess: boolean;
  // Whisper options
  enableWordTimestamps: boolean;
  showSegmentConfidence: boolean;
  logLevel: LogLevel;
  // performance
  forceSingleThread: boolean;
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
  cloudMistralApiUrl: string;
  cloudMistralModel: string;
  cloudMistralDiarizationEnabled: boolean;
  cloudDemeterModel: string;
  cloudDemeterDiarizationEnabled: boolean;
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
  // LLM API settings
  llmApiProvider: LlmApiProvider;
  llmApiHfModelId: string;
  llmApiHfTemperature: number;
  llmApiHfMaxTokens: number;
  llmApiMistralModelId: string;
  llmApiMistralTemperature: number;
  llmApiMistralMaxTokens: number;
  // LLM local settings
  llmLocalModelProfile: LlmLocalModelProfile;
  llmLocalModelId: string;
  llmLocalTemperature: number;
  llmLocalMaxTokens: number;
  llmLocalBackendPreference: BackendImplementation;
  llmLocalDtypeWebgpu: ModelDtype;
  llmLocalDtypeWasm: ModelDtype;
  llmLocalSettingsByProfile: Record<LlmLocalModelProfile, LlmLocalModelSettings>;
  llmLocalForceSingleThread: boolean;
}

export interface LegacyPersistedSettings {
  debugConfidence?: boolean;
  llmApiModelId?: string;
  llmApiTemperature?: number;
  llmApiMaxTokens?: number;
}

export type PersistedSettingsInput = Partial<PersistedSettings> & LegacyPersistedSettings;

function stripSensitiveSettings<T extends object>(settings: T): T {
  const sanitized = { ...settings } as Record<string, unknown>;
  for (const key of SENSITIVE_SETTING_KEYS) {
    if (key in sanitized) {
      delete sanitized[key];
    }
  }
  for (const key of LEGACY_SETTING_KEYS) {
    if (key in sanitized) {
      delete sanitized[key];
    }
  }
  return sanitized as T;
}

function hasSensitiveSettings(settings: object) {
  return SENSITIVE_SETTING_KEYS.some((key) => key in settings);
}

function hasLegacySettings(settings: object) {
  return LEGACY_SETTING_KEYS.some((key) => key in settings);
}

function parseStoredSettings(): PersistedSettingsInput | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed as PersistedSettingsInput;
}

export function loadSettings(): PersistedSettingsInput | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed = parseStoredSettings();
    if (!parsed) {
      logger.info("[settings][storage] no persisted settings found");
      return null;
    }
    const sanitized = stripSensitiveSettings(parsed);
    // Backward compatibility: purge sensitive values from existing persisted blobs.
    if (hasSensitiveSettings(parsed) || hasLegacySettings(parsed)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
      logger.info("[settings][storage] sanitized persisted settings blob", {
        removedSensitiveKeys: hasSensitiveSettings(parsed),
        removedLegacyKeys: hasLegacySettings(parsed),
      });
    }
    logger.debug("[settings][storage] loaded settings", {
      keyCount: Object.keys(sanitized).length,
      logLevel: sanitized.logLevel ?? DEFAULT_SETTINGS.logLevel,
    });
    return sanitized;
  } catch (error) {
    logger.warn("Impossible de charger les paramètres depuis le stockage local", error);
    return null;
  }
}

export function saveSettings(settings: PersistedSettings) {
  if (typeof window === "undefined") return;
  try {
    const sanitized = stripSensitiveSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
    logger.debug("[settings][storage] settings persisted", {
      keyCount: Object.keys(sanitized).length,
      logLevel: sanitized.logLevel ?? DEFAULT_SETTINGS.logLevel,
      backendMode: isBackendMode(),
      backendAuthenticated: isBackendAuthenticated(),
    });
    if (isBackendMode() && isBackendAuthenticated()) {
      queueBackendSettingsSync(sanitized as unknown as Record<string, unknown>);
      logger.info("[settings][storage] queued backend settings sync", {
        keyCount: Object.keys(sanitized).length,
      });
    }
  } catch (error) {
    logger.warn("Impossible d'enregistrer les paramètres", error);
  }
}

export function replaceSettingsCacheFromBackend(settings: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const sanitized = stripSensitiveSettings(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
    logger.info("[settings][storage] backend cache replaced", {
      keyCount: Object.keys(sanitized).length,
    });
  } catch (error) {
    logger.warn("Impossible de remplacer le cache settings backend", error);
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
  preprocessVadThresholdDb: -42,
  preprocessVadMinSilenceMs: 250,
  preprocessOverlapAdd: true,
  preprocessOverlapBlockSec: 1.4,
  preprocessOverlapSec: 0.3,
  autoTunePreprocess: true,
  // Whisper: enable word timestamps (disabled by default to save CPU/memory)
  enableWordTimestamps: false,
  showSegmentConfidence: false,
  logLevel: "info",
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
  cloudMistralApiUrl: "https://api.mistral.ai",
  cloudMistralModel: "voxtral-mini-latest",
  cloudMistralDiarizationEnabled: true,
  cloudDemeterModel: "voxtral-mini-latest",
  cloudDemeterDiarizationEnabled: true,
  cloudWhisperChunkDurationSec: 30,
  cloudWhisperOverlapSec: 0,
  cloudMistralChunkDurationSec: 900,
  cloudMistralOverlapSec: 0,
  cloudMaxTokens: 32768,
  cloudTemperature: 0,
  cloudTopP: 1,
  cloudDoSample: false,
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
  // llm cloud defaults
  llmApiProvider: "huggingface",
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
  llmLocalForceSingleThread: false,
};

export const PERSISTED_SETTINGS_KEYS = Object.freeze(
  Object.keys(DEFAULT_SETTINGS) as Array<keyof PersistedSettings>
);

export const LEGACY_PERSISTED_SETTINGS_KEYS = [
  "debugConfidence",
  "llmApiModelId",
  "llmApiTemperature",
  "llmApiMaxTokens",
] as const satisfies ReadonlyArray<keyof LegacyPersistedSettings>;
