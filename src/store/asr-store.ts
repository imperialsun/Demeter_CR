import { create } from "zustand";
import logger from "@/lib/logger";
import { loadSettings, saveSettings, type PersistedSettings, DEFAULT_SETTINGS } from "@/lib/storage";
import type { AudioMetadata } from "@/lib/audio";
import { computeDefaultOverlap } from "@/lib/chunking";
import type { ChunkDefinition } from "@/lib/chunking";
import type { TranscriptionSegment } from "@/lib/export";
import type { TelemetryCollector, ChunkTelemetry, TelemetrySummary } from "@/lib/telemetry";

type PresetKey = "fast" | "balanced" | "medium" | "quality" | "french" | "custom";

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
  medium: {
    key: "medium",
    label: "Intermédiaire (whisper-small)",
    modelId: "Xenova/whisper-small",
    description: "Meilleure précision que l'option Équilibre (whisper-base), latence et mémoire modérées.",
  },
  quality: {
    key: "quality",
    label: "Qualité (whisper-medium)",
    modelId: "Xenova/whisper-medium",
    description: "Précision supérieure à l'option Intermédiaire, au prix d'un temps de traitement et d'un usage mémoire plus élevés.",
  },
  french: {
    key: "french",
    label: "Français (whisper-small-cv11)",
    modelId: "onnx-community/whisper-small-cv11-french-ONNX",
    description: "Modèle spécialisé français pour une meilleure précision sur les contenus francophones.",
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
  // Target chunk duration used when building chunks in 'silence' mode (seconds)
  chunkDurationSec: 15,
  overlapSec: 1.5,
  progressiveSegmentDurationSec: 600,
  silenceThresholdDb: -35,
  minSilenceMs: 600,
  minChunkMs: 3000,
  // Max chunk size default is target + 5s (automatically recalculated when target changes)
  maxChunkMs: (15 + 5) * 1000,
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

export const useAsrStore = create<AsrConfigStore>((set): AsrConfigStore => ({
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
      autoTunePreprocess: settings.autoTunePreprocess ?? state.autoTunePreprocess,
      forceSingleThread: settings.forceSingleThread ?? state.forceSingleThread,
      enableWordTimestamps: settings.enableWordTimestamps ?? state.enableWordTimestamps,
      showSegmentConfidence: settings.showSegmentConfidence ?? state.showSegmentConfidence,
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
  setAutoTunePreprocess: (value: boolean) => set(() => ({ autoTunePreprocess: value })),
  setLastAutoTuneParams: (params) => set(() => ({ lastAutoTuneParams: params })),
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
      preprocessingStatus: "idle",
      preprocessingProgress: 0,
      segmentationStatus: "idle",
      segmentationProgress: 0,
      transcriptionConfidence: null,
      transcriptionConfidenceSource: null,
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
    // performance
    forceSingleThread: state.forceSingleThread,
    // whisper
    enableWordTimestamps: state.enableWordTimestamps,
    showSegmentConfidence: state.showSegmentConfidence,
    // debug
    debugConfidence: state.debugConfidence,
  };
  saveSettings(payload);
});
