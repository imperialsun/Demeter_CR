import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createAsrPipeline, disposePipeline, isModelTooLargeError, transcribeChunk } from "@/lib/asr";
import { detectWebGpuSupport } from "@/lib/backend-support";
import {
  MODEL_PRESETS,
  resolveEffectiveModelDtype,
  type BackendImplementation,
  type ModelDtype,
  type PresetKey,
  type PresetQuantizationOverrides,
  useAsrStore,
} from "@/store/asr-store";
import { toast } from "@/components/ui/use-toast";
import logger from "@/lib/logger";

type TestPreset = Exclude<PresetKey, "custom">;

const TEST_ORDER: TestPreset[] = ["fast", "balanced", "medium", "quality", "mms", "turbo"];
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

const cloneQuantizationOverrides = (overrides: PresetQuantizationOverrides): PresetQuantizationOverrides => {
  const entries = Object.entries(overrides).map(([preset, value]) => [
    preset,
    {
      ...(value ?? {}),
    },
  ]);
  return Object.fromEntries(entries) as PresetQuantizationOverrides;
};

const uniqueDtypes = (values: ModelDtype[]): ModelDtype[] => {
  const seen = new Set<ModelDtype>();
  const out: ModelDtype[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
};

const resolveQuantizationCandidates = (
  preset: TestPreset,
  backend: BackendImplementation,
  overrides: PresetQuantizationOverrides
): ModelDtype[] => {
  const defaultDtype = MODEL_PRESETS[preset].quantization[backend] ?? "auto";
  const effectiveDtype = resolveEffectiveModelDtype(preset, backend, overrides) ?? defaultDtype;
  return uniqueDtypes([effectiveDtype, defaultDtype, "auto"]);
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
    logger.warn("[compat-test] stop requested");
    telemetry?.recordAlert?.("MODEL_COMPAT_STOP_REQUESTED", { at: Date.now() });
    setState((prev) => ({
      ...prev,
      stopRequested: true,
      progressLabel: "Arrêt demandé (fin de l'étape en cours)",
    }));
  }, [state.running, telemetry]);

  const closeSummary = useCallback(() => {
    if (state.running) return;
    logger.info("[compat-test] summary closed");
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
    const initialQuantizationOverrides = cloneQuantizationOverrides(
      useAsrStore.getState().modelQuantizationOverrides
    );
    const setPresetQuantization = useAsrStore.getState().setPresetQuantization;

    try {
      let runtimeWebGpuSupported = webGpuSupported;
      try {
        runtimeWebGpuSupported = await detectWebGpuSupport();
        setWebGpuSupport(runtimeWebGpuSupported);
        logger.info("[compat-test] webgpu support check", { supported: runtimeWebGpuSupported });
        telemetry?.logEvent?.("MODEL_COMPAT_WEBGPU_SUPPORT", { supported: runtimeWebGpuSupported });
      } catch (err) {
        void err;
      }

      const attemptsFor = (preset: TestPreset, backend: BackendImplementation) =>
        resolveQuantizationCandidates(preset, backend, initialQuantizationOverrides);

      const totalSteps = TEST_ORDER.reduce((total, preset) => {
        const perPreset = backendOrder.reduce((sum, backend) => sum + attemptsFor(preset, backend).length, 0);
        return total + perPreset;
      }, 0);

      setBlockedPresets([]);
      publishOutcomeRef.current = false;
      logger.info("[compat-test] start", { backendPreference, order: TEST_ORDER });
      telemetry?.logEvent?.("MODEL_COMPAT_TEST_START", {
        backendPreference,
        order: TEST_ORDER,
        protocol: "with_quantization",
      });
      telemetry?.startTimer?.("model_compat_total");

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
        logger.info("[compat-test] webgpu unavailable (global)", { reason: "unsupported" });
        telemetry?.logEvent?.("MODEL_COMPAT_SKIP", { backend: "webgpu", reason: "webgpu_unavailable" });
        markBackendUnavailable("webgpu", "WebGPU non supporte");
      }

      if (!wasmAvailable) {
        logger.info("[compat-test] wasm unavailable (global)", { reason: "missing_assets" });
        telemetry?.logEvent?.("MODEL_COMPAT_SKIP", { backend: "wasm", reason: "wasm_unavailable" });
        markBackendUnavailable("wasm", "WASM non disponible");
      }

      let completedSteps = 0;

      const markProgress = (currentProgress = 0) => {
        const overall = (completedSteps + currentProgress) / Math.max(1, totalSteps);
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

          const quantizationAttempts = attemptsFor(preset, backend);
          if ((backend === "webgpu" && !runtimeWebGpuSupported) || (backend === "wasm" && !wasmAvailable)) {
            logger.info("[compat-test] backend skipped", {
              preset,
              backend,
              reason: backend === "webgpu" ? "webgpu_unavailable" : "wasm_unavailable",
              quantizationAttempts,
            });
            telemetry?.logEvent?.("MODEL_COMPAT_SKIP", {
              preset,
              backend,
              reason: backend === "webgpu" ? "webgpu_unavailable" : "wasm_unavailable",
              quantizationAttempts,
            });
            completedSteps += quantizationAttempts.length;
            setState((prev) => ({ ...prev, step: completedSteps }));
            markProgress();
            continue;
          }

          const attempts: Array<{
            dtype: ModelDtype;
            status: "ok" | "too_large" | "error" | "unavailable";
            durationMs: number;
            message?: string;
          }> = [];
          let backendRuntimeUnavailable = false;

          for (let attemptIndex = 0; attemptIndex < quantizationAttempts.length; attemptIndex += 1) {
            if (stopRef.current) break;

            const dtype = quantizationAttempts[attemptIndex];
            const timerKey = `model_compat_${preset}_${backend}_${dtype}_${attemptIndex + 1}`;
            const startTime = performance.now();

            setPresetQuantization(preset, backend, dtype);
            setState((prev) => ({
              ...prev,
              currentPreset: preset,
              currentBackend: backend,
              step: completedSteps + 1,
              progressLabel: `Chargement ${label} (${backend.toUpperCase()} · ${dtype.toUpperCase()})`,
            }));
            updateBackendResult(preset, backend, {
              status: "testing",
              message: `Chargement du modele (${dtype.toUpperCase()} ${attemptIndex + 1}/${quantizationAttempts.length})`,
            });
            markProgress(0);
            logger.info("[compat-test] backend start", {
              preset,
              backend,
              dtype,
              attempt: attemptIndex + 1,
              attemptsTotal: quantizationAttempts.length,
            });
            telemetry?.logEvent?.("MODEL_COMPAT_BACKEND_START", {
              preset,
              backend,
              dtype,
              attempt: attemptIndex + 1,
              attemptsTotal: quantizationAttempts.length,
            });
            telemetry?.startTimer?.(timerKey);

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
                    setState((prev) => ({
                      ...prev,
                      progressLabel: `${detail} (${dtype.toUpperCase()})`,
                    }));
                  }
                },
                onProgress: (progress, status) => {
                  markProgress(progress ?? 0);
                  setState((prev) => ({
                    ...prev,
                    progressLabel: status ? `${status} (${dtype.toUpperCase()})` : prev.progressLabel,
                  }));
                  logger.debug("[compat-test] progress", { preset, backend, dtype, progress, status });
                  telemetry?.logEvent?.("MODEL_COMPAT_PROGRESS", {
                    preset,
                    backend,
                    dtype,
                    progress: progress ?? 0,
                    status,
                  });
                },
              });

              pipeline = created;

              const chunk = {
                id: `compat-${preset}-${backend}-${dtype}-${attemptIndex + 1}`,
                ...baseChunk,
              };

              await transcribeChunk({
                pipeline,
                chunk,
                pcm: sharedPcm,
                sampleRate: TEST_SAMPLE_RATE,
              });

              const durationMs = Math.round(performance.now() - startTime);
              attempts.push({ dtype, status: "ok", durationMs, message: "OK" });
              logger.info("[compat-test] backend ok", { preset, backend, dtype, durationMs });
              telemetry?.logEvent?.("MODEL_COMPAT_OK", { preset, backend, dtype, durationMs });
            } catch (error) {
              const durationMs = Math.round(performance.now() - startTime);
              const contextMeta = {
                preset,
                backend,
                dtype,
                presetLabel: label,
                backendPreference,
                forceSingleThread,
                runtimeWebGpuSupported,
                wasmAvailable,
                attempt: attemptIndex + 1,
                attemptsTotal: quantizationAttempts.length,
                step: completedSteps + 1,
                totalSteps,
              };

              if (backend === "webgpu" && isWebGpuUnsupportedError(error)) {
                const errorDetails = { ...getErrorDetails(error), ...contextMeta };
                attempts.push({ dtype, status: "unavailable", durationMs, message: "WebGPU non supporte" });
                updateBackendResult(preset, backend, {
                  status: "unavailable",
                  durationMs,
                  message: "WebGPU non supporte",
                });
                logger.info("[compat-test] webgpu unsupported", { durationMs, ...errorDetails });
                logger.error("[compat-test] webgpu unsupported error detail", { durationMs, errorDetails }, error);
                telemetry?.logEvent?.("MODEL_COMPAT_SKIP", {
                  preset,
                  backend,
                  dtype,
                  reason: "webgpu_unsupported_runtime",
                });
                telemetry?.logEvent?.("ERROR", {
                  stage: "model_compat",
                  kind: "webgpu_unsupported",
                  durationMs,
                  ...errorDetails,
                });
                telemetry?.recordAlert?.("MODEL_COMPAT_WEBGPU_UNSUPPORTED", { durationMs, ...errorDetails });
                telemetry?.snapshotMemory?.("model_compat_webgpu_unsupported");
                runtimeWebGpuSupported = false;
                setWebGpuSupport(false);
                markBackendUnavailable("webgpu", "WebGPU non supporte");
                backendRuntimeUnavailable = true;
              } else if (isModelTooLargeError(error)) {
                const errorDetails = { ...getErrorDetails(error), ...contextMeta };
                attempts.push({ dtype, status: "too_large", durationMs, message: "Trop gros pour ce poste" });
                logger.warn("[compat-test] model too large", { durationMs, ...errorDetails });
                logger.error("[compat-test] model too large error detail", { durationMs, errorDetails }, error);
                telemetry?.recordAlert?.("MODEL_COMPAT_TOO_LARGE", { durationMs, ...errorDetails });
                telemetry?.logEvent?.("ERROR", { stage: "model_compat", kind: "too_large", durationMs, ...errorDetails });
                telemetry?.snapshotMemory?.("model_compat_too_large");
              } else {
                const message = (error as Error)?.message || "Erreur inconnue";
                const errorDetails = { ...getErrorDetails(error), ...contextMeta };
                attempts.push({ dtype, status: "error", durationMs, message });
                logger.warn("Model compatibility test failed", error);
                logger.error("[compat-test] backend error", { durationMs, message, ...errorDetails });
                logger.error("[compat-test] backend error detail", { durationMs, errorDetails }, error);
                telemetry?.logEvent?.("ERROR", { stage: "model_compat", message, durationMs, ...errorDetails });
                telemetry?.recordAlert?.("MODEL_COMPAT_ERROR", { durationMs, ...errorDetails });
                telemetry?.snapshotMemory?.("model_compat_error");
              }
            } finally {
              await disposePipeline(pipeline);
              telemetry?.stopTimer?.(timerKey);
              completedSteps += 1;
              setState((prev) => ({ ...prev, step: completedSteps }));
              markProgress();
            }

            if (backendRuntimeUnavailable) {
              const remainingAttempts = quantizationAttempts.length - (attemptIndex + 1);
              if (remainingAttempts > 0) {
                completedSteps += remainingAttempts;
                setState((prev) => ({ ...prev, step: completedSteps }));
                markProgress();
              }
              break;
            }
          }

          if (stopRef.current) break;
          if (backendRuntimeUnavailable || attempts.length === 0) continue;

          const okAttempts = attempts.filter((item) => item.status === "ok");
          if (okAttempts.length > 0) {
            const bestDurationMs = okAttempts.reduce(
              (best, item) => Math.min(best, item.durationMs),
              okAttempts[0]?.durationMs ?? 0
            );
            const okDtypes = okAttempts.map((item) => item.dtype.toUpperCase()).join(", ");
            updateBackendResult(preset, backend, {
              status: "ok",
              durationMs: bestDurationMs,
              message: `OK (${okDtypes})`,
            });
            continue;
          }

          const tooLargeAttempt = attempts.find((item) => item.status === "too_large");
          if (tooLargeAttempt) {
            updateBackendResult(preset, backend, {
              status: "too_large",
              durationMs: tooLargeAttempt.durationMs,
              message: `Trop gros (${tooLargeAttempt.dtype.toUpperCase()})`,
            });
            continue;
          }

          const unavailableAttempt = attempts.find((item) => item.status === "unavailable");
          if (unavailableAttempt) {
            updateBackendResult(preset, backend, {
              status: "unavailable",
              durationMs: unavailableAttempt.durationMs,
              message: unavailableAttempt.message ?? "Backend indisponible",
            });
            continue;
          }

          const firstError = attempts.find((item) => item.status === "error");
          updateBackendResult(preset, backend, {
            status: "error",
            durationMs: firstError?.durationMs,
            message: firstError?.message ?? "Erreur inconnue",
          });
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
    } finally {
      useAsrStore.setState({
        modelQuantizationOverrides: initialQuantizationOverrides,
      });
    }
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
      logger.warn("[compat-test] stopped", { blocked: blockedPresets });
      telemetry?.logEvent?.("MODEL_COMPAT_STOPPED", { blocked: blockedPresets });
    } else {
      logger.info("[compat-test] done", { blocked: blockedPresets });
      telemetry?.logEvent?.("MODEL_COMPAT_TEST_DONE", { blocked: blockedPresets });
    }
  }, [blockedPresets, setBlockedPresets, state.running, state.stopRequested, state.summaryOpen, telemetry]);

  return { state, runTest, stopTest, closeSummary, summary };
}
