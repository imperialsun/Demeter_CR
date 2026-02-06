import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAsrPipeline, disposePipeline, isModelTooLargeError, transcribeChunk } from "@/lib/asr";
import { detectWebGpuSupport } from "@/lib/backend-support";
import { MODEL_PRESETS, type BackendImplementation, type PresetKey, useAsrStore } from "@/store/asr-store";
import { toast } from "@/components/ui/use-toast";
import logger from "@/lib/logger";

type TestPreset = Exclude<PresetKey, "custom">;

const TEST_ORDER: TestPreset[] = ["fast", "balanced", "medium", "quality", "turbo"];
const TEST_SAMPLE_RATE = 16000;
const TEST_DURATION_SEC = 1;

const isWebGpuUnsupportedError = (error: unknown) => {
  const raw =
    typeof error === "string"
      ? error
      : (error as { message?: string })?.message ?? "";
  const message = raw.toLowerCase();
  return (
    message.includes("webgpu") &&
    (message.includes("non support") ||
      message.includes("not supported") ||
      message.includes("adapter") ||
      message.includes("gpu non"))
  );
};

export type ModelTestStatus = "pending" | "testing" | "ok" | "too_large" | "error" | "skipped" | "unavailable";

export type BackendTestResult = {
  status: ModelTestStatus;
  durationMs?: number;
  message?: string;
};

export type ModelTestResult = {
  preset: TestPreset;
  label: string;
  backends: Record<BackendImplementation, BackendTestResult>;
};

export type ModelTestState = {
  running: boolean;
  results: ModelTestResult[];
  currentPreset?: TestPreset;
  currentBackend?: BackendImplementation;
  step: number;
  total: number;
  progress?: number;
  progressLabel?: string;
  stopRequested?: boolean;
  summaryOpen?: boolean;
};

const toShortString = (value: unknown, maxLen = 600) => {
  try {
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    if (!raw) return "";
    return raw.length > maxLen ? `${raw.slice(0, maxLen)}...` : raw;
  } catch (err) {
    void err;
    const fallback = String(value ?? "");
    return fallback.length > maxLen ? `${fallback.slice(0, maxLen)}...` : fallback;
  }
};

const getErrorDetails = (error: unknown) => {
  const asErr = error as { message?: string; name?: string; stack?: string; cause?: unknown; code?: unknown };
  const errorName = asErr?.name ?? (error instanceof Error ? error.name : undefined);
  const errorMessage =
    asErr?.message ??
    (error instanceof Error ? error.message : typeof error === "string" ? error : undefined);
  const errorStack = asErr?.stack ?? (error instanceof Error ? error.stack : undefined);
  const errorCause = asErr?.cause;
  const errorCauseMessage =
    errorCause instanceof Error
      ? errorCause.message
      : typeof errorCause === "string"
        ? errorCause
        : undefined;
  const errorCode = asErr?.code;
  return {
    errorName,
    errorMessage,
    errorStack: errorStack ? toShortString(errorStack, 2000) : undefined,
    errorCause: errorCauseMessage,
    errorCode: typeof errorCode === "string" || typeof errorCode === "number" ? errorCode : undefined,
    errorRaw: toShortString(error),
  };
};

const shouldBlockPreset = (backendResults: BackendTestResult[]) => {
  const hasOk = backendResults.some((b) => b.status === "ok");
  const hasBlockingFailure = backendResults.some((b) => b.status === "too_large" || b.status === "error");
  return !hasOk && hasBlockingFailure;
};

function makeInitialResults(): ModelTestResult[] {
  return TEST_ORDER.map((preset) => ({
    preset,
    label: MODEL_PRESETS[preset].label,
    backends: {
      webgpu: { status: "pending" },
      wasm: { status: "pending" },
    },
  }));
}

export function useModelCompatibilityTest() {
  const backendPreference = useAsrStore((s) => s.backendPreference);
  const forceSingleThread = useAsrStore((s) => s.forceSingleThread);
  const isTranscribing = useAsrStore((s) => s.isTranscribing);
  const setBlockedPresets = useAsrStore((s) => s.setBlockedPresets);
  const setWebGpuSupport = useAsrStore((s) => s.setWebGpuSupport);
  const telemetry = useAsrStore((s) => s.telemetryCollector);
  const webGpuSupported = useAsrStore((s) => s.webGpuSupported);
  const wasmAvailable = useAsrStore((s) => s.wasmAvailable);
  const stopRef = useRef(false);
  const publishOutcomeRef = useRef(false);

  const [state, setState] = useState<ModelTestState>(() => ({
    running: false,
    results: makeInitialResults(),
    step: 0,
    total: TEST_ORDER.length * 2,
    summaryOpen: false,
  }));

  const updateBackendResult = useCallback(
    (preset: TestPreset, backend: BackendImplementation, patch: Partial<BackendTestResult>) => {
      setState((prev) => ({
        ...prev,
        results: prev.results.map((item) =>
          item.preset === preset
            ? {
                ...item,
                backends: {
                  ...item.backends,
                  [backend]: { ...item.backends[backend], ...patch },
                },
              }
            : item
        ),
      }));
    },
    []
  );

  const markBackendUnavailable = useCallback((backend: BackendImplementation, message: string) => {
    setState((prev) => ({
      ...prev,
      results: prev.results.map((item) => {
        const entry = item.backends[backend];
        if (entry.status !== "pending") {
          return item;
        }
        return {
          ...item,
          backends: {
            ...item.backends,
            [backend]: { ...entry, status: "unavailable", message },
          },
        };
      }),
    }));
  }, []);

  const backendOrder = useMemo<BackendImplementation[]>(() => {
    return backendPreference === "webgpu" ? ["webgpu", "wasm"] : ["wasm", "webgpu"];
  }, [backendPreference]);

  const stopTest = useCallback(() => {
    if (!state.running) return;
    stopRef.current = true;
    console.warn("[compat-test] stop requested");
    telemetry?.recordAlert?.("MODEL_COMPAT_STOP_REQUESTED", { at: Date.now() });
    setState((prev) => ({
      ...prev,
      stopRequested: true,
      progressLabel: "Arrêt demandé (fin de l'étape en cours)",
    }));
  }, [state.running, telemetry]);

  const closeSummary = useCallback(() => {
    if (state.running) return;
    console.info("[compat-test] summary closed");
    telemetry?.logEvent?.("MODEL_COMPAT_SUMMARY_CLOSED", { at: Date.now() });
    setState((prev) => ({
      ...prev,
      summaryOpen: false,
      stopRequested: false,
    }));
    publishOutcomeRef.current = false;
  }, [state.running, telemetry]);

  const runTest = useCallback(async () => {
    if (state.running) return;
    if (isTranscribing) {
      toast("Une transcription est en cours. Stoppez-la avant de tester les modeles.");
      return;
    }
    stopRef.current = false;

    let runtimeWebGpuSupported = webGpuSupported;
    try {
      runtimeWebGpuSupported = await detectWebGpuSupport();
      setWebGpuSupport(runtimeWebGpuSupported);
      console.info("[compat-test] webgpu support check", { supported: runtimeWebGpuSupported });
      telemetry?.logEvent?.("MODEL_COMPAT_WEBGPU_SUPPORT", { supported: runtimeWebGpuSupported });
    } catch (err) {
      void err;
    }

    setBlockedPresets([]);
    publishOutcomeRef.current = false;
    console.info("[compat-test] start", { backendPreference, order: TEST_ORDER });
    telemetry?.logEvent?.("MODEL_COMPAT_TEST_START", {
      backendPreference,
      order: TEST_ORDER,
    });
    telemetry?.startTimer?.("model_compat_total");
    const totalSteps = TEST_ORDER.length * backendOrder.length;

    setState({
      running: true,
      results: makeInitialResults(),
      step: 0,
      total: totalSteps,
      progress: 0,
      progressLabel: "Preparation du test",
      stopRequested: false,
      summaryOpen: true,
    });

    if (!runtimeWebGpuSupported) {
      console.info("[compat-test] webgpu unavailable (global)", { reason: "unsupported" });
      telemetry?.logEvent?.("MODEL_COMPAT_SKIP", { backend: "webgpu", reason: "webgpu_unavailable" });
      markBackendUnavailable("webgpu", "WebGPU non supporte");
    }

    if (!wasmAvailable) {
      console.info("[compat-test] wasm unavailable (global)", { reason: "missing_assets" });
      telemetry?.logEvent?.("MODEL_COMPAT_SKIP", { backend: "wasm", reason: "wasm_unavailable" });
      markBackendUnavailable("wasm", "WASM non disponible");
    }

    let completedSteps = 0;

    const markProgress = (currentProgress = 0) => {
      const overall = (completedSteps + currentProgress) / totalSteps;
      setState((prev) => ({
        ...prev,
        progress: Math.max(0, Math.min(1, overall)),
      }));
    };

    const sharedPcm = new Float32Array(TEST_SAMPLE_RATE * TEST_DURATION_SEC);
    const baseChunk = {
      index: 0,
      start: 0,
      end: TEST_DURATION_SEC,
      paddedStart: 0,
      paddedEnd: TEST_DURATION_SEC,
    };

    for (let i = 0; i < TEST_ORDER.length; i += 1) {
      const preset = TEST_ORDER[i];
      const label = MODEL_PRESETS[preset].label;

      for (const backend of backendOrder) {
        if (stopRef.current) break;

        if ((backend === "webgpu" && !runtimeWebGpuSupported) || (backend === "wasm" && !wasmAvailable)) {
          console.info("[compat-test] backend skipped", {
            preset,
            backend,
            reason: backend === "webgpu" ? "webgpu_unavailable" : "wasm_unavailable",
          });
          telemetry?.logEvent?.("MODEL_COMPAT_SKIP", {
            preset,
            backend,
            reason: backend === "webgpu" ? "webgpu_unavailable" : "wasm_unavailable",
          });
          completedSteps += 1;
          setState((prev) => ({ ...prev, step: completedSteps }));
          markProgress();
          continue;
        }

        const startTime = performance.now();
        setState((prev) => ({
          ...prev,
          currentPreset: preset,
          currentBackend: backend,
          step: completedSteps + 1,
          progressLabel: `Chargement ${label} (${backend.toUpperCase()})`,
        }));
        updateBackendResult(preset, backend, { status: "testing", message: "Chargement du modele" });
        markProgress(0);
        console.info("[compat-test] backend start", { preset, backend });
        telemetry?.logEvent?.("MODEL_COMPAT_BACKEND_START", { preset, backend });
        telemetry?.startTimer?.(`model_compat_${preset}_${backend}`);

        let pipeline: Awaited<ReturnType<typeof createAsrPipeline>>["pipeline"] | undefined;
        try {
          const { pipeline: created } = await createAsrPipeline({
            modelPreset: preset,
            customModelId: "",
            backendPreference,
            forceBackend: backend,
            forceSingleThread,
            telemetry: telemetry ?? undefined,
            onStatus: (_status, detail) => {
              if (detail) {
                setState((prev) => ({ ...prev, progressLabel: detail }));
              }
            },
            onProgress: (progress, status) => {
              markProgress(progress ?? 0);
              setState((prev) => ({
                ...prev,
                progressLabel: status || prev.progressLabel,
              }));
              console.debug("[compat-test] progress", { preset, backend, progress, status });
              telemetry?.logEvent?.("MODEL_COMPAT_PROGRESS", {
                preset,
                backend,
                progress: progress ?? 0,
                status,
              });
            },
          });

          pipeline = created;

          const chunk = {
            id: `compat-${preset}-${backend}`,
            ...baseChunk,
          };

          await transcribeChunk({
            pipeline,
            chunk,
            pcm: sharedPcm,
            sampleRate: TEST_SAMPLE_RATE,
          });

          const durationMs = Math.round(performance.now() - startTime);
          updateBackendResult(preset, backend, {
            status: "ok",
            durationMs,
            message: "OK",
          });
          console.info("[compat-test] backend ok", { preset, backend, durationMs });
          telemetry?.logEvent?.("MODEL_COMPAT_OK", { preset, backend, durationMs });
        } catch (error) {
          const durationMs = Math.round(performance.now() - startTime);
          const contextMeta = {
            preset,
            backend,
            presetLabel: label,
            backendPreference,
            forceSingleThread,
            runtimeWebGpuSupported,
            wasmAvailable,
            step: completedSteps + 1,
            totalSteps,
          };

          if (backend === "webgpu" && isWebGpuUnsupportedError(error)) {
            const errorDetails = { ...getErrorDetails(error), ...contextMeta };
            updateBackendResult(preset, backend, {
              status: "unavailable",
              durationMs,
              message: "WebGPU non supporte",
            });
            console.info("[compat-test] webgpu unsupported", { durationMs, ...errorDetails });
            console.error("[compat-test] webgpu unsupported error detail", { durationMs, errorDetails }, error);
            telemetry?.logEvent?.("MODEL_COMPAT_SKIP", { preset, backend, reason: "webgpu_unsupported_runtime" });
            telemetry?.logEvent?.("ERROR", { stage: "model_compat", kind: "webgpu_unsupported", durationMs, ...errorDetails });
            telemetry?.recordAlert?.("MODEL_COMPAT_WEBGPU_UNSUPPORTED", { durationMs, ...errorDetails });
            telemetry?.snapshotMemory?.("model_compat_webgpu_unsupported");
            runtimeWebGpuSupported = false;
            setWebGpuSupport(false);
            markBackendUnavailable("webgpu", "WebGPU non supporte");
          } else if (isModelTooLargeError(error)) {
            const errorDetails = { ...getErrorDetails(error), ...contextMeta };
            updateBackendResult(preset, backend, {
              status: "too_large",
              durationMs,
              message: "Trop gros pour ce poste",
            });
            console.warn("[compat-test] model too large", { durationMs, ...errorDetails });
            console.error("[compat-test] model too large error detail", { durationMs, errorDetails }, error);
            telemetry?.recordAlert?.("MODEL_COMPAT_TOO_LARGE", { durationMs, ...errorDetails });
            telemetry?.logEvent?.("ERROR", { stage: "model_compat", kind: "too_large", durationMs, ...errorDetails });
            telemetry?.snapshotMemory?.("model_compat_too_large");
          } else {
            const message = (error as Error)?.message || "Erreur inconnue";
            const errorDetails = { ...getErrorDetails(error), ...contextMeta };
            logger.warn("Model compatibility test failed", error);
            updateBackendResult(preset, backend, {
              status: "error",
              durationMs,
              message,
            });
            console.error("[compat-test] backend error", { durationMs, message, ...errorDetails });
            console.error("[compat-test] backend error detail", { durationMs, errorDetails }, error);
            telemetry?.logEvent?.("ERROR", { stage: "model_compat", message, durationMs, ...errorDetails });
            telemetry?.recordAlert?.("MODEL_COMPAT_ERROR", { durationMs, ...errorDetails });
            telemetry?.snapshotMemory?.("model_compat_error");
          }
        } finally {
          await disposePipeline(pipeline);
          telemetry?.stopTimer?.(`model_compat_${preset}_${backend}`);
          completedSteps += 1;
          setState((prev) => ({ ...prev, step: completedSteps }));
          markProgress();
        }
      }

      if (stopRef.current) break;
    }

    if (stopRef.current) {
      setState((prev) => ({
        ...prev,
        running: false,
        progressLabel: "Test interrompu",
        stopRequested: true,
        summaryOpen: true,
      }));
      telemetry?.stopTimer?.("model_compat_total");
      toast("Test interrompu.");
      return;
    }

    setState((prev) => ({
      ...prev,
      running: false,
      progress: 1,
      progressLabel: "Test termine",
      stopRequested: false,
      summaryOpen: true,
    }));

    telemetry?.stopTimer?.("model_compat_total");
    toast("Test de compatibilite termine.");
  }, [
    backendOrder,
    backendPreference,
    forceSingleThread,
    isTranscribing,
    setBlockedPresets,
    setWebGpuSupport,
    markBackendUnavailable,
    state.running,
    telemetry,
    updateBackendResult,
    wasmAvailable,
    webGpuSupported,
  ]);

  const summary = useMemo(() => {
    const ok = state.results.filter((r) => Object.values(r.backends).some((b) => b.status === "ok")).length;
    const blockedCount = state.results.filter((r) => shouldBlockPreset(Object.values(r.backends))).length;
    const errors = state.results.filter((r) => Object.values(r.backends).some((b) => b.status === "error")).length;
    return { ok, blockedCount, errors };
  }, [state.results]);

  const blockedPresets = useMemo(
    () => state.results.filter((r) => shouldBlockPreset(Object.values(r.backends))).map((r) => r.preset),
    [state.results]
  );

  useEffect(() => {
    if (state.running || !state.summaryOpen || publishOutcomeRef.current) return;
    publishOutcomeRef.current = true;
    setBlockedPresets(blockedPresets);
    if (state.stopRequested) {
      console.warn("[compat-test] stopped", { blocked: blockedPresets });
      telemetry?.logEvent?.("MODEL_COMPAT_STOPPED", { blocked: blockedPresets });
    } else {
      console.info("[compat-test] done", { blocked: blockedPresets });
      telemetry?.logEvent?.("MODEL_COMPAT_TEST_DONE", { blocked: blockedPresets });
    }
  }, [blockedPresets, setBlockedPresets, state.running, state.stopRequested, state.summaryOpen, telemetry]);

  return { state, runTest, stopTest, closeSummary, summary };
}
