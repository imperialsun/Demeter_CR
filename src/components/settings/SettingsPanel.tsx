import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown } from "lucide-react";

import {
  MODEL_PRESETS,
  useAsrStore,
  type BackendImplementation,
  type DedupeMode,
} from "@/store/asr-store";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { initializeBackendSupport, resetWebGpuSupportCache } from "@/lib/backend-support";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SliderField } from "@/components/ui/SliderField";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme, type Theme } from "@/components/theme-context";
import { computeDefaultOverlap } from "@/lib/chunking";
import { cn } from "@/lib/utils";
import { testWasmMultithreadSupport } from "@/lib/backend-support";
import logger from "@/lib/logger";

type BackendOption = {
  value: BackendImplementation;
  label: string;
  description: string;
  disabled?: boolean;
};

const BACKENDS: BackendOption[] = [
  {
    value: "webgpu",
    label: "WebGPU",
    description: "Accélération GPU (Chrome/Edge récent).",
  },
  {
    value: "wasm",
    label: "WASM",
    description: "Fallback CPU universel, plus lent mais compatible.",
  },
];

interface SettingsPanelProps {
  showMicroReminder?: boolean;
  showReminders?: boolean;
  showMicSettings?: boolean;
  showCloudSettings?: boolean;
  initialModelOpen?: boolean;
  initialChunkingOpen?: boolean;
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center">
      <Select value={theme} onValueChange={(v) => setTheme(v as Theme)}>
        <SelectTrigger className="w-36">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="light">Clair</SelectItem>
          <SelectItem value="system">Système</SelectItem>
          <SelectItem value="dark">Sombre</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}

export function SettingsPanel({
  showMicroReminder = true,
  showReminders = true,
  showMicSettings = true,
  showCloudSettings = true,
  initialModelOpen = false,
  initialChunkingOpen = false,
}: SettingsPanelProps) {
  const {
    activePreset,
    customModelId,
    backendPreference,
    webGpuSupported,
    wasmAvailable,
    memoryMode,
    chunkStrategy,
    segmentationMode,
    dedupeMode,
    cleanIntraChunk,
    preprocessingMode,
    showSegments,
    showExportVtt,
    showExportSrt,
    showExportJson,
    showExportTelemetry,
    progressiveSegmentDurationSec,
    denoiseNoiseFloorDb,
    denoiseReductionDb,
    denoiseSmoothing,
    denoiseCalibrationSeconds,
    preprocessEnableFilters,
    preprocessHighpassHz,
    preprocessLowpassHz,
    preprocessEnableLufs,
    preprocessTargetLufs,
    preprocessLimiterEnabled,
    preprocessLimiterThresholdDb,
    preprocessLimiterSoftness,
    preprocessVadEnabled,
    preprocessVadThresholdDb,
    preprocessVadMinSilenceMs,
    preprocessOverlapAdd,
    preprocessOverlapBlockSec,
    preprocessOverlapSec,
    autoTunePreprocess,
    setAutoTunePreprocess,
    chunkDurationSec,
    overlapSec,
    minChunkMs,
    maxChunkMs,
    minSilenceMs,
    silenceThresholdDb,
    forceSingleThread,
    wasmThreads,
    enableWordTimestamps,
    setEnableWordTimestamps,
    showSegmentConfidence,
    setShowSegmentConfidence,
    setPreset,
    setBackendPreference,
    setMemoryMode,
    setChunkStrategy,
    setSegmentationMode,
    setDedupeMode,
    setCleanIntraChunk,
    setShowSegments,
    setShowExportVtt,
    setShowExportSrt,
    setShowExportJson,
    setShowExportTelemetry,
    setPreprocessingMode,
    setDenoiseParams,
    setPreprocessParams,
    requestNoiseCalibration,
    updateChunkParameters,
    setProgressiveSegmentDurationSec,
    setForceSingleThread,
    blockedPresets,
  } = useAsrStore(
    useShallow((state) => ({
    activePreset: state.activePreset,
    customModelId: state.customModelId,
    backendPreference: state.backendPreference,
    memoryMode: state.memoryMode,
    chunkStrategy: state.chunkStrategy,
    segmentationMode: state.segmentationMode,
    dedupeMode: state.dedupeMode,
    cleanIntraChunk: state.cleanIntraChunk,
    preprocessingMode: state.preprocessingMode,
    showSegments: state.showSegments,
    showExportVtt: state.showExportVtt,
    showExportSrt: state.showExportSrt,
    showExportJson: state.showExportJson,
    showExportTelemetry: state.showExportTelemetry,
    progressiveSegmentDurationSec: state.progressiveSegmentDurationSec,
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
    setAutoTunePreprocess: state.setAutoTunePreprocess,
    chunkDurationSec: state.chunkDurationSec,
    overlapSec: state.overlapSec,
    minChunkMs: state.minChunkMs,
    maxChunkMs: state.maxChunkMs,
    minSilenceMs: state.minSilenceMs,
    silenceThresholdDb: state.silenceThresholdDb,
    webGpuSupported: state.webGpuSupported,
    wasmAvailable: state.wasmAvailable,
    setPreset: state.setPreset,
    setBackendPreference: state.setBackendPreference,
    setMemoryMode: state.setMemoryMode,
    setChunkStrategy: state.setChunkStrategy,
    setSegmentationMode: state.setSegmentationMode,
    setDedupeMode: state.setDedupeMode,
    setCleanIntraChunk: state.setCleanIntraChunk,
    setShowSegments: state.setShowSegments,
    setShowExportVtt: state.setShowExportVtt,
    setShowExportSrt: state.setShowExportSrt,
    setShowExportJson: state.setShowExportJson,
    setShowExportTelemetry: state.setShowExportTelemetry,
    setPreprocessingMode: state.setPreprocessingMode,
    setDenoiseParams: state.setDenoiseParams,
    setPreprocessParams: state.setPreprocessParams,
    requestNoiseCalibration: state.requestNoiseCalibration,
    updateChunkParameters: state.updateChunkParameters,
    setProgressiveSegmentDurationSec: state.setProgressiveSegmentDurationSec,
    // performance
    forceSingleThread: state.forceSingleThread,
    blockedPresets: state.blockedPresets,
    enableWordTimestamps: state.enableWordTimestamps,
    setEnableWordTimestamps: state.setEnableWordTimestamps,
    showSegmentConfidence: state.showSegmentConfidence,
    setShowSegmentConfidence: state.setShowSegmentConfidence,
    wasmThreads: state.wasmThreads,
    setForceSingleThread: state.setForceSingleThread,
    setWasmThreads: state.setWasmThreads,
    }))
  );

  const {
    micActivePreset,
    micCustomModelId,
    micBackendPreference,
    micPreprocessingMode,
    micSegmentationMode,
    micSilenceThresholdDb,
    micNoiseCalibrationMarginDb,
    micMinSilenceMs,
    micMinChunkMs,
    micMaxChunkMs,
    micShowExportVtt,
    micShowExportSrt,
    micShowExportJson,
    micShowExportTelemetry,
    micDenoiseNoiseFloorDb,
    micDenoiseReductionDb,
    micDenoiseSmoothing,
    micDenoiseCalibrationSeconds,
    micPreprocessEnableFilters,
    micPreprocessHighpassHz,
    micPreprocessLowpassHz,
    micPreprocessEnableLufs,
    micPreprocessTargetLufs,
    micPreprocessLimiterEnabled,
    micPreprocessLimiterThresholdDb,
    micPreprocessLimiterSoftness,
    micPreprocessVadEnabled,
    micPreprocessVadThresholdDb,
    micPreprocessVadMinSilenceMs,
    micPreprocessOverlapAdd,
    micPreprocessOverlapBlockSec,
    micPreprocessOverlapSec,
    micAutoTunePreprocess,
    micEnableWordTimestamps,
    micShowSegmentConfidence,
    micForceSingleThread,
    setMicPreset,
    setMicBackendPreference,
    setMicPreprocessingMode,
    setMicSegmentationMode,
    setMicNoiseCalibrationMarginDb,
    setMicSilenceParams,
    setMicShowExportVtt,
    setMicShowExportSrt,
    setMicShowExportJson,
    setMicShowExportTelemetry,
    setMicDenoiseParams,
    setMicPreprocessParams,
    setMicAutoTunePreprocess,
    setMicEnableWordTimestamps,
    setMicShowSegmentConfidence,
    setMicForceSingleThread,
  } = useAsrStore(
    useShallow((state) => ({
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
      setMicPreset: state.setMicPreset,
      setMicBackendPreference: state.setMicBackendPreference,
      setMicPreprocessingMode: state.setMicPreprocessingMode,
      setMicSegmentationMode: state.setMicSegmentationMode,
      setMicNoiseCalibrationMarginDb: state.setMicNoiseCalibrationMarginDb,
      setMicSilenceParams: state.setMicSilenceParams,
      setMicShowExportVtt: state.setMicShowExportVtt,
      setMicShowExportSrt: state.setMicShowExportSrt,
      setMicShowExportJson: state.setMicShowExportJson,
      setMicShowExportTelemetry: state.setMicShowExportTelemetry,
      setMicDenoiseParams: state.setMicDenoiseParams,
      setMicPreprocessParams: state.setMicPreprocessParams,
      setMicAutoTunePreprocess: state.setMicAutoTunePreprocess,
      setMicEnableWordTimestamps: state.setMicEnableWordTimestamps,
      setMicShowSegmentConfidence: state.setMicShowSegmentConfidence,
      setMicForceSingleThread: state.setMicForceSingleThread,
    }))
  );

  const backendOptions = useMemo<BackendOption[]>(() => {
    return BACKENDS.map((backend) => {
      if (backend.value === "webgpu") {
        if (webGpuSupported) return { ...backend, disabled: false };
        return {
          ...backend,
          label: "WebGPU (non disponible)",
          description: "Ce périphérique ne prend pas en charge WebGPU.",
          disabled: true,
        };
      }

      if (!wasmAvailable) {
        return {
          ...backend,
          label: "WASM (non disponible)",
          description: "Les fichiers WASM nécessaires ne sont pas accessibles sous /onnx/.",
          disabled: true,
        };
      }

      return backend;
    });
  }, [webGpuSupported, wasmAvailable]);

  const [modelOpen, setModelOpen] = useState(initialModelOpen);
  const [chunkingOpen, setChunkingOpen] = useState(initialChunkingOpen);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const [computingStats, setComputingStats] = useState(false);
  const [cacheStats, setCacheStats] = useState<{
    cacheTotals: Array<{ name: string; size: number; entries: number }>;
    cacheTotalBytes: number;
    indexedDbs: Array<{ name: string; size: number }>;
    indexedTotalBytes: number;
    localStorageBytes: number;
    sessionStorageBytes: number;
    totalBytes: number;
    lastUpdated?: string;
  } | null>(null);

  const [testingMultithread, setTestingMultithread] = useState(false);
  const telemetryCollector = useAsrStore((state) => state.telemetryCollector);
  const showMicroReminderResolved = showMicroReminder && showMicSettings;
  const showCloudSettingsResolved = showCloudSettings;

  useEffect(() => {
    if (!webGpuSupported && micBackendPreference === "webgpu") {
      setMicBackendPreference("wasm");
    }
  }, [micBackendPreference, setMicBackendPreference, webGpuSupported]);

  useEffect(() => {
    console.info("Settings panel view", { section: "settings" });
    telemetryCollector?.logEvent?.("SETTINGS_PANEL_VIEW", { section: "settings" });
  }, [telemetryCollector]);

  useEffect(() => {
    console.info("Settings mic section visibility", { visible: showMicSettings });
    telemetryCollector?.logEvent?.("SETTINGS_MIC_SECTION_VISIBILITY", { visible: showMicSettings });
  }, [showMicSettings, telemetryCollector]);

  useEffect(() => {
    console.info("Settings cloud section visibility", { visible: showCloudSettingsResolved });
    telemetryCollector?.logEvent?.("SETTINGS_CLOUD_SECTION_VISIBILITY", {
      visible: showCloudSettingsResolved,
    });
  }, [showCloudSettingsResolved, telemetryCollector]);

  // Confirm dialog handler
  const onConfirmClear = async () => {
    setConfirmClearOpen(false);
    await clearAppCache();
  };

  // Use shared overlap computation (10% with a minimum of 0.5s)
  const handleChunkDurationChange = (value: number) => {
    const defaultForCurrent = computeDefaultOverlap(chunkDurationSec);
    const defaultForNew = computeDefaultOverlap(value);
    const shouldAutoUpdate = overlapSec === defaultForCurrent;
    updateChunkParameters({
      chunkDurationSec: value,
      overlapSec: shouldAutoUpdate ? defaultForNew : overlapSec,
    });
  };

  const presetOptions = useMemo(
    () => Object.values(MODEL_PRESETS).filter((preset) => preset.key !== "french"),
    []
  );
  const blockedPresetSet = useMemo(() => new Set(blockedPresets), [blockedPresets]);

  async function clearAppCache() {
    setClearing(true);
    const telemetryCollector = useAsrStore.getState().telemetryCollector;
    const results: {
      cachesDeleted: string[];
      cachesFailed: Array<{ name: string; error: unknown }>;
      dbsDeleted: string[];
      dbsFailed: Array<{ name?: string; error: unknown }>;
    } = { cachesDeleted: [], cachesFailed: [], dbsDeleted: [], dbsFailed: [] };

    try {
      // Clear Cache Storage (delete all caches for this origin)
      if (typeof window !== "undefined" && "caches" in window) {
        try {
          const names = await caches.keys();
          for (const name of names) {
            try {
              const ok = await caches.delete(name);
              if (ok) results.cachesDeleted.push(name);
              else results.cachesFailed.push({ name, error: "delete returned false" });
            } catch (err) {
              results.cachesFailed.push({ name, error: err });
            }
          }
        } catch (err) {
          logger.warn("Failed to enumerate caches", err);
        }
      }

      // Clear IndexedDB (if supported, enumerate and delete databases)
      if (typeof indexedDB !== "undefined" && typeof ((indexedDB as unknown) as { databases?: () => Promise<unknown[]> }).databases === "function") {
        try {
          const dbs = await (((indexedDB as unknown) as { databases?: () => Promise<unknown[]> }).databases!());
          for (const info of dbs as Array<{ name?: string }>) {
            const name: string | undefined = info?.name;
            if (!name) continue;
            try {
              await new Promise<void>((resolve, reject) => {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onerror = () => reject(req.error);
                req.onblocked = () => logger.warn("deleteDatabase blocked", name);
              });
              results.dbsDeleted.push(name);
            } catch (err) {
              results.dbsFailed.push({ name, error: err });
            }
          }
        } catch (err) {
          logger.warn("Failed to enumerate indexedDB databases", err);
        }
      } else {
        // Can't enumerate DBs; attempt to delete common transformers DB names
        const candidates = ["transformers_cache", "hf_cache", "huggingface_cache"];
        for (const name of candidates) {
          try {
            await new Promise<void>((resolve, reject) => {
              const req = indexedDB.deleteDatabase(name as string);
              req.onsuccess = () => resolve();
              req.onerror = () => reject(req.error);
            });
            results.dbsDeleted.push(name);
          } catch (err) {
            void err;
          }
        }
      }

      // Clear local/session storage
      try {
        if (typeof localStorage !== "undefined") localStorage.clear();
        if (typeof sessionStorage !== "undefined") sessionStorage.clear();
      } catch (err) {
        logger.warn("Failed to clear local/session storage", err);
      }

      // Reset WebGPU detection cache and reinitialize backend support (like on startup)
      resetWebGpuSupportCache();
      initializeBackendSupport();

      // Telemetry
      if (telemetryCollector?.logEvent) telemetryCollector.logEvent("CACHE_CLEARED", {
        cachesDeleted: results.cachesDeleted.length,
        cachesFailed: results.cachesFailed.length,
        dbsDeleted: results.dbsDeleted.length,
        dbsFailed: results.dbsFailed.length,
      });

      logger.info("[cache-clear] completed", results);
      toast("Cache vidé. L'application a été réinitialisée en partie.");
    } catch (err) {
      logger.error("Failed to clear app cache", err);
      toast("Échec lors du vidage du cache. Consultez la console pour détails.");
    } finally {
      setClearing(false);
      // clear the cached stats so they are recalculated only on user action
      setCacheStats(null);
    }
  }
  // Utilities to compute cache sizes and show estimations
  function formatBytes(bytes: number) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
  }

  async function computeCacheStats() {
    setComputingStats(true);
    const telemetryCollector = useAsrStore.getState().telemetryCollector;

    // Snapshot memory before heavy work (light method still snapshots to track impact)
    if (telemetryCollector?.snapshotMemory) telemetryCollector.snapshotMemory('CACHE_STATS_START');
    logger.info("[cache-stats] start (light)");
    if (telemetryCollector?.logEvent) telemetryCollector.logEvent("CACHE_STATS_CALC_START", { mode: 'light' });

    const stats = {
      cacheTotals: [] as Array<{ name: string; size: number; entries: number }>,
      cacheTotalBytes: 0,
      indexedDbs: [] as Array<{ name: string; size: number }>,
      indexedTotalBytes: 0,
      localStorageBytes: 0,
      sessionStorageBytes: 0,
      totalBytes: 0,
      lastUpdated: new Date().toLocaleString(),
    };

    try {
      // Prefer navigator.storage.estimate() for a quick, low-cost baseline if available
        const storage = typeof navigator !== 'undefined' ? ((navigator as unknown) as { storage?: { estimate?: () => Promise<unknown> } }).storage : undefined;
        if (storage && typeof storage.estimate === 'function') {
          try {
            const estimate = await storage.estimate();
            const estimateAny = estimate as unknown as { usage?: number };
            if (typeof estimateAny.usage === 'number') {
              // we don't trust this as exact but store as a hint
              stats.localStorageBytes = stats.localStorageBytes || 0; // leave unchanged, show estimate separately in console below
              logger.info('[cache-stats] storage.estimate', estimate);
            }
          } catch (err) {
            void err;
          }
        }
      if (typeof window !== 'undefined' && 'caches' in window) {
        try {
          const names = await caches.keys();
          const DEFAULT_AVG_PER_ENTRY = 50 * 1024; // 50 KB default estimate when headers absent
          for (const name of names) {
            try {
              const c = await caches.open(name);
              const requests = await c.keys();
              const entries = requests.length;
              let sampledSizeTotal = 0;
              let sampledCount = 0;

              // sample up to N entries' headers (no body) to look for content-length
              const sampleN = Math.min(3, entries);
              for (let i = 0; i < sampleN; i++) {
                try {
                  const req = requests[i];
                  const resp = await c.match(req);
                  if (!resp) continue;
                  const cl = resp.headers.get('content-length');
                  if (cl && !Number.isNaN(Number(cl))) {
                    sampledSizeTotal += Number(cl);
                    sampledCount++;
                  }
                } catch (err) {
                  void err;
                }
              }

              let estimatedSize = 0;
              if (sampledCount > 0) {
                const avg = Math.round(sampledSizeTotal / sampledCount);
                estimatedSize = avg * entries;
              } else {
                estimatedSize = DEFAULT_AVG_PER_ENTRY * entries;
              }

              stats.cacheTotals.push({ name, size: estimatedSize, entries });
              stats.cacheTotalBytes += estimatedSize;
            } catch (err) {
              logger.warn('failed to inspect cache (light)', name, err);
            }
          }
        } catch (err) {
          logger.warn('failed to enumerate caches (light)', err);
        }
      }

      // IndexedDB (light): count entries per store and sample a few values per store to estimate average size
      if (typeof indexedDB !== 'undefined') {
        try {
          const dbCandidates: string[] = [];
          if (typeof (((indexedDB as unknown) as { databases?: () => Promise<unknown[]> }).databases) === 'function') {
            try {
              const dbs = await (((indexedDB as unknown) as { databases?: () => Promise<unknown[]> }).databases!());
              for (const info of dbs as unknown as Array<{ name?: string }>) {
                if (info?.name) dbCandidates.push(info.name as string);
              }
            } catch (err) {
              void err;
            }
          }

          // fallback candidate names
          const fallback = ['transformers_cache', 'hf_cache', 'huggingface_cache'];
          for (const f of fallback) if (!dbCandidates.includes(f)) dbCandidates.push(f);

          for (const name of dbCandidates) {
            try {
              const openReq = indexedDB.open(name as string);
              const db = await new Promise<IDBDatabase>((resolve, reject) => {
                openReq.onsuccess = () => resolve(openReq.result);
                openReq.onerror = () => reject(openReq.error);
                openReq.onblocked = () => logger.warn('opening indexeddb blocked', name);
              });

              let dbSize = 0;

              for (let i = 0; i < db.objectStoreNames.length; i++) {
                const storeName = db.objectStoreNames[i];
                try {
                  const tx = db.transaction(storeName, 'readonly');
                  const store = tx.objectStore(storeName);

                  const count = await new Promise<number>((resolve, reject) => {
                    const r = store.count();
                    r.onsuccess = () => resolve(r.result as number);
                    r.onerror = () => reject(r.error);
                  });

                  if (count === 0) continue;

                  // sample up to N entries using cursor (small, bounded memory use)
                  const sampleN = Math.min(3, count);
                  let sampled = 0;
                  let sampledTotalBytes = 0;

                  await new Promise<void>((resolve) => {
                    const cursorReq = store.openCursor();
                    cursorReq.onsuccess = (ev) => {
                      const cursor = (ev.target as IDBRequest).result;
                      if (cursor && sampled < sampleN) {
                        try {
                          const str = JSON.stringify(cursor.value);
                          sampledTotalBytes += new TextEncoder().encode(str).length;
                        } catch (err) {
                          void err;
                        }
                        sampled++;
                        cursor.continue();
                      } else {
                        resolve();
                      }
                    };
                    cursorReq.onerror = () => resolve();
                  });

                  const avg = sampled > 0 ? Math.round(sampledTotalBytes / sampled) : 1024; // 1KB default
                  dbSize += avg * count;
                } catch (err) {
                  logger.warn('failed to inspect store (light)', name, storeName, err);
                }
              }

              if (dbSize > 0) {
                stats.indexedDbs.push({ name, size: dbSize });
                stats.indexedTotalBytes += dbSize;
              }

              try { db.close(); } catch (err) { void err; }
            } catch (err) {
              void err;
            }
          }
        } catch (err) {
          logger.warn('failed to estimate indexeddb sizes (light)', err);
        }
      }

      // local/session storage
      try {
        if (typeof localStorage !== 'undefined') {
          let s = 0;
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key) continue;
            const v = localStorage.getItem(key) ?? '';
            s += new TextEncoder().encode(key + v).length;
          }
          stats.localStorageBytes = s;
        }
      } catch (err) {
        logger.warn('failed to inspect localStorage', err);
      }

      try {
        if (typeof sessionStorage !== 'undefined') {
          let s = 0;
          for (let i = 0; i < sessionStorage.length; i++) {
            const key = sessionStorage.key(i);
            if (!key) continue;
            const v = sessionStorage.getItem(key) ?? '';
            s += new TextEncoder().encode(key + v).length;
          }
          stats.sessionStorageBytes = s;
        }
      } catch (err) {
        logger.warn('failed to inspect sessionStorage', err);
      }

      stats.totalBytes = stats.cacheTotalBytes + stats.indexedTotalBytes + stats.localStorageBytes + stats.sessionStorageBytes;
      // Snapshot memory after calculation
      if (telemetryCollector?.snapshotMemory) telemetryCollector.snapshotMemory('CACHE_STATS_END');
      logger.info('[cache-stats] done', stats);
      if (telemetryCollector?.logEvent) telemetryCollector.logEvent('CACHE_STATS_CALC_DONE', {
        cacheTotalBytes: stats.cacheTotalBytes,
        indexedTotalBytes: stats.indexedTotalBytes,
        localStorageBytes: stats.localStorageBytes,
        sessionStorageBytes: stats.sessionStorageBytes,
        totalBytes: stats.totalBytes,
        cachesCount: stats.cacheTotals.length,
        indexedDbCount: stats.indexedDbs.length,
        mode: 'light',
      });
      setCacheStats(stats);
    } catch (err) {
      logger.error('computeCacheStats failed', err);
      if (telemetryCollector?.snapshotMemory) telemetryCollector.snapshotMemory('CACHE_STATS_ERROR');
      if (telemetryCollector?.logEvent) telemetryCollector.logEvent('CACHE_STATS_CALC_ERROR', { message: String(err) });
    } finally {
      setComputingStats(false);
    }
  }

  const reminders = [
    {
      title: "Transcription locale",
      description: "Importez un fichier audio. Tout est traité localement sur ce poste, rien n'est envoyé dans le cloud.",
    },
    ...(showMicroReminderResolved
      ? [
          {
            title: "Micro",
            description:
              "Armez le micro et enclenchez Start. Les chunks sont découpés toutes les 15 s avec 3 s d'overlap.",
          },
        ]
      : []),
    {
      title: "Export",
      description: "VTT, SRT, JSON segments et telemetry.json disponibles dans l'onglet Télémetrie.",
    },
  ];
  const isCustom = activePreset === "custom";
  const backendTriggerTone = backendPreference === "webgpu"
    ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-500/90 focus:ring-emerald-500/40"
    : "border-amber-400 bg-amber-400 text-amber-950 hover:bg-amber-400/90 focus:ring-amber-400/40";
  const backendItemTone = (value: BackendImplementation) =>
    value === "webgpu"
      ? "data-[state=checked]:bg-emerald-500 data-[state=checked]:text-white"
      : "data-[state=checked]:bg-amber-400 data-[state=checked]:text-amber-950";
  const isMicCustom = micActivePreset === "custom";
  const micBackendTriggerTone = micBackendPreference === "webgpu"
    ? "border-emerald-500 bg-emerald-500 text-white hover:bg-emerald-500/90 focus:ring-emerald-500/40"
    : "border-amber-400 bg-amber-400 text-amber-950 hover:bg-amber-400/90 focus:ring-amber-400/40";
  const micBackendItemTone = (value: BackendImplementation) =>
    value === "webgpu"
      ? "data-[state=checked]:bg-emerald-500 data-[state=checked]:text-white"
      : "data-[state=checked]:bg-amber-400 data-[state=checked]:text-amber-950";

  type PresetKey = Parameters<typeof setPreset>[0];
  type MicPresetKey = Parameters<typeof setMicPreset>[0];
  type ChunkStrategyValue = Parameters<typeof setChunkStrategy>[0];

  return (
    <Tabs defaultValue="local" className="space-y-6">
      <TabsList>
        <TabsTrigger value="local">Local</TabsTrigger>
        {showMicSettings ? <TabsTrigger value="mic">Enregistrement</TabsTrigger> : null}
        {showCloudSettingsResolved ? <TabsTrigger value="cloud">Cloud</TabsTrigger> : null}
      </TabsList>
      <TabsContent value="local">
        <div className="grid gap-4 lg:grid-cols-2">
      {showReminders ? (
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Rappels d&apos;utilisation</CardTitle>
            <CardDescription>
              Sélectionnez un mode d&apos;import dans la sidebar puis lancez la transcription en un clic.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 md:grid-cols-3">
            {reminders.map((reminder) => (
              <Reminder key={reminder.title} title={reminder.title} description={reminder.description} />
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Modèle Whisper</CardTitle>
              <CardDescription>
                Choisissez le preset adapté à votre cas d&apos;usage ou renseignez un modèle custom.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setModelOpen((open) => !open)}
            >
              {modelOpen ? "Masquer" : "Afficher"}
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", modelOpen ? "rotate-180" : "")}
              />
            </Button>
          </div>
        </CardHeader>
        {modelOpen ? (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Preset</Label>
              <Select value={activePreset} onValueChange={(value) => setPreset(value as PresetKey)}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionnez un preset" />
                </SelectTrigger>
                <SelectContent>
                {presetOptions.map((preset) => {
                  const isBlocked = blockedPresetSet.has(preset.key);
                  return (
                    <SelectItem key={preset.key} value={preset.key} disabled={isBlocked}>
                      <div className="flex flex-col">
                        <span className="font-medium">{preset.label}</span>
                        <span className="text-xs text-muted-foreground">{preset.description}</span>
                        {isBlocked ? (
                          <span className="text-xs text-destructive">Trop lourd pour ce poste (test)</span>
                        ) : null}
                      </div>
                    </SelectItem>
                  );
                })}
                  <SelectItem value="custom">
                    <div className="flex flex-col">
                      <span className="font-medium">Custom</span>
                      <span className="text-xs text-muted-foreground">Renseignez un repo Hugging Face compatible.</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            {isCustom ? (
              <div className="space-y-2">
                <Label htmlFor="custom-model">ModelId Hugging Face</Label>
                <Input
                  id="custom-model"
                  placeholder="ex: MonOrganisation/whisper-finetune"
                  value={customModelId}
                  onChange={(event) => setPreset("custom" as PresetKey, event.target.value)}
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <Label>Backend</Label>
              <Select
                value={backendPreference}
                onValueChange={(value) => setBackendPreference(value as BackendImplementation)}
              >
                <SelectTrigger className={cn("capitalize", backendTriggerTone)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {backendOptions.map((backend) => (
                    <SelectItem
                      key={backend.value}
                      value={backend.value}
                      disabled={backend.disabled}
                      className={cn("capitalize", backendItemTone(backend.value))}
                    >
                      <div className="flex flex-col">
                          <span className="font-medium">{backend.label}</span>
                          <span className={cn("text-xs", backend.value === "wasm" ? "text-black" : "text-muted-foreground")}>{backend.description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!webGpuSupported ? (
                <p className="text-xs text-muted-foreground">
                  WebGPU n&apos;est pas disponible sur ce périphérique. Le mode WASM est appliqué automatiquement.
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Timestamps par mot</p>
                <p className="text-xs text-muted-foreground">Activer les timestamps au niveau des mots (coûteux en CPU/mémoire).</p>
              </div>
              <Switch
                className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                checked={enableWordTimestamps}
                onCheckedChange={(checked) => setEnableWordTimestamps(checked ? true : false)}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Afficher l'indice de confiance</p>
                <p className="text-xs text-muted-foreground">Afficher l'indice de confiance calculé pour chaque segment.</p>
              </div>
              <Switch
                aria-label="Afficher l'indice de confiance"
                className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                checked={showSegmentConfidence}
                onCheckedChange={(checked) => {
                  setShowSegmentConfidence(checked ? true : false);
                  setEnableWordTimestamps(checked ? true : false);
                }}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Mode progressif</p>
                <p className="text-xs text-muted-foreground">
                  Décode par segments via capture audio pour limiter la mémoire (Chrome uniquement).
                </p>
              </div>
              <Switch
                className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                checked={memoryMode === "progressive"}
                onCheckedChange={(checked) => setMemoryMode(checked ? "progressive" : "full")}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Taille du segment progressif</p>
                <p className="text-xs text-muted-foreground">
                  Détermine la durée d'un segment traité en mémoire (par défaut : 10 minutes).
                </p>
              </div>
              <Select
                value={String(progressiveSegmentDurationSec)}
                onValueChange={(value) => setProgressiveSegmentDurationSec(Number(value))}
                disabled={memoryMode !== "progressive"}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="300">5 minutes</SelectItem>
                  <SelectItem value="600">10 minutes</SelectItem>
                  <SelectItem value="900">15 minutes</SelectItem>
                  <SelectItem value="1200">20 minutes</SelectItem>
                  <SelectItem value="1800">30 minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>


          </CardContent>
        ) : null}
      </Card>




      <Card>
        <CardHeader className="space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Chunking & segmentation</CardTitle>
              <CardDescription>
                Contrôlez la découpe audio et les paramètres silence pour optimiser la précision et la vitesse.
              </CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => setChunkingOpen((open) => !open)}
            >
              {chunkingOpen ? "Masquer" : "Afficher"}
              <ChevronDown
                className={cn("h-4 w-4 transition-transform", chunkingOpen ? "rotate-180" : "")}
              />
            </Button>
          </div>
        </CardHeader>
        {chunkingOpen ? (
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Stratégie de chunking</Label>
              <Select value={chunkStrategy} onValueChange={(value) => setChunkStrategy(value as ChunkStrategyValue)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sequential">Séquentiel</SelectItem>
                  <SelectItem value="overlap">Overlap + dédoublonnage</SelectItem>
                  <SelectItem value="silence">Détection de silences (énergie)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium">Segmentation fichier</p>
                <p className="text-xs text-muted-foreground">
                  On : segments basés sur les silences. Off : un segment par chunk.
                </p>
              </div>
              <Switch
                className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                checked={segmentationMode === "silence"}
                onCheckedChange={(checked) => setSegmentationMode(checked ? "silence" : "chunks")}
              />
            </div>

            {chunkStrategy === "sequential" ? (
              <div className="space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">Séquentiel : découpe fixe sans overlap.</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <NumberField
                    id="chunk-duration"
                    label="Durée chunk (s)"
                    value={chunkDurationSec}
                    min={5}
                    max={120}
                    step={5}
                    onChange={handleChunkDurationChange}
                  />
                </div>
              </div>
            ) : null}

            {chunkStrategy === "overlap" ? (
              <div className="space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">Overlap : fenêtres fixes avec chevauchement.</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <NumberField
                    id="chunk-duration"
                    label="Durée chunk (s)"
                    value={chunkDurationSec}
                    min={5}
                    max={120}
                    step={5}
                    onChange={handleChunkDurationChange}
                  />
                  <NumberField
                    id="overlap"
                    label="Overlap (s)"
                    value={overlapSec}
                    min={0}
                    max={30}
                    step={1}
                    onChange={(value) => updateChunkParameters({ overlapSec: value })}
                  />
                </div>
              </div>
            ) : null}

            {chunkStrategy === "silence" ? (
              <div className="space-y-3 pt-2">
                <p className="text-xs text-muted-foreground">Silence : découpe adaptative guidée par les pauses.</p>
                <div className="grid gap-3 md:grid-cols-2">
                  <NumberField
                    id="chunk-duration"
                    label="Durée cible (s)"
                    value={chunkDurationSec}
                    min={5}
                    max={120}
                    step={5}
                    onChange={handleChunkDurationChange}
                  />
                  <NumberField
                    id="overlap"
                    label="Overlap (s)"
                    value={overlapSec}
                    min={0}
                    max={30}
                    step={1}
                    onChange={(value) => updateChunkParameters({ overlapSec: value })}
                  />
                  <NumberField
                    id="silence-threshold"
                    label="Seuil silence (dB)"
                    value={silenceThresholdDb}
                    min={-80}
                    max={-5}
                    step={1}
                    onChange={(value) => updateChunkParameters({ silenceThresholdDb: value })}
                  />
                  <NumberField
                    id="min-silence"
                    label="Silence min (ms)"
                    value={minSilenceMs}
                    min={200}
                    max={5000}
                    step={100}
                    onChange={(value) => updateChunkParameters({ minSilenceMs: value })}
                  />
                  <NumberField
                    id="min-chunk"
                    label="Chunk min (ms)"
                    value={minChunkMs}
                    min={500}
                    max={30000}
                    step={100}
                    onChange={(value) => updateChunkParameters({ minChunkMs: value })}
                  />
                  <NumberField
                    id="max-chunk"
                    label="Chunk max (ms)"
                    value={maxChunkMs}
                    min={5000}
                    max={120000}
                    step={1000}
                    onChange={(value) => updateChunkParameters({ maxChunkMs: value })}
                  />
                </div>
              </div>
            ) : null}
          </CardContent>
        ) : null}
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="space-y-0">
          <div>
            <CardTitle>Doublonnage</CardTitle>
            <CardDescription>
              Choisissez la méthode de dédoublonnage des segments quand des overlaps sont utilisés.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Méthode</p>
              <p className="text-xs text-muted-foreground">
                Normal : exact sur tokens normalisés. Fuzzy : tolère des variations (utile si le modèle hésite).
              </p>
            </div>
            <Select value={dedupeMode} onValueChange={(value) => setDedupeMode(value as DedupeMode)}>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Normal (exact)</SelectItem>
                <SelectItem value="fuzzy">Fuzzy (tolérant)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Nettoyage intra-chunk</p>
              <p className="text-xs text-muted-foreground">
                Supprime les répétitions dans un même segment (ex: &quot;politique. politique&quot;).
              </p>
            </div>
            <Switch
              aria-label="Nettoyage intra-chunk"
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={cleanIntraChunk}
              onCheckedChange={(checked) => setCleanIntraChunk(checked ? true : false)}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="space-y-0">
          <div>
            <CardTitle>Apparence</CardTitle>
            <CardDescription>
              Réglages d'apparence de l'application (thème, couleurs, etc.). C'est ici que vous pourrez configurer l'apparence à l'avenir.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Thème</p>
              <p className="text-xs text-muted-foreground">Choisissez le thème de l'application. "Système" suit les préférences de votre système d'exploitation.</p>
            </div>
            <ThemeToggle />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Performance</CardTitle>
            <CardDescription>
              Réglages relatifs aux performances et au multithreading WASM.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Forcer single-thread</p>
              <p className="text-xs text-muted-foreground">Désactive le multithreading WASM. Multithread requiert isolation cross-origin (COOP/COEP) ; l'application basculera automatiquement en single-thread en cas d'échec.</p>
            </div>
            <div className="flex items-center gap-3">
              <Switch
                className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                checked={forceSingleThread}
                aria-label="Forcer single-thread"
                onCheckedChange={(v) => {
                  setForceSingleThread(v);
                  try {
                    const telemetry = useAsrStore.getState().telemetryCollector;
                    if (telemetry?.logEvent) telemetry.logEvent("WASM_MULTITHREAD_TEST", { action: v ? 'force_single' : 'allow_multithread' });
                  } catch (err) { void err; }
                  if (v) {
                    toast('Forcé en single-thread');
                  } else {
                    toast('Autorisé multithread (sera utilisé si la plateforme le permet)');
                  }
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (testingMultithread) return;
                  setTestingMultithread(true);
                  try {
                    const res = await testWasmMultithreadSupport(1500);
                    const telemetry = useAsrStore.getState().telemetryCollector;
                    if (telemetry?.logEvent) telemetry.logEvent("WASM_MULTITHREAD_TEST", { ok: res.ok, reason: res.reason });
                    if (res.ok) {
                      // enable multithread
                      useAsrStore.getState().setForceSingleThread(false);
                      const threads = Math.max(2, (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2));
                      useAsrStore.getState().setWasmThreads(threads);
                      toast(`mode multithread actif (${threads} threads)`);
                    } else {
                      // fallback to single thread
                      useAsrStore.getState().setForceSingleThread(true);
                      useAsrStore.getState().setWasmThreads(1);
                      useAsrStore.getState().telemetryCollector?.recordAlert('WASM_MULTITHREAD_UNAVAILABLE', { reason: res.reason });
                      toast('mode multithread indisponible sur cette plateforme');
                    }
                  } catch (err) {
                    useAsrStore.getState().setForceSingleThread(true);
                    useAsrStore.getState().setWasmThreads(1);
                    useAsrStore.getState().telemetryCollector?.recordAlert('WASM_MULTITHREAD_UNAVAILABLE', { reason: String(err) });
                    toast('mode multithread indisponible sur cette plateforme');
                  } finally {
                    setTestingMultithread(false);
                  }
                }}
                disabled={testingMultithread}
              >{testingMultithread ? 'Test...' : 'Tester'}</Button>
            </div>
          </div>
          <div>
            <p className="text-sm font-medium">État effectif des threads</p>
            <p className="text-xs text-muted-foreground">{wasmThreads === null ? "Inconnu" : wasmThreads === 1 ? "Single-thread" : `Multi-thread (${wasmThreads} threads)`}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader className="space-y-0">
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Gestion du cache</CardTitle>
              <CardDescription>
                Outils pour supprimer complètement les caches et forcer le rechargement des modèles et ressources.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="rounded-md border bg-muted/40 p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">Vider le cache</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Videz complètement le cache de l'application (Cache Storage, IndexedDB, localStorage). Utile pour réinitialiser les déploiements ou forcer un nouveau téléchargement des modèles.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="destructive" size="sm" onClick={() => setConfirmClearOpen(true)} disabled={clearing}>
                  {clearing ? "Vider..." : "Vider le cache"}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => {
                  // show quick help
                  toast("Cette opération supprime les caches (Cache Storage, IndexedDB) et les paramètres locaux.");
                }}>Aide</Button>
              </div>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <div className="space-y-2 md:col-span-2">
                <p className="text-xs text-muted-foreground">Occupation actuelle des caches :</p>
                <div className="mt-2 space-y-2">
                  {/* Summary */}
                  <div className="flex items-center justify-between">
                    <span className="text-sm">Cache Storage</span>
                    <span className="text-xs text-muted-foreground">{cacheStats ? formatBytes(cacheStats.cacheTotalBytes) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">IndexedDB</span>
                    <span className="text-xs text-muted-foreground">{cacheStats ? formatBytes(cacheStats.indexedTotalBytes) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">localStorage</span>
                    <span className="text-xs text-muted-foreground">{cacheStats ? formatBytes(cacheStats.localStorageBytes) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm">sessionStorage</span>
                    <span className="text-xs text-muted-foreground">{cacheStats ? formatBytes(cacheStats.sessionStorageBytes) : "—"}</span>
                  </div>
                  <div className="flex items-center justify-between border-t pt-2">
                    <span className="text-sm font-medium">Total estimé</span>
                    <span className="text-xs text-muted-foreground font-medium">{cacheStats ? formatBytes(cacheStats.totalBytes) : "—"}</span>
                  </div>

                  {cacheStats && cacheStats.cacheTotals.length > 0 ? (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">Détails Cache Storage:</p>
                      <ul className="mt-1 space-y-1">
                        {cacheStats.cacheTotals.map((c) => (
                          <li key={c.name} className="flex items-center justify-between text-xs">
                            <span>{c.name}</span>
                            <span className="text-muted-foreground">{formatBytes(c.size)} ({c.entries} entrées)</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {cacheStats && cacheStats.indexedDbs.length > 0 ? (
                    <div className="mt-2">
                      <p className="text-xs text-muted-foreground">Bases IndexedDB (estimation):</p>
                      <ul className="mt-1 space-y-1">
                        {cacheStats.indexedDbs.map((db) => (
                          <li key={db.name} className="flex items-center justify-between text-xs">
                            <span>{db.name}</span>
                            <span className="text-muted-foreground">{formatBytes(db.size)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {cacheStats?.lastUpdated ? (
                    <div className="mt-2 text-xs text-muted-foreground">Dernière mise à jour : {cacheStats.lastUpdated}</div>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-col gap-2 md:col-span-1">
                <Button variant="secondary" size="sm" onClick={() => computeCacheStats()} disabled={computingStats}>
                  {computingStats ? "Calcul en cours…" : "Rafraîchir"}
                </Button>
              </div>
            </div>
          </div>

          <ConfirmDialog
            open={confirmClearOpen}
            title="Vider le cache de l'application"
            description="Êtes-vous sûr ? Cette action supprimera Cache Storage, IndexedDB et storage locaux."
            onCancel={() => setConfirmClearOpen(false)}
            onConfirm={onConfirmClear}
          />
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Pré-traitement</CardTitle>
            <CardDescription>
              Choisissez le mode de pré-traitement appliqué avant la transcription. Le mode "Complet" est le comportement par défaut.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Mode de pré-traitement</p>
              <p className="text-xs text-muted-foreground">Sélectionnez "Rapide" pour un prétraitement léger chunk par chunk, ou "Complet" pour effectuer un décodage et un prétraitement complet avant la transcription (par défaut : Complet).</p>
            </div>
            <Select value={preprocessingMode} onValueChange={(v) => setPreprocessingMode(v as "quick" | "full") }>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">Rapide</SelectItem>
                <SelectItem value="full">Complet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {preprocessingMode === "full" ? (
            <div className="mt-4 space-y-4 rounded-md border bg-muted/30 px-3 py-3">
              <p className="text-xs text-muted-foreground">
                Le mode complet applique un filtrage passe-haut/passe-bas, compression douce, normalisation loudness, puis débruitage spectral (FFT 1024 / hop 256).
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                <SliderField
                  id="noise-floor"
                  label="Noise floor (dB)"
                  min={-50}
                  max={-5}
                  step={1}
                  value={denoiseNoiseFloorDb}
                  onChange={(value) => setDenoiseParams({ denoiseNoiseFloorDb: value })}
                  help="Décalage du seuil par rapport au profil de bruit. Valeur plus basse = gating plus prudent."
                  disabled={useAsrStore.getState().autoTunePreprocess}
                />
                <SliderField
                  id="reduction-db"
                  label="Réduction (dB)"
                  min={0}
                  max={24}
                  step={1}
                  value={denoiseReductionDb}
                  onChange={(value) => setDenoiseParams({ denoiseReductionDb: value })}
                  help="Atténuation max dans les bandes bruyantes (soft-knee)."
                  disabled={useAsrStore.getState().autoTunePreprocess}
                />
                <SliderField
                  id="smoothing"
                  label="Lissage"
                  min={0}
                  max={0.99}
                  step={0.01}
                  value={denoiseSmoothing}
                  onChange={(value) => setDenoiseParams({ denoiseSmoothing: value })}
                  help="0 = réactif, 0.8 par défaut = transitions douces."
                  disabled={useAsrStore.getState().autoTunePreprocess}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Filtres passe-haut / passe-bas</p>
                    <p className="text-xs text-muted-foreground">Élimine les basses fréquences (rumble) et les aigus inutiles.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={preprocessEnableFilters}
                    onCheckedChange={(value) => setPreprocessParams({ preprocessEnableFilters: value })}
                    disabled={autoTunePreprocess}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Normalisation loudness (LUFS)</p>
                    <p className="text-xs text-muted-foreground">Stabilise la loudness perçue pour la transcription.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={preprocessEnableLufs}
                    onCheckedChange={(value) => setPreprocessParams({ preprocessEnableLufs: value })}
                    disabled={autoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="pre-highpass"
                  label="Passe-haut (Hz)"
                  min={40}
                  max={200}
                  step={5}
                  value={preprocessHighpassHz}
                  onChange={(value) => setPreprocessParams({ preprocessHighpassHz: value })}
                  help="Coupe les basses fréquences (80 Hz par défaut)."
                  disabled={!preprocessEnableFilters || autoTunePreprocess}
                />
                <SliderField
                  id="pre-lowpass"
                  label="Passe-bas (Hz)"
                  min={4000}
                  max={12000}
                  step={250}
                  value={preprocessLowpassHz}
                  onChange={(value) => setPreprocessParams({ preprocessLowpassHz: value })}
                  help="Coupe les aigus trop agressifs (8 kHz par défaut)."
                  disabled={!preprocessEnableFilters || autoTunePreprocess}
                />
                <SliderField
                  id="pre-lufs-target"
                  label="Cible loudness (LUFS)"
                  min={-30}
                  max={-14}
                  step={0.5}
                  value={preprocessTargetLufs}
                  onChange={(value) => setPreprocessParams({ preprocessTargetLufs: value })}
                  help="Cible loudness moyenne (ex: -20 LUFS)."
                  disabled={!preprocessEnableLufs || autoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Limiteur doux</p>
                    <p className="text-xs text-muted-foreground">Évite les saturations après normalisation.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={preprocessLimiterEnabled}
                    onCheckedChange={(value) => setPreprocessParams({ preprocessLimiterEnabled: value })}
                    disabled={autoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="pre-limiter-threshold"
                  label="Seuil limiteur (dBFS)"
                  min={-6}
                  max={-0.1}
                  step={0.1}
                  value={preprocessLimiterThresholdDb}
                  onChange={(value) => setPreprocessParams({ preprocessLimiterThresholdDb: value })}
                  help="Seuil de limitation (par défaut -1 dBFS)."
                  disabled={!preprocessLimiterEnabled || autoTunePreprocess}
                />
                <SliderField
                  id="pre-limiter-softness"
                  label="Douceur limiteur"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={preprocessLimiterSoftness}
                  onChange={(value) => setPreprocessParams({ preprocessLimiterSoftness: value })}
                  help="Plus élevé = limitation plus douce."
                  disabled={!preprocessLimiterEnabled || autoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Calibration VAD (silence)</p>
                    <p className="text-xs text-muted-foreground">Calcule le profil de bruit sur des zones non parlées.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={preprocessVadEnabled}
                    onCheckedChange={(value) => setPreprocessParams({ preprocessVadEnabled: value })}
                    disabled={autoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="pre-vad-threshold"
                  label="Seuil VAD (dB)"
                  min={-60}
                  max={-30}
                  step={1}
                  value={preprocessVadThresholdDb}
                  onChange={(value) => setPreprocessParams({ preprocessVadThresholdDb: value })}
                  help="Seuil d'énergie pour détecter la parole."
                  disabled={!preprocessVadEnabled || autoTunePreprocess}
                />
                <SliderField
                  id="pre-vad-min-silence"
                  label="Silence min (ms)"
                  min={50}
                  max={1000}
                  step={50}
                  value={preprocessVadMinSilenceMs}
                  onChange={(value) => setPreprocessParams({ preprocessVadMinSilenceMs: value })}
                  help="Durée minimale d'un silence pour la calibration."
                  disabled={!preprocessVadEnabled || autoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Lissage overlap-add</p>
                    <p className="text-xs text-muted-foreground">Réduit les artefacts aux frontières.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={preprocessOverlapAdd}
                    onCheckedChange={(value) => setPreprocessParams({ preprocessOverlapAdd: value })}
                    disabled={autoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="pre-overlap-block"
                  label="Fenêtre overlap (s)"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={preprocessOverlapBlockSec}
                  onChange={(value) => setPreprocessParams({ preprocessOverlapBlockSec: value })}
                  help="Durée de fenêtre pour le lissage."
                  disabled={!preprocessOverlapAdd || autoTunePreprocess}
                />
                <SliderField
                  id="pre-overlap-sec"
                  label="Recouvrement (s)"
                  min={0.05}
                  max={0.8}
                  step={0.05}
                  value={preprocessOverlapSec}
                  onChange={(value) => setPreprocessParams({ preprocessOverlapSec: value })}
                  help="Recouvrement entre fenêtres."
                  disabled={!preprocessOverlapAdd || autoTunePreprocess}
                />
              </div>

              <div className="mt-3">
                <SliderField
                  id="calibration-seconds"
                  label="Durée calibration (s)"
                  min={0.25}
                  max={5}
                  step={0.25}
                  value={denoiseCalibrationSeconds}
                  onChange={(value) => setDenoiseParams({ denoiseCalibrationSeconds: value })}
                  help="Durée (en secondes) utilisée pour estimer le profil de bruit pendant la calibration."
                />
                <div className="mt-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Autotune prétraitement</p>
                    <p className="text-xs text-muted-foreground">Autoriser l'ajustement automatique des paramètres de gating, filtres, loudness et overlap pour une lecture optimisée pour Whisper.</p>
                  </div>
                  <div>
                    <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={autoTunePreprocess} onCheckedChange={(v) => setAutoTunePreprocess(v)} />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Calibrer le bruit</p>
                  <p className="text-xs text-muted-foreground">
                    Capture ~{denoiseCalibrationSeconds.toFixed(1)} s de bruit pour affiner le profil avant gating.
                  </p>
                </div>
                <Button size="sm" variant="secondary" onClick={() => requestNoiseCalibration()}>
                  Calibrer bruit ({denoiseCalibrationSeconds.toFixed(1)} s)
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Segments</CardTitle>
            <CardDescription>
              Choisissez si le tableau des segments s'affiche sur la page Transcription locale. Cette option est
              désactivée par défaut pour alléger l&apos;interface.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Afficher le tableau des segments</p>
              <p className="text-xs text-muted-foreground">
                Les segments sont masqués sur /localupload lorsque l&apos;option est désactivée.
              </p>
            </div>
            <Switch
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={showSegments}
              onCheckedChange={(checked) => setShowSegments(checked)}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Exports</CardTitle>
            <CardDescription>
              Contrôlez quels boutons d'export apparaissent sur la page Transcription locale.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">VTT</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d'export VTT sur /localupload.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={showExportVtt} onCheckedChange={(v) => setShowExportVtt(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">SRT</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d'export SRT sur /localupload.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={showExportSrt} onCheckedChange={(v) => setShowExportSrt(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">JSON segments</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d'export JSON (segments).</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={showExportJson} onCheckedChange={(v) => setShowExportJson(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Telemetry</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d'export telemetry.json.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={showExportTelemetry} onCheckedChange={(v) => setShowExportTelemetry(v)} />
          </div>
        </CardContent>
      </Card>
    </div>
      </TabsContent>
      {showMicSettings ? (
        <TabsContent value="mic">
          <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Modèle Whisper (micro)</CardTitle>
          <CardDescription>
            Choisissez le preset et le backend utilisés pour l&apos;enregistrement.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Preset</Label>
            <Select value={micActivePreset} onValueChange={(value) => setMicPreset(value as MicPresetKey)}>
              <SelectTrigger>
                <SelectValue placeholder="Sélectionnez un preset" />
              </SelectTrigger>
              <SelectContent>
                {presetOptions.map((preset) => {
                  const isBlocked = blockedPresetSet.has(preset.key);
                  return (
                    <SelectItem key={preset.key} value={preset.key} disabled={isBlocked}>
                      <div className="flex flex-col">
                        <span className="font-medium">{preset.label}</span>
                        <span className="text-xs text-muted-foreground">{preset.description}</span>
                        {isBlocked ? (
                          <span className="text-xs text-destructive">Trop lourd pour ce poste (test)</span>
                        ) : null}
                      </div>
                    </SelectItem>
                  );
                })}
                <SelectItem value="custom">
                  <div className="flex flex-col">
                    <span className="font-medium">Custom</span>
                    <span className="text-xs text-muted-foreground">Renseignez un repo Hugging Face compatible.</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {isMicCustom ? (
            <div className="space-y-2">
              <Label htmlFor="mic-custom-model">ModelId Hugging Face</Label>
              <Input
                id="mic-custom-model"
                placeholder="ex: MonOrganisation/whisper-finetune"
                value={micCustomModelId}
                onChange={(event) => setMicPreset("custom" as MicPresetKey, event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <Label>Backend</Label>
            <Select
              value={micBackendPreference}
              onValueChange={(value) => setMicBackendPreference(value as BackendImplementation)}
            >
              <SelectTrigger className={cn("capitalize", micBackendTriggerTone)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {backendOptions.map((backend) => (
                  <SelectItem
                    key={backend.value}
                    value={backend.value}
                    disabled={backend.disabled}
                    className={cn("capitalize", micBackendItemTone(backend.value))}
                  >
                    <div className="flex flex-col">
                      <span className="font-medium">{backend.label}</span>
                      <span className={cn("text-xs", backend.value === "wasm" ? "text-black" : "text-muted-foreground")}>{backend.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!webGpuSupported ? (
              <p className="text-xs text-muted-foreground">
                WebGPU n&apos;est pas disponible sur ce périphérique. Le mode WASM est appliqué automatiquement.
              </p>
            ) : null}
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Timestamps par mot</p>
              <p className="text-xs text-muted-foreground">Activer les timestamps au niveau des mots (coûteux en CPU/mémoire).</p>
            </div>
            <Switch
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={micEnableWordTimestamps}
              onCheckedChange={(checked) => setMicEnableWordTimestamps(checked ? true : false)}
            />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Afficher l&apos;indice de confiance</p>
              <p className="text-xs text-muted-foreground">Afficher l&apos;indice de confiance calculé pour chaque segment.</p>
            </div>
            <Switch
              aria-label="Afficher l'indice de confiance (micro)"
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={micShowSegmentConfidence}
              onCheckedChange={(checked) => {
                setMicShowSegmentConfidence(checked ? true : false);
                setMicEnableWordTimestamps(checked ? true : false);
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Segmentation micro</CardTitle>
          <CardDescription>
            Paramètres de découpe basés sur les silences.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Micro segment</p>
              <p className="text-xs text-muted-foreground">
                On : coupe aux silences. Off : un segment par chunk.
              </p>
            </div>
            <Switch
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={micSegmentationMode === "silence"}
              onCheckedChange={(checked) => setMicSegmentationMode(checked ? "silence" : "chunks")}
            />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <NumberField
              id="mic-silence-threshold"
              label="Seuil silence (dB)"
              value={micSilenceThresholdDb}
              min={-80}
              max={-5}
              step={1}
              onChange={(value) => setMicSilenceParams({ silenceThresholdDb: value })}
            />
            <NumberField
              id="mic-noise-margin-db"
              label="Marge calibration bruit (dB)"
              value={micNoiseCalibrationMarginDb}
              min={0}
              max={30}
              step={0.5}
              onChange={(value) => setMicNoiseCalibrationMarginDb(value)}
            />
            <NumberField
              id="mic-min-silence"
              label="Silence min (ms)"
              value={micMinSilenceMs}
              min={200}
              max={5000}
              step={100}
              onChange={(value) => setMicSilenceParams({ minSilenceMs: value })}
            />
            <NumberField
              id="mic-min-chunk"
              label="Chunk min (ms)"
              value={micMinChunkMs}
              min={500}
              max={30000}
              step={100}
              onChange={(value) => setMicSilenceParams({ minChunkMs: value })}
            />
            <NumberField
              id="mic-max-chunk"
              label="Chunk max (ms)"
              value={micMaxChunkMs}
              min={5000}
              max={120000}
              step={1000}
              onChange={(value) => setMicSilenceParams({ maxChunkMs: value })}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Pré-traitement micro</CardTitle>
            <CardDescription>
              Choisissez le mode de pré-traitement appliqué aux chunks micro avant la transcription.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Mode de pré-traitement</p>
              <p className="text-xs text-muted-foreground">Sélectionnez "Rapide" pour un prétraitement léger chunk par chunk, ou "Complet" pour effectuer un prétraitement complet avant la transcription.</p>
            </div>
            <Select value={micPreprocessingMode} onValueChange={(v) => setMicPreprocessingMode(v as "quick" | "full") }>
              <SelectTrigger className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="quick">Rapide</SelectItem>
                <SelectItem value="full">Complet</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {micPreprocessingMode === "full" ? (
            <div className="mt-4 space-y-4 rounded-md border bg-muted/30 px-3 py-3">
              <p className="text-xs text-muted-foreground">
                Le mode complet applique un filtrage passe-haut/passe-bas, compression douce, normalisation loudness, puis débruitage spectral (FFT 1024 / hop 256).
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                <SliderField
                  id="mic-noise-floor"
                  label="Noise floor (dB)"
                  min={-50}
                  max={-5}
                  step={1}
                  value={micDenoiseNoiseFloorDb}
                  onChange={(value) => setMicDenoiseParams({ denoiseNoiseFloorDb: value })}
                  help="Décalage du seuil par rapport au profil de bruit. Valeur plus basse = gating plus prudent."
                  disabled={micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-reduction-db"
                  label="Réduction (dB)"
                  min={0}
                  max={24}
                  step={1}
                  value={micDenoiseReductionDb}
                  onChange={(value) => setMicDenoiseParams({ denoiseReductionDb: value })}
                  help="Atténuation max dans les bandes bruyantes (soft-knee)."
                  disabled={micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-smoothing"
                  label="Lissage"
                  min={0}
                  max={0.99}
                  step={0.01}
                  value={micDenoiseSmoothing}
                  onChange={(value) => setMicDenoiseParams({ denoiseSmoothing: value })}
                  help="0 = réactif, 0.8 par défaut = transitions douces."
                  disabled={micAutoTunePreprocess}
                />
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Filtres passe-haut / passe-bas</p>
                    <p className="text-xs text-muted-foreground">Élimine les basses fréquences (rumble) et les aigus inutiles.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={micPreprocessEnableFilters}
                    onCheckedChange={(value) => setMicPreprocessParams({ preprocessEnableFilters: value })}
                    disabled={micAutoTunePreprocess}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Normalisation loudness (LUFS)</p>
                    <p className="text-xs text-muted-foreground">Stabilise la loudness perçue pour la transcription.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={micPreprocessEnableLufs}
                    onCheckedChange={(value) => setMicPreprocessParams({ preprocessEnableLufs: value })}
                    disabled={micAutoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="mic-pre-highpass"
                  label="Passe-haut (Hz)"
                  min={40}
                  max={200}
                  step={5}
                  value={micPreprocessHighpassHz}
                  onChange={(value) => setMicPreprocessParams({ preprocessHighpassHz: value })}
                  help="Coupe les basses fréquences (80 Hz par défaut)."
                  disabled={!micPreprocessEnableFilters || micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-pre-lowpass"
                  label="Passe-bas (Hz)"
                  min={4000}
                  max={12000}
                  step={250}
                  value={micPreprocessLowpassHz}
                  onChange={(value) => setMicPreprocessParams({ preprocessLowpassHz: value })}
                  help="Coupe les aigus trop agressifs (8 kHz par défaut)."
                  disabled={!micPreprocessEnableFilters || micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-pre-lufs-target"
                  label="Cible loudness (LUFS)"
                  min={-30}
                  max={-14}
                  step={0.5}
                  value={micPreprocessTargetLufs}
                  onChange={(value) => setMicPreprocessParams({ preprocessTargetLufs: value })}
                  help="Cible loudness moyenne (ex: -20 LUFS)."
                  disabled={!micPreprocessEnableLufs || micAutoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Limiteur doux</p>
                    <p className="text-xs text-muted-foreground">Évite les saturations après normalisation.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={micPreprocessLimiterEnabled}
                    onCheckedChange={(value) => setMicPreprocessParams({ preprocessLimiterEnabled: value })}
                    disabled={micAutoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="mic-pre-limiter-threshold"
                  label="Seuil limiteur (dBFS)"
                  min={-6}
                  max={-0.1}
                  step={0.1}
                  value={micPreprocessLimiterThresholdDb}
                  onChange={(value) => setMicPreprocessParams({ preprocessLimiterThresholdDb: value })}
                  help="Seuil de limitation (par défaut -1 dBFS)."
                  disabled={!micPreprocessLimiterEnabled || micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-pre-limiter-softness"
                  label="Douceur limiteur"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={micPreprocessLimiterSoftness}
                  onChange={(value) => setMicPreprocessParams({ preprocessLimiterSoftness: value })}
                  help="Plus élevé = limitation plus douce."
                  disabled={!micPreprocessLimiterEnabled || micAutoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Calibration VAD (silence)</p>
                    <p className="text-xs text-muted-foreground">Calcule le profil de bruit sur des zones non parlées.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={micPreprocessVadEnabled}
                    onCheckedChange={(value) => setMicPreprocessParams({ preprocessVadEnabled: value })}
                    disabled={micAutoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="mic-pre-vad-threshold"
                  label="Seuil VAD (dB)"
                  min={-60}
                  max={-30}
                  step={1}
                  value={micPreprocessVadThresholdDb}
                  onChange={(value) => setMicPreprocessParams({ preprocessVadThresholdDb: value })}
                  help="Seuil d'énergie pour détecter la parole."
                  disabled={!micPreprocessVadEnabled || micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-pre-vad-min-silence"
                  label="Silence min (ms)"
                  min={50}
                  max={1000}
                  step={50}
                  value={micPreprocessVadMinSilenceMs}
                  onChange={(value) => setMicPreprocessParams({ preprocessVadMinSilenceMs: value })}
                  help="Durée minimale d'un silence pour la calibration."
                  disabled={!micPreprocessVadEnabled || micAutoTunePreprocess}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <p className="text-sm font-medium">Lissage overlap-add</p>
                    <p className="text-xs text-muted-foreground">Réduit les artefacts aux frontières.</p>
                  </div>
                  <Switch
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={micPreprocessOverlapAdd}
                    onCheckedChange={(value) => setMicPreprocessParams({ preprocessOverlapAdd: value })}
                    disabled={micAutoTunePreprocess}
                  />
                </div>
                <SliderField
                  id="mic-pre-overlap-block"
                  label="Fenêtre overlap (s)"
                  min={0.5}
                  max={3}
                  step={0.1}
                  value={micPreprocessOverlapBlockSec}
                  onChange={(value) => setMicPreprocessParams({ preprocessOverlapBlockSec: value })}
                  help="Durée de fenêtre pour le lissage."
                  disabled={!micPreprocessOverlapAdd || micAutoTunePreprocess}
                />
                <SliderField
                  id="mic-pre-overlap-sec"
                  label="Recouvrement (s)"
                  min={0.05}
                  max={0.8}
                  step={0.05}
                  value={micPreprocessOverlapSec}
                  onChange={(value) => setMicPreprocessParams({ preprocessOverlapSec: value })}
                  help="Recouvrement entre fenêtres."
                  disabled={!micPreprocessOverlapAdd || micAutoTunePreprocess}
                />
              </div>

              <div className="mt-3">
                <SliderField
                  id="mic-calibration-seconds"
                  label="Durée calibration (s)"
                  min={0.25}
                  max={5}
                  step={0.25}
                  value={micDenoiseCalibrationSeconds}
                  onChange={(value) => setMicDenoiseParams({ denoiseCalibrationSeconds: value })}
                  help="Durée (en secondes) utilisée pour estimer le profil de bruit pendant la calibration."
                />
                <div className="mt-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Autotune prétraitement (micro)</p>
                    <p className="text-xs text-muted-foreground">
                      Calibre sur le premier chunk et conserve les réglages pendant l&apos;enregistrement.
                    </p>
                  </div>
                  <div>
                    <Switch
                      aria-label="Autotune prétraitement (micro)"
                      className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                      checked={micAutoTunePreprocess}
                      onCheckedChange={(v) => setMicAutoTunePreprocess(v)}
                    />
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Performance micro</CardTitle>
            <CardDescription>
              Réglages relatifs aux performances pour la transcription micro.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Forcer single-thread</p>
              <p className="text-xs text-muted-foreground">Désactive le multithreading WASM pour /mic.</p>
            </div>
            <Switch
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={micForceSingleThread}
              onCheckedChange={(v) => setMicForceSingleThread(v)}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <div>
            <CardTitle>Exports micro</CardTitle>
            <CardDescription>
              Contrôlez quels boutons d&apos;export apparaissent sur la page Micro.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">VTT</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d&apos;export VTT sur /mic.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={micShowExportVtt} onCheckedChange={(v) => setMicShowExportVtt(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">SRT</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d&apos;export SRT sur /mic.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={micShowExportSrt} onCheckedChange={(v) => setMicShowExportSrt(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">JSON segments</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d&apos;export JSON (segments).</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={micShowExportJson} onCheckedChange={(v) => setMicShowExportJson(v)} />
          </div>

          <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
            <div>
              <p className="text-sm font-medium">Telemetry</p>
              <p className="text-xs text-muted-foreground">Affiche le bouton d&apos;export telemetry.json.</p>
            </div>
            <Switch className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500" checked={micShowExportTelemetry} onCheckedChange={(v) => setMicShowExportTelemetry(v)} />
          </div>
        </CardContent>
      </Card>
          </div>
        </TabsContent>
      ) : null}
      {showCloudSettingsResolved ? (
        <TabsContent value="cloud">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>Transcription cloud</CardTitle>
                <CardDescription>Parametres cloud a venir.</CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">Cette section est vide pour le moment.</p>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}

function NumberField({ id, label, value, min, max, step, onChange }: NumberFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}



function Reminder({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <Separator className="my-2" />
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}
