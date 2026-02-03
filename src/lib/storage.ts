import type { BackendImplementation, DedupeMode, PresetKey } from "@/store/asr-store";
import logger from "@/lib/logger";

const STORAGE_KEY = "demeter-asr-settings";

export interface PersistedSettings {
  activePreset: "fast" | "balanced" | "medium" | "quality" | "french" | "custom";
  customModelId: string;
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
  micActivePreset?: "fast" | "balanced" | "medium" | "quality" | "french" | "custom";
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
};
