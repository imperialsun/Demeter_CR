import { useCallback, useRef, useState } from "react";
import { useAsrStore, type ModelSizeForegroundAlert } from "@/store/asr-store";
import { TelemetryCollector } from "@/lib/telemetry";
import { reportFormatToKey, type ReportFormat, type ReportResult, type ReportResultKey } from "@/lib/llm/reportSchema";
import { buildLongInputChunkPrompt, buildLongInputConsolidationPrompt } from "@/lib/llm/reportPrompts";
import { disposeLocalGenerationPipelines, generateLocalText } from "@/lib/llm/local/localGeneration";
import { generateLocalReportDetailed } from "@/lib/llm/local/localReportService";
import {
  clampLocalMaxTokens,
  getLocalLlmModelProfile,
  resolveLocalLlmBackend,
  resolveLocalLlmBackendCandidates,
  resolveLocalLlmDtype,
  resolveLocalLlmFallbackProfile,
  resolveLocalLlmModelId,
} from "@/lib/llm/localModelCatalog";
import { prepareLongInputForReports } from "@/lib/llm/longInputPipeline";
import { buildReportDocx, downloadDocxBlob, formatReportDocxFilename } from "@/lib/docx/reportDocx";
import { estimateTokenCount } from "@/lib/tokens";
import { formatTokenCount, resolveLongInputChunkingProfile, resolveModelTokenBudget } from "@/lib/llm/modelCatalog";
import { emitLlmEvent } from "@/lib/llm/telemetrySession";
import logger from "@/lib/logger";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";

const FORMAT_ORDER: Array<{ key: ReportResultKey; format: ReportFormat }> = [
  { key: "cri", format: "CRI" },
  { key: "cro", format: "CRO" },
  { key: "crs", format: "CRS" },
];

type GenerateInput = { source: "transcription" | "text"; text?: string };

export function useLlmLocalReports() {
  const runIdRef = useRef(0);
  const [isResettingSession, setIsResettingSession] = useState(false);
  const segments = useAsrStore((state) => state.segments);
  const webGpuSupported = useAsrStore((state) => state.webGpuSupported);
  const wasmAvailable = useAsrStore((state) => state.wasmAvailable);

  const llmLocalModelProfile = useAsrStore((state) => state.llmLocalModelProfile);
  const llmLocalModelIdLegacy = useAsrStore((state) => state.llmLocalModelId);
  const llmLocalTemperatureLegacy = useAsrStore((state) => state.llmLocalTemperature);
  const llmLocalMaxTokensLegacy = useAsrStore((state) => state.llmLocalMaxTokens);
  const llmLocalDtypeWebgpuLegacy = useAsrStore((state) => state.llmLocalDtypeWebgpu);
  const llmLocalDtypeWasmLegacy = useAsrStore((state) => state.llmLocalDtypeWasm);
  const llmLocalSettingsByProfile = useAsrStore((state) => state.llmLocalSettingsByProfile);

  const status = useAsrStore((state) => state.llmLocalStatus);
  const progress = useAsrStore((state) => state.llmLocalProgress);
  const results = useAsrStore((state) => state.llmLocalResults);

  const setLlmLocalStatus = useAsrStore((state) => state.setLlmLocalStatus);
  const setLlmLocalProgress = useAsrStore((state) => state.setLlmLocalProgress);
  const setLlmLocalResult = useAsrStore((state) => state.setLlmLocalResult);
  const setLlmLocalResults = useAsrStore((state) => state.setLlmLocalResults);
  const setLlmLocalModelProfile = useAsrStore((state) => state.setLlmLocalModelProfile);
  const setLlmLocalModelId = useAsrStore((state) => state.setLlmLocalModelId);
  const registerTelemetry = useAsrStore((state) => state.registerTelemetry);
  const setTelemetrySummary = useAsrStore((state) => state.setTelemetrySummary);

  const generateAll = useCallback(
    async (input: GenerateInput) => {
      if (isResettingSession) {
        return;
      }
      const runId = runIdRef.current + 1;
      runIdRef.current = runId;
      const isRunActive = () => runIdRef.current === runId;
      const throwIfRunInvalidated = () => {
        if (!isRunActive()) {
          throw new DOMException("LLM local run invalidated", "AbortError");
        }
      };
      const setStatusSafe = (nextStatus: Parameters<typeof setLlmLocalStatus>[0], detail?: string) => {
        if (isRunActive()) {
          setLlmLocalStatus(nextStatus, detail);
        }
      };
      const setProgressSafe = (value: number) => {
        if (isRunActive()) {
          setLlmLocalProgress(value);
        }
      };
      const setResultsSafe = (value: Parameters<typeof setLlmLocalResults>[0]) => {
        if (isRunActive()) {
          setLlmLocalResults(value);
        }
      };
      const setResultSafe = (key: ReportResultKey, value: ReportResult) => {
        if (isRunActive()) {
          setLlmLocalResult(key, value);
        }
      };
      const setModelProfileSafe = (profile: typeof llmLocalModelProfile) => {
        if (isRunActive()) {
          setLlmLocalModelProfile(profile);
        }
      };
      const setModelIdSafe = (value: string) => {
        if (isRunActive()) {
          setLlmLocalModelId(value);
        }
      };
      const setTelemetrySummarySafe = (summary: Parameters<typeof setTelemetrySummary>[0]) => {
        if (isRunActive()) {
          setTelemetrySummary(summary);
        }
      };
      useAsrStore.getState().clearLlmLocalModelSizeAlert();
      let modelSizeAlertSeverityForRun: ModelSizeForegroundAlert["severity"] | null = null;
      const setModelSizeAlertForRun = (
        alert: Omit<ModelSizeForegroundAlert, "signature">
      ) => {
        if (!isRunActive()) return;
        if (modelSizeAlertSeverityForRun === "error") return;
        if (modelSizeAlertSeverityForRun === alert.severity) return;
        if (modelSizeAlertSeverityForRun && alert.severity !== "error") return;

        modelSizeAlertSeverityForRun = alert.severity;
        useAsrStore.getState().setLlmLocalModelSizeAlert({
          ...alert,
          signature: `llmlocal:${runId}:${alert.severity}`,
        });
      };

      const telemetry = new TelemetryCollector();
      registerTelemetry(telemetry);
      setTelemetrySummarySafe(null);
      setResultsSafe({});
      let stage = "init";
      const markStage = (nextStage: string, data?: Record<string, unknown>) => {
        stage = nextStage;
        telemetry.logEvent("LLM_RUN_STAGE", {
          stage: nextStage,
          provider: "local",
          sourceMode: input.source,
          ...(data ?? {}),
        });
        logger.info("[llm-local] stage", {
          stage: nextStage,
          ...(data ?? {}),
        });
      };

      const runWithProfile = async (profileId: typeof llmLocalModelProfile): Promise<void> => {
        throwIfRunInvalidated();
        const profile = getLocalLlmModelProfile(profileId);
        const liveSettings = useAsrStore.getState().llmLocalSettingsByProfile[profile.id];
        const modelId =
          liveSettings?.modelId?.trim() ||
          llmLocalSettingsByProfile[profile.id]?.modelId?.trim() ||
          llmLocalModelIdLegacy.trim() ||
          resolveLocalLlmModelId(profile.id);
        const temperature =
          liveSettings?.temperature ??
          llmLocalSettingsByProfile[profile.id]?.temperature ??
          llmLocalTemperatureLegacy;
        const maxTokens =
          liveSettings?.maxTokens ??
          llmLocalSettingsByProfile[profile.id]?.maxTokens ??
          llmLocalMaxTokensLegacy;
        const dtypeWebgpu =
          liveSettings?.dtypeWebgpu ??
          llmLocalSettingsByProfile[profile.id]?.dtypeWebgpu ??
          llmLocalDtypeWebgpuLegacy;
        const dtypeWasm =
          liveSettings?.dtypeWasm ??
          llmLocalSettingsByProfile[profile.id]?.dtypeWasm ??
          llmLocalDtypeWasmLegacy;
        const appendNoThinkDirective =
          liveSettings?.appendNoThinkDirective ??
          llmLocalSettingsByProfile[profile.id]?.appendNoThinkDirective ??
          Boolean(profile.appendNoThinkDirective);
        setModelIdSafe(modelId);

        const backendCandidates = resolveLocalLlmBackendCandidates({
          profile,
          webGpuSupported,
          wasmAvailable,
        });
        if (backendCandidates.length === 0) {
          const backendResolution = resolveLocalLlmBackend({
            profile,
            webGpuSupported,
            wasmAvailable,
          });
          throw new Error(backendResolution.error ?? "Backend local indisponible.");
        }

        let lastError: unknown;

        for (let attemptIndex = 0; attemptIndex < backendCandidates.length; attemptIndex += 1) {
          const backend = backendCandidates[attemptIndex]!;
          const dtype = resolveLocalLlmDtype(profile, backend, {
            webgpu: dtypeWebgpu,
            wasm: dtypeWasm,
          });
          markStage("backend_attempt_start", {
            profileId: profile.id,
            modelId,
            backend,
            dtype,
            attemptIndex,
          });
          throwIfRunInvalidated();

          if (attemptIndex > 0) {
            const previousBackend = backendCandidates[attemptIndex - 1]!;
            setStatusSafe(
              "preparing",
              `Echec ${previousBackend.toUpperCase()}, tentative ${backend.toUpperCase()}`
            );
            setProgressSafe(0.03);
            setResultsSafe({});
          }

          try {
            telemetry.logEvent("LLM_RUN_START", {
              provider: "local",
              profileId: profile.id,
              modelId,
              backend,
              sourceMode: input.source,
            });
            logger.info("[llm-local] run start", {
              profileId: profile.id,
              modelId,
              backend,
              dtype,
              sourceMode: input.source,
              attemptIndex,
            });

            const sourceText = resolveSourceText(input, segments);
            markStage("source_resolved", {
              profileId: profile.id,
              modelId,
              backend,
              sourceLength: sourceText.length,
              sourceTokenEstimate: estimateTokenCount(sourceText),
            });

            const runtimeLimits = {
              contextWindowTokens: profile.contextWindowTokens,
              maxGenerationTokens: profile.maxGenerationTokens,
            };

            const configuredMaxTokens = clampLocalMaxTokens(profile, maxTokens);

            const chunkingProfile = resolveLongInputChunkingProfile({
              modelId,
              configuredMaxTokens,
              runtimeLimits,
            });
            markStage("chunking_profile_resolved", {
              profileId: profile.id,
              modelId,
              backend,
              thresholdTokens: chunkingProfile.thresholdTokens,
              chunkTokens: chunkingProfile.chunkTokens,
              chunkOverlapTokens: chunkingProfile.chunkOverlapTokens,
            });

            setStatusSafe("preparing", "Preparation de la source locale");
            setProgressSafe(0.02);
            markStage("prepare_long_input_start", {
              profileId: profile.id,
              modelId,
              backend,
            });

            const prepared = await prepareLongInputForReports({
              sourceText,
              thresholdTokens: chunkingProfile.thresholdTokens,
              chunkTokens: chunkingProfile.chunkTokens,
              chunkOverlapTokens: chunkingProfile.chunkOverlapTokens,
              onProgress: (p, detail) => {
                setStatusSafe("preparing", detail);
                setProgressSafe(Math.min(0.45, 0.04 + p * 0.5));
              },
              summarizeChunk: async (chunkText, chunkIndex, chunkCount) => {
                const prompts = buildLongInputChunkPrompt(chunkText, chunkIndex, chunkCount);
                return generateLocalText({
                  modelId,
                  backend,
                  dtype,
                  systemPrompt: prompts.systemPrompt,
                  userPrompt: prompts.userPrompt,
                  temperature: 0,
                  maxTokens: Math.min(900, configuredMaxTokens),
                });
              },
              consolidateSummaries: async (chunkSummaries) => {
                const prompts = buildLongInputConsolidationPrompt(chunkSummaries);
                return generateLocalText({
                  modelId,
                  backend,
                  dtype,
                  systemPrompt: prompts.systemPrompt,
                  userPrompt: prompts.userPrompt,
                  temperature: 0,
                  maxTokens: Math.min(1600, configuredMaxTokens),
                });
              },
            });
            throwIfRunInvalidated();
            markStage("prepare_long_input_done", {
              profileId: profile.id,
              modelId,
              backend,
              pipelinePasses: prepared.pipelinePasses,
              chunkCount: prepared.chunkCount,
              preparedLength: prepared.text.length,
              preparedTokenEstimate: estimateTokenCount(prepared.text),
            });

            const sourceTokensForGeneration = estimateTokenCount(prepared.text);
            const tokenBudget = resolveModelTokenBudget({
              modelId,
              sourceTokens: sourceTokensForGeneration,
              runtimeLimits,
            });

            if (tokenBudget.blockedByContext) {
              throw new Error(
                `Source trop longue pour ${profile.label}. Contexte max: ${formatTokenCount(
                  tokenBudget.contextWindowTokens ?? 0
                )} tokens.`
              );
            }
            markStage("token_budget_resolved", {
              profileId: profile.id,
              modelId,
              backend,
              contextWindowTokens: tokenBudget.contextWindowTokens ?? null,
              effectiveMaxGenerationTokens: tokenBudget.effectiveMaxGenerationTokens ?? null,
            });

            const effectiveGenerationMaxTokens =
              typeof tokenBudget.effectiveMaxGenerationTokens === "number"
                ? Math.min(configuredMaxTokens, tokenBudget.effectiveMaxGenerationTokens)
                : configuredMaxTokens;

            for (let index = 0; index < FORMAT_ORDER.length; index += 1) {
              const item = FORMAT_ORDER[index]!;
              setStatusSafe("generating", `Generation ${item.format} (${index + 1}/3)`);
              setProgressSafe(0.5 + (index / FORMAT_ORDER.length) * 0.4);
              markStage("format_generation_start", {
                profileId: profile.id,
                modelId,
                backend,
                format: item.format,
                sequence: index + 1,
                totalFormats: FORMAT_ORDER.length,
              });
              throwIfRunInvalidated();

              const generation = await generateLocalReportDetailed({
                format: item.format,
                modelId,
                sourceText: prepared.text,
                backend,
                dtype,
                temperature,
                maxTokens: effectiveGenerationMaxTokens,
                appendNoThinkDirective,
                onLoadProgress: () => {
                  // Model download progress is tracked at pipeline level by logger/events.
                },
              });
              throwIfRunInvalidated();

              const result: ReportResult = {
                format: item.format,
                report: generation.report,
                rawResponse: generation.rawResponse,
                modelId,
                generatedAt: new Date().toISOString(),
                sourceMode: input.source,
                sourceTokenCount: prepared.sourceTokenCount,
                pipelinePasses: prepared.pipelinePasses,
                strategy: generation.strategy,
              };

              setResultSafe(reportFormatToKey(item.format), result);
              markStage("format_generation_done", {
                profileId: profile.id,
                modelId,
                backend,
                format: item.format,
                sequence: index + 1,
                sectionCount: result.report.sections.length,
                outputLength: result.rawResponse.length,
              });
            }

            setStatusSafe("done", "Generation locale terminee");
            setProgressSafe(1);
            markStage("run_done", {
              profileId: profile.id,
              modelId,
              backend,
              formatCount: FORMAT_ORDER.length,
            });
            telemetry.logEvent("LLM_RUN_DONE", {
              provider: "local",
              profileId: profile.id,
              modelId,
              backend,
              sourceMode: input.source,
            });
            trackBackendActivityEvent({
              eventKind: "report",
              sourceMode: "local",
              provider: "local",
              status: "success",
              meta: {
                source: input.source,
                profileId: profile.id,
                modelId,
                backend,
              },
            });
            return;
          } catch (error) {
            if (isRunAbortedError(error) || !isRunActive()) {
              throw error;
            }
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            const canRetryOnNextBackend = attemptIndex < backendCandidates.length - 1 && isBackendRecoverableError(error);
            logger.warn("[llm-local] backend attempt failed", {
              profileId: profile.id,
              modelId,
              backend,
              message,
              canRetryOnNextBackend,
            });
            if (!canRetryOnNextBackend) {
              throw error;
            }
          }
        }

        throw lastError ?? new Error("Generation locale impossible avec les backends disponibles.");
      };

      try {
        await runWithProfile(llmLocalModelProfile);
        throwIfRunInvalidated();
        setTelemetrySummarySafe(telemetry.exportSummary());
      } catch (error) {
        if (isRunAbortedError(error) || !isRunActive()) {
          logger.info("[llm-local] run aborted or reset requested", { runId });
          return;
        }
        const message = error instanceof Error ? error.message : String(error);

        const fallbackProfile = resolveLocalLlmFallbackProfile(llmLocalModelProfile);
        if (fallbackProfile && isLocalFallbackError(error)) {
          const fallbackModelId =
            useAsrStore.getState().llmLocalSettingsByProfile[fallbackProfile]?.modelId?.trim() ||
            resolveLocalLlmModelId(fallbackProfile);
          markStage("fallback_profile_switch", {
            fromProfile: llmLocalModelProfile,
            toProfile: fallbackProfile,
            message,
          });
          logger.warn("[llm-local] fallback to qwen after local model error", {
            fromProfile: llmLocalModelProfile,
            toProfile: fallbackProfile,
            message,
          });
          setModelProfileSafe(fallbackProfile);
          setModelIdSafe(fallbackModelId);
          setStatusSafe("preparing", "Erreur modele lourd, bascule vers Qwen 1.7B");
          setModelSizeAlertForRun({
            severity: "warning",
            title: "Modele local trop gros, bascule automatique",
            description:
              "Le profil local lourd a manque de memoire. L'application a bascule automatiquement vers Qwen 1.7B.",
          });

          try {
            await runWithProfile(fallbackProfile);
            throwIfRunInvalidated();
            setTelemetrySummarySafe(telemetry.exportSummary());
            return;
          } catch (fallbackError) {
            if (isRunAbortedError(fallbackError) || !isRunActive()) {
              logger.info("[llm-local] fallback run aborted or reset requested", { runId });
              return;
            }
            const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
            logger.error("[llm-local] fallback run failed", { message: fallbackMessage });
            setStatusSafe("error", fallbackMessage);
            if (isLocalFallbackError(fallbackError)) {
              setModelSizeAlertForRun({
                severity: "error",
                title: "Modele local trop gros pour ce poste",
                description: fallbackMessage,
              });
            }
            telemetry.logEvent("LLM_RUN_ERROR", {
              provider: "local",
              profileId: fallbackProfile,
              stage,
              message: fallbackMessage,
            });
            trackBackendActivityEvent({
              eventKind: "report",
              sourceMode: "local",
              provider: "local",
              status: "error",
              meta: {
                source: input.source,
                profileId: fallbackProfile,
                stage,
                message: fallbackMessage,
              },
            });
            setTelemetrySummarySafe(telemetry.exportSummary());
            return;
          }
        }

        logger.error("[llm-local] run failed", {
          stage,
          profileId: llmLocalModelProfile,
          modelId: llmLocalModelIdLegacy,
          message,
        });
        telemetry.logEvent("LLM_RUN_ERROR", {
          provider: "local",
          profileId: llmLocalModelProfile,
          modelId: llmLocalModelIdLegacy,
          stage,
          message,
        });
        trackBackendActivityEvent({
          eventKind: "report",
          sourceMode: "local",
          provider: "local",
          status: "error",
          meta: {
            source: input.source,
            profileId: llmLocalModelProfile,
            modelId: llmLocalModelIdLegacy,
            stage,
            message,
          },
        });
        setStatusSafe("error", message);
        if (isLocalFallbackError(error)) {
          setModelSizeAlertForRun({
            severity: "error",
            title: "Modele local trop gros pour ce poste",
            description: message,
          });
        }
        setTelemetrySummarySafe(telemetry.exportSummary());
      }
    },
    [
      isResettingSession,
      llmLocalDtypeWasmLegacy,
      llmLocalDtypeWebgpuLegacy,
      llmLocalMaxTokensLegacy,
      llmLocalModelIdLegacy,
      llmLocalModelProfile,
      llmLocalSettingsByProfile,
      llmLocalTemperatureLegacy,
      registerTelemetry,
      segments,
      setLlmLocalModelId,
      setLlmLocalModelProfile,
      setLlmLocalProgress,
      setLlmLocalResult,
      setLlmLocalResults,
      setLlmLocalStatus,
      setTelemetrySummary,
      wasmAvailable,
      webGpuSupported,
    ]
  );

  const resetSession = useCallback(async () => {
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setIsResettingSession(true);
    logger.info("[llm-local] reset requested", { runId });
    emitLlmEvent("LLM_LOCAL_RESET_REQUESTED", {
      scope: "hook",
      runId,
    });
    try {
      setLlmLocalResults({});
      setLlmLocalProgress(0);
      setLlmLocalStatus("idle", "Session réinitialisée");
      await disposeLocalGenerationPipelines();
      logger.info("[llm-local] reset completed", { runId });
      emitLlmEvent("LLM_LOCAL_RESET_DONE", {
        scope: "hook",
        runId,
      });
    } catch (error) {
      logger.error("[llm-local] reset failed", {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      emitLlmEvent("LLM_LOCAL_RESET_FAILED", {
        scope: "hook",
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      const telemetry = useAsrStore.getState().telemetryCollector;
      if (telemetry) {
        setTelemetrySummary(telemetry.exportSummary());
      } else {
        setTelemetrySummary(null);
      }
      registerTelemetry(null);
      setIsResettingSession(false);
    }
  }, [registerTelemetry, setLlmLocalProgress, setLlmLocalResults, setLlmLocalStatus, setTelemetrySummary]);

  const downloadDocx = useCallback(
    async (format: ReportResultKey) => {
      const result = results[format];
      if (!result) {
        throw new Error("Aucun resultat disponible pour ce format.");
      }
      const telemetry = useAsrStore.getState().telemetryCollector;
      logger.info("[llm-local] docx download start", {
        format: result.format,
        modelId: result.modelId,
      });
      telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
        provider: "local",
        format: result.format,
        modelId: result.modelId,
        status: "start",
      });

      setLlmLocalStatus("formatting", `Preparation DOCX ${result.format}`);
      setLlmLocalProgress(0.97);
      try {
        const blob = await buildReportDocx(result.report, {
          format: result.format,
          modelId: result.modelId,
          generatedAt: result.generatedAt,
          sourceMode: result.sourceMode,
          sourceTokenCount: result.sourceTokenCount,
        });

        const filename = formatReportDocxFilename(format, new Date(result.generatedAt));
        downloadDocxBlob(blob, filename);

        setLlmLocalStatus("done", "DOCX telecharge");
        setLlmLocalProgress(1);
        logger.info("[llm-local] docx download done", {
          format: result.format,
          modelId: result.modelId,
          filename,
        });
        telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
          provider: "local",
          format: result.format,
          modelId: result.modelId,
          filename,
          status: "done",
        });
        if (telemetry) {
          setTelemetrySummary(telemetry.exportSummary());
        }
      } catch (error) {
        logger.error("[llm-local] docx download failed", {
          format: result.format,
          modelId: result.modelId,
          message: error instanceof Error ? error.message : String(error),
        });
        telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
          provider: "local",
          format: result.format,
          modelId: result.modelId,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
        if (telemetry) {
          setTelemetrySummary(telemetry.exportSummary());
        }
        throw error;
      }
    },
    [results, setLlmLocalProgress, setLlmLocalStatus, setTelemetrySummary]
  );

  return {
    status,
    progress,
    results,
    isResettingSession,
    generateAll,
    resetSession,
    downloadDocx,
  };
}

function resolveSourceText(input: GenerateInput, segments: Array<{ text: string }>): string {
  if (input.source === "text") {
    const text = input.text?.trim() ?? "";
    if (!text) {
      throw new Error("Saisissez un texte source avant de generer.");
    }
    return text;
  }

  const fromSegments = segments
    .map((segment) => segment.text?.trim())
    .filter((text): text is string => Boolean(text && text.length > 0))
    .join("\n");

  if (!fromSegments) {
    throw new Error("Aucune transcription disponible dans la session.");
  }

  return fromSegments;
}

function isLocalFallbackError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("bad_alloc") ||
    normalized.includes("out of memory") ||
    normalized.includes("memory") ||
    normalized.includes("failed to call ortrun")
  );
}

function isBackendRecoverableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    isLocalFallbackError(error) ||
    normalized.includes("webgpu") ||
    normalized.includes("wasm") ||
    normalized.includes("backend") ||
    normalized.includes("execution provider") ||
    normalized.includes("gpu") ||
    normalized.includes("adapter")
  );
}

function isRunAbortedError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase().includes("run invalidated");
}
