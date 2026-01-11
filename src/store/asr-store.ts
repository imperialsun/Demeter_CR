import { create } from "zustand";
import { loadSettings, saveSettings, type PersistedSettings, DEFAULT_SETTINGS } from "@/lib/storage";
import type { AudioMetadata } from "@/lib/audio";
import type { ChunkDefinition } from "@/lib/chunking";
import type { TranscriptionSegment } from "@/lib/export";
import type { TelemetryCollector, ChunkTelemetry, TelemetrySummary } from "@/lib/telemetry";

type PresetKey = "fast" | "balanced" | "quality" | "custom";

export type BackendImplementation = "webgpu" | "wasm";

export type PipelineStatus =
  | "idle"
  | "downloading"
  | "loading"
  | "ready"
  | "transcribing"
  | "stopping"
  | "error";

export interface ModelPreset {
  key: PresetKey;
  label: string;
  modelId: string;
  description: string;
}

export const MODEL_PRESETS: Record<Exclude<PresetKey, "custom">, ModelPreset> = {
  fast: {
    key: "fast",
    label: "Rapide (whisper-tiny)",
    modelId: "Xenova/whisper-tiny",
    description: "Latence minimale, qualité correcte pour des itérations rapides.",
  },
  balanced: {
    key: "balanced",
    label: "Équilibre (whisper-base)",
    modelId: "Xenova/whisper-base",
    description: "Bon compromis précision/temps pour la production quotidienne.",
  },
  quality: {
    key: "quality",
    label: "Qualité (whisper-small)",
    modelId: "Xenova/whisper-small",
    description: "Précision maximale avec coût temps/mémoire plus élevé.",
  },
};

type SessionSource = {
  id: string;
  label: string;
  type: "file" | "mic";
};

interface AsrConfigState {
  activePreset: PresetKey;
  customModelId: string;
  backendPreference: BackendImplementation;
  webGpuSupported: boolean;
  wasmAvailable: boolean;
  status: PipelineStatus;
  statusDetail?: string;
  activeBackend?: BackendImplementation;
  memoryMode: "full" | "progressive";
  chunkStrategy: "sequential" | "overlap" | "silence";
  segmentationMode: "chunks" | "silence";
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
  preprocessingMode: "quick" | "full";
  denoiseNoiseFloorDb: number;
  denoiseReductionDb: number;
  denoiseSmoothing: number;
  denoiseCalibrationSeconds: number;
  noiseCalibrationRequestedAt?: number | null;
  telemetryCollector: TelemetryCollector | null;
  chunkPlan: ChunkDefinition[];
  chunkMetrics: ChunkTelemetry[];
  segments: TranscriptionSegment[];
  audioMetadata: AudioMetadata | null;
  audioSource: SessionSource | null;
  telemetrySummary: TelemetrySummary | null;
  isTranscribing: boolean;
  stopRequested: boolean;
  progress: number;

  // Performance options
  forceSingleThread: boolean; // when true, force single-threaded WASM
  wasmThreads: number | null; // effective number of threads in use (null = unknown)
}

interface AsrConfigActions {
  setPreset: (preset: PresetKey, customModelId?: string) => void;
  setBackendPreference: (backend: BackendImplementation) => void;
  setStatus: (status: PipelineStatus, detail?: string) => void;
  setActiveBackend: (backend: BackendImplementation | undefined) => void;
  setMemoryMode: (mode: "full" | "progressive") => void;
  setChunkStrategy: (strategy: "sequential" | "overlap" | "silence") => void;
  setSegmentationMode: (mode: "chunks" | "silence") => void;
  updateChunkParameters: (params: Partial<{
    chunkDurationSec: number;
    overlapSec: number;
    silenceThresholdDb: number;
    minSilenceMs: number;
    minChunkMs: number;
    maxChunkMs: number;
  }>) => void;
  setShowSegments: (value: boolean) => void;
  setShowExportVtt: (value: boolean) => void;
  setShowExportSrt: (value: boolean) => void;
  setShowExportJson: (value: boolean) => void;
  setShowExportTelemetry: (value: boolean) => void;
  setPreprocessingMode: (mode: "quick" | "full") => void;
  setDenoiseParams: (params: Partial<{
    denoiseNoiseFloorDb: number;
    denoiseReductionDb: number;
    denoiseSmoothing: number;
    denoiseCalibrationSeconds: number;
  }>) => void;
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
  setIsTranscribing: (value: boolean) => void;
  setProgress: (value: number) => void;
  requestStop: () => void;
  resetStopRequest: () => void;
  resetSession: () => void;
  resetApp: () => void;
  setWebGpuSupport: (supported: boolean) => void;
  setWasmAvailable: (available: boolean) => void;
  // performance
  setForceSingleThread: (value: boolean) => void;
  setWasmThreads: (value: number | null) => void;
}

export type AsrConfigStore = AsrConfigState & AsrConfigActions;

const initialState: AsrConfigState = {
  activePreset: "fast",
  customModelId: "",
  backendPreference: "webgpu",
  webGpuSupported: true,
  wasmAvailable: true,
  status: "idle",
  statusDetail: undefined,
  activeBackend: undefined,
  memoryMode: "full",
  chunkStrategy: "overlap",
  segmentationMode: "chunks",
  chunkDurationSec: 20,
  overlapSec: 3,
  silenceThresholdDb: -35,
  minSilenceMs: 600,
  minChunkMs: 3000,
  maxChunkMs: 30000,
  showSegments: false,
  showExportVtt: false,
  showExportSrt: false,
  showExportJson: false,
  showExportTelemetry: false,
  preprocessingMode: "quick",
  denoiseNoiseFloorDb: -25,
  denoiseReductionDb: 12,
  denoiseSmoothing: 0.8,
  denoiseCalibrationSeconds: 1,
  noiseCalibrationRequestedAt: null,
  telemetryCollector: null,
  chunkPlan: [],
  chunkMetrics: [],
  segments: [],
  audioMetadata: null,
  audioSource: null,
  telemetrySummary: null,
  isTranscribing: false,
  stopRequested: false,
  progress: 0,
  // defaults
  forceSingleThread: true,
  wasmThreads: null,
};

export const useAsrStore = create<AsrConfigStore>((set) => ({
  ...initialState,
  setPreset: (preset, customId) =>
    set(() => ({
      activePreset: preset,
      customModelId: customId ?? "",
    })),
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
  updateChunkParameters: (params) => set((state) => ({
    ...state,
    ...params,
  })),
  setShowSegments: (value) => set(() => ({ showSegments: value })),
  setShowExportVtt: (value) => set(() => ({ showExportVtt: value })),
  setShowExportSrt: (value) => set(() => ({ showExportSrt: value })),
  setShowExportJson: (value) => set(() => ({ showExportJson: value })),
  setShowExportTelemetry: (value) => set(() => ({ showExportTelemetry: value })),
  hydrateFromStorage: () => {
    const settings = loadSettings();
    if (!settings) return;
    set((state) => ({
      ...state,
      activePreset: settings.activePreset,
      customModelId: settings.customModelId,
      backendPreference:
        settings.backendPreference === "wasm" || settings.backendPreference === "webgpu"
          ? settings.backendPreference
          : state.webGpuSupported
            ? "webgpu"
            : "wasm",
      memoryMode: settings.memoryMode,
      chunkStrategy: settings.chunkStrategy,
      segmentationMode: settings.segmentationMode,
      chunkDurationSec: settings.chunkDurationSec,
      overlapSec: settings.overlapSec,
      silenceThresholdDb: settings.silenceThresholdDb,
      minSilenceMs: settings.minSilenceMs,
      minChunkMs: settings.minChunkMs,
      maxChunkMs: settings.maxChunkMs,
      showSegments: settings.showSegments ?? state.showSegments,
      showExportVtt: settings.showExportVtt ?? state.showExportVtt,
      showExportSrt: settings.showExportSrt ?? state.showExportSrt,
      showExportJson: settings.showExportJson ?? state.showExportJson,
      showExportTelemetry: settings.showExportTelemetry ?? state.showExportTelemetry,
      preprocessingMode: settings.preprocessingMode ?? state.preprocessingMode,
      denoiseNoiseFloorDb: settings.denoiseNoiseFloorDb ?? state.denoiseNoiseFloorDb,
      denoiseReductionDb: settings.denoiseReductionDb ?? state.denoiseReductionDb,
      denoiseSmoothing: settings.denoiseSmoothing ?? state.denoiseSmoothing,
      denoiseCalibrationSeconds: settings.denoiseCalibrationSeconds ?? state.denoiseCalibrationSeconds,
      forceSingleThread: settings.forceSingleThread ?? state.forceSingleThread,
    }));
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
  setForceSingleThread: (value: boolean) => set(() => ({ forceSingleThread: value })),
  setWasmThreads: (value: number | null) => set(() => ({ wasmThreads: value })),
  setIsTranscribing: (value) => set(() => ({ isTranscribing: value })),

  setProgress: (value) => set(() => ({ progress: value })),
  setPreprocessingMode: (mode) => set(() => ({ preprocessingMode: mode })),
  setDenoiseParams: (params) => set((state) => ({ ...state, ...params })),
  requestNoiseCalibration: () => set(() => ({ noiseCalibrationRequestedAt: Date.now() })),
  clearNoiseCalibrationRequest: () => set(() => ({ noiseCalibrationRequestedAt: null })),
  requestStop: () => set(() => ({ stopRequested: true })),
  resetStopRequest: () => set(() => ({ stopRequested: false })),
  resetSession: () =>
    set((state) => ({
      ...state,
      status: "idle",
      statusDetail: undefined,
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
    })),
  resetApp: () =>
    set((state) => {
      // Persist default settings and reset in-memory state
      try {
        saveSettings(DEFAULT_SETTINGS);
      } catch (e) {
        console.warn("resetApp: failed to persist default settings", e);
      }
      return {
        ...initialState,
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
        isTranscribing: false,
        stopRequested: false,
        progress: 0,
      };
    }),
  setWebGpuSupport: (supported) => set(() => ({ webGpuSupported: supported })),
  setWasmAvailable: (available) => set(() => ({ wasmAvailable: available })),

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

useAsrStore.subscribe((state) => {
  const payload: PersistedSettings = {
    activePreset: state.activePreset,
    customModelId: state.customModelId,
    backendPreference: state.backendPreference,
    memoryMode: state.memoryMode,
    chunkStrategy: state.chunkStrategy,
    segmentationMode: state.segmentationMode,
    chunkDurationSec: state.chunkDurationSec,
    overlapSec: state.overlapSec,
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
    // performance
    forceSingleThread: state.forceSingleThread,
  };
  saveSettings(payload);
});
