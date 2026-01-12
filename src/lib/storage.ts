import type { BackendImplementation } from "@/store/asr-store";

const STORAGE_KEY = "demeter-asr-settings";

export interface PersistedSettings {
  activePreset: "fast" | "balanced" | "quality" | "custom";
  customModelId: string;
  backendPreference: BackendImplementation;
  memoryMode: "full" | "progressive";
  chunkStrategy: "sequential" | "overlap" | "silence";
  segmentationMode: "chunks" | "silence";
  preprocessingMode: "quick" | "full";
  chunkDurationSec: number;
  overlapSec: number;
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
  autoTunePreprocess?: boolean;
  // Whisper options
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
  // performance
  forceSingleThread?: boolean;
}

export function loadSettings(): Partial<PersistedSettings> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSettings;
  } catch (error) {
    console.warn("Impossible de charger les paramètres depuis le stockage local", error);
    return null;
  }
}

export function saveSettings(settings: PersistedSettings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (error) {
    console.warn("Impossible d'enregistrer les paramètres", error);
  }
}

export const DEFAULT_SETTINGS: PersistedSettings = {
  activePreset: "fast",
  customModelId: "",
  backendPreference: "webgpu",
  memoryMode: "full",
  chunkStrategy: "overlap",
  segmentationMode: "chunks",
  chunkDurationSec: 15,
  overlapSec: 1.5,
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
  denoiseNoiseFloorDb: -25,
  denoiseReductionDb: 12,
  denoiseSmoothing: 0.8,
  denoiseCalibrationSeconds: 5,
  autoTunePreprocess: true,
  // Whisper: enable word timestamps (disabled by default to save CPU/memory)
  enableWordTimestamps: false,
  showSegmentConfidence: false,
  // default performance settings
  forceSingleThread: false,
};
