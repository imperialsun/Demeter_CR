import type {
  BackendImplementation,
  DedupeMode,
  LlmApiProvider,
  LlmLocalModelSettings,
  LlmLocalModelProfile,
  ModelDtype,
  PresetKey,
} from "@/store/asr-store";
import type { ReportFormat } from "@/lib/llm/reportSchema";
import { DEFAULT_REPORT_DETAIL_LEVELS, type ReportDetailLevel } from "@/lib/llm/reportDetail";
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
export const DEMETER_CHUNK_DURATION_MIN_SEC = 10 * 60;
export const DEMETER_CHUNK_DURATION_MAX_SEC = 28 * 60;
export const DEMETER_CHUNK_DURATION_DEFAULT_SEC = 25 * 60;
export const LLM_REPORT_CHUNK_RATIO_DEFAULT = 0.5;
export const LLM_REPORT_MAX_SUBPARTS_PER_PART_DEFAULT = 4;
export type LlmReportGenerationMode = "mono_pass" | "multi_pass";
export const LLM_REPORT_GENERATION_MODE_DEFAULT: LlmReportGenerationMode = "mono_pass";
export const LLM_REPORT_MONO_PASS_MAX_TOKENS_DEFAULT = 16384;
export const LLM_REPORT_MONO_PASS_MAX_TOKENS_MIN = 1024;
export const LLM_REPORT_MONO_PASS_MAX_TOKENS_MAX = 32768;
export const LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_DEFAULT = 8192;
export const LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_MIN = 1024;
export const LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_MAX = 32768;

export function clampDemeterChunkDurationSec(value: number): number {
  if (!Number.isFinite(value)) {
    return DEMETER_CHUNK_DURATION_DEFAULT_SEC;
  }
  const rounded = Math.round(value);
  return Math.max(DEMETER_CHUNK_DURATION_MIN_SEC, Math.min(DEMETER_CHUNK_DURATION_MAX_SEC, rounded));
}

export function normalizeLlmReportChunkRatio(value: unknown, fallback = LLM_REPORT_CHUNK_RATIO_DEFAULT): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0.1, Math.min(1, value));
}

export function normalizeLlmReportMaxSubpartsPerPart(
  value: unknown,
  fallback = LLM_REPORT_MAX_SUBPARTS_PER_PART_DEFAULT
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(8, Math.round(value)));
}

function normalizeLlmReportTokenLimit(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function normalizeLlmReportGenerationMode(
  value: unknown,
  fallback: LlmReportGenerationMode = LLM_REPORT_GENERATION_MODE_DEFAULT
): LlmReportGenerationMode {
  return value === "mono_pass" || value === "multi_pass" ? value : fallback;
}

export function normalizeLlmReportMonoPassMaxTokens(
  value: unknown,
  fallback = LLM_REPORT_MONO_PASS_MAX_TOKENS_DEFAULT
): number {
  return normalizeLlmReportTokenLimit(
    value,
    fallback,
    LLM_REPORT_MONO_PASS_MAX_TOKENS_MIN,
    LLM_REPORT_MONO_PASS_MAX_TOKENS_MAX
  );
}

export function normalizeLlmReportWorkflowTextMaxTokens(
  value: unknown,
  fallback = LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_DEFAULT
): number {
  return normalizeLlmReportTokenLimit(
    value,
    fallback,
    LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_MIN,
    LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_MAX
  );
}

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
  // LLM API settings
  llmApiProvider: LlmApiProvider;
  llmApiHfModelId: string;
  llmApiHfTemperature: number;
  llmApiHfMaxTokens: number;
  llmApiMistralModelId: string;
  llmApiMistralTemperature: number;
  llmApiMistralMaxTokens: number;
  llmApiReportDetailLevels: Record<ReportFormat, ReportDetailLevel>;
  llmApiReportEnabledFormats: Record<ReportFormat, boolean>;
  llmApiReportGenerationMode: LlmReportGenerationMode;
  llmApiReportChunkRatio: number;
  llmApiReportMaxSubpartsPerPart: number;
  llmApiReportMonoPassMaxTokens: number;
  llmApiReportWorkflowTextMaxTokens: number;
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

function migratePersistedReportSettings(settings: PersistedSettingsInput): PersistedSettingsInput {
  const hasReportSettings =
    "llmApiReportGenerationMode" in settings ||
    "llmApiReportMonoPassMaxTokens" in settings ||
    "llmApiReportWorkflowTextMaxTokens" in settings;
  if (!hasReportSettings) {
    return settings;
  }

  let migrated: PersistedSettingsInput = settings;
  const ensureCopy = () => {
    if (migrated === settings) {
      migrated = { ...settings };
    }
  };
  if (!("llmApiReportGenerationMode" in migrated)) {
    ensureCopy();
    migrated.llmApiReportGenerationMode = DEFAULT_SETTINGS.llmApiReportGenerationMode;
  }

  const workflowTextMaxTokens = migrated.llmApiReportWorkflowTextMaxTokens;
  const monoPassMaxTokens = migrated.llmApiReportMonoPassMaxTokens;
  if (typeof monoPassMaxTokens !== "number" && typeof workflowTextMaxTokens === "number") {
    ensureCopy();
    migrated.llmApiReportMonoPassMaxTokens = workflowTextMaxTokens;
  }
  if (typeof workflowTextMaxTokens !== "number" && typeof migrated.llmApiReportMonoPassMaxTokens === "number") {
    ensureCopy();
    migrated.llmApiReportWorkflowTextMaxTokens = migrated.llmApiReportMonoPassMaxTokens;
  }

  return migrated;
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
    const migrated = migratePersistedReportSettings(sanitized);
    // Backward compatibility: purge sensitive values from existing persisted blobs.
    if (hasSensitiveSettings(parsed) || hasLegacySettings(parsed) || migrated !== sanitized) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      logger.info("[settings][storage] sanitized persisted settings blob", {
        removedSensitiveKeys: hasSensitiveSettings(parsed),
        removedLegacyKeys: hasLegacySettings(parsed),
        migratedReportSettings: migrated !== sanitized,
      });
    }
    logger.debug("[settings][storage] loaded settings", {
      keyCount: Object.keys(migrated).length,
      logLevel: migrated.logLevel ?? DEFAULT_SETTINGS.logLevel,
    });
    return migrated;
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
  cloudDemeterChunkDurationSec: DEMETER_CHUNK_DURATION_DEFAULT_SEC,
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
  llmApiProvider: "demeter_sante",
  llmApiHfModelId: "openai/gpt-oss-20b",
  llmApiHfTemperature: 0.2,
  llmApiHfMaxTokens: 131072,
  llmApiMistralModelId: "mistral-medium-latest",
  llmApiMistralTemperature: 0.2,
  llmApiMistralMaxTokens: 8192,
  llmApiReportDetailLevels: { ...DEFAULT_REPORT_DETAIL_LEVELS },
  llmApiReportEnabledFormats: {
    CUSTOM: false,
    CRI: true,
    CRO: true,
    CRS: true,
    CRN: true,
  },
  llmApiReportChunkRatio: LLM_REPORT_CHUNK_RATIO_DEFAULT,
  llmApiReportMaxSubpartsPerPart: LLM_REPORT_MAX_SUBPARTS_PER_PART_DEFAULT,
  llmApiReportGenerationMode: LLM_REPORT_GENERATION_MODE_DEFAULT,
  llmApiReportMonoPassMaxTokens: LLM_REPORT_MONO_PASS_MAX_TOKENS_DEFAULT,
  llmApiReportWorkflowTextMaxTokens: LLM_REPORT_WORKFLOW_TEXT_MAX_TOKENS_DEFAULT,
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
