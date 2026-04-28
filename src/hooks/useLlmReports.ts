import { useCallback } from "react";
import { useAsrStore, type LlmApiProvider } from "@/store/asr-store";
import { TelemetryCollector } from "@/lib/telemetry";
import {
  reportFormatToKey,
  type ReportJson,
  type ReportFormat,
  type ReportResultKey,
  type ReportResult,
} from "@/lib/llm/reportSchema";
import {
  buildLongInputChunkPrompt,
  buildLongInputConsolidationPrompt,
  buildReportFormatLabel,
} from "@/lib/llm/reportPrompts";
import {
  buildCrnTranscriptBatches,
  mergeCrnReportResults,
} from "@/lib/llm/crnBatchPipeline";
import { generateReportDetailed, type GenerateReportDetailedResult } from "@/lib/llm/reportService";
import { getLlmHfClient, generateWithChatThenFallbackText } from "@/lib/llm/hfClient";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";
import { generateWithDemeterChat } from "@/lib/llm/demeterChatClient";
import { resolveCloudRunStageDescriptor } from "@/lib/llm/reportTrace";
import { backendRefresh, isBackendSessionExpiredError } from "@/lib/backend-auth";
import {
  FALLBACK_MISTRAL_MAX_TOKENS,
  fetchMistralModelsSafe,
  findMistralModelMetadata,
  resolveMistralMaxTokens,
} from "@/lib/llm/mistralModelsClient";
import { prepareLongInputForReports } from "@/lib/llm/longInputPipeline";
import { buildReportDocx, downloadDocxBlob, formatReportDocxFilename } from "@/lib/docx/reportDocx";
import { estimateTokenCount } from "@/lib/tokens";
import {
  formatTokenCount,
  resolveLongInputChunkingProfile,
  resolveModelTokenBudget,
  type RuntimeModelLimits,
} from "@/lib/llm/modelCatalog";
import type { ReportDetailLevel } from "@/lib/llm/reportDetail";
import { resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";
import {
  getSessionTranscriptText,
  type SessionTranscriptMemoryEntry,
  type SessionTranscriptMode,
} from "@/lib/sessionTranscriptMemory";
import logger from "@/lib/logger";
import {
  formatBackendErrorMessage,
  isBackendForbiddenError,
  isBackendUnauthorizedError,
} from "@/lib/backend-api";
import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";
import { trackBackendPerformanceSummary } from "@/lib/backend-performance-sync";

const FORMAT_ORDER: Array<{ key: ReportResultKey; format: ReportFormat }> = [
  { key: "cri", format: "CRI" },
  { key: "cro", format: "CRO" },
  { key: "crs", format: "CRS" },
  { key: "crn", format: "CRN" },
];

type GenerateInput =
  | { source: "transcription"; transcriptMode: SessionTranscriptMode; sourceText?: string }
  | { source: "text"; text?: string };

type UseLlmReportsOptions = {
  providerOverride?: LlmApiProvider;
};

export function useLlmReports(options: UseLlmReportsOptions = {}) {
  const sessionTranscriptMemories = useAsrStore((state) => state.sessionTranscriptMemories);

  const hfApiToken = useAsrStore((state) => state.hfApiToken);
  const llmApiProvider = useAsrStore((state) => state.llmApiProvider);
  const llmApiHfModelId = useAsrStore((state) => state.llmApiHfModelId);
  const llmApiHfTemperature = useAsrStore((state) => state.llmApiHfTemperature);
  const llmApiHfMaxTokens = useAsrStore((state) => state.llmApiHfMaxTokens);
  const llmApiMistralModelId = useAsrStore((state) => state.llmApiMistralModelId);
  const llmApiMistralTemperature = useAsrStore((state) => state.llmApiMistralTemperature);
  const llmApiMistralMaxTokens = useAsrStore((state) => state.llmApiMistralMaxTokens);
  const llmApiReportDetailLevels = useAsrStore((state) => state.llmApiReportDetailLevels);
  const llmApiReportEnabledFormats = useAsrStore((state) => state.llmApiReportEnabledFormats);
  const llmApiReportChunkRatio = useAsrStore((state) => state.llmApiReportChunkRatio);
  const llmApiReportMonoPassMaxTokens = useAsrStore((state) => state.llmApiReportMonoPassMaxTokens);
  const mistralApiKey = useAsrStore((state) => state.mistralApiKey);
  const cloudMistralApiUrl = useAsrStore((state) => state.cloudMistralApiUrl);

  const status = useAsrStore((state) => state.llmApiStatus);
  const progress = useAsrStore((state) => state.llmApiProgress);
  const results = useAsrStore((state) => state.llmApiResults);
  const reportDrafts = useAsrStore((state) => state.llmApiReportDrafts);

  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const setLlmApiProgress = useAsrStore((state) => state.setLlmApiProgress);
  const setLlmApiResult = useAsrStore((state) => state.setLlmApiResult);
  const setLlmApiResults = useAsrStore((state) => state.setLlmApiResults);
  const resetLlmApiReportDrafts = useAsrStore((state) => state.resetLlmApiReportDrafts);
  const registerTelemetry = useAsrStore((state) => state.registerTelemetry);
  const setTelemetrySummary = useAsrStore((state) => state.setTelemetrySummary);
  const effectiveProvider = options.providerOverride ?? llmApiProvider;

  const generateAll = useCallback(
    async (input: GenerateInput) => {
      const activePipelineConfig = resolveActiveLlmPipelineConfig(
        {
          llmApiHfModelId,
          llmApiHfTemperature,
          llmApiHfMaxTokens,
          llmApiMistralModelId,
          llmApiMistralTemperature,
          llmApiMistralMaxTokens,
        },
        effectiveProvider
      );
      const telemetry = new TelemetryCollector();
      registerTelemetry(telemetry);
      setTelemetrySummary(null);
      telemetry.startTimer("llm_cloud_total");
      let stage = "init";
      const provider = effectiveProvider;
      const sourceMode = input.source;
      const activeModelId = activePipelineConfig.modelId.trim() || "unset";
      const activeFormatOrder = FORMAT_ORDER.filter((item) => llmApiReportEnabledFormats[item.format]);
      const formatOrder = activeFormatOrder.map((item) => item.format);
      if (!activeFormatOrder.length) {
        const message = "Activez au moins un format de compte rendu avant de lancer la génération.";
        setLlmApiStatus("error", message);
        setLlmApiProgress(0);
        telemetry.stopTimer("llm_cloud_total");
        return;
      }
      let lastStageLabel = stage;
      let lastGlobalPassIndex = 1;
      let lastGlobalPassTotal = 1;
      const markStage = (
        nextStage: string,
        data?: Record<string, unknown>,
        context?: {
          format: ReportFormat;
          detailLevel: string;
          generationMode: string;
          sequenceIndex: number;
        }
      ) => {
        stage = nextStage;
        const descriptor = resolveCloudRunStageDescriptor(nextStage, data, {
          provider,
          modelId: activeModelId,
          sourceMode,
          format: context?.format,
          detailLevel: context?.detailLevel,
          generationMode: context?.generationMode,
          sequenceIndex: context?.sequenceIndex,
          sequenceTotal: activeFormatOrder.length,
        });
        lastStageLabel = descriptor.stageLabel;
        lastGlobalPassIndex = descriptor.globalPassIndex;
        lastGlobalPassTotal = descriptor.globalPassTotal;
        telemetry.logEvent("LLM_RUN_STAGE", descriptor.telemetryData);
        logger.info(descriptor.consoleMessage, descriptor.consoleContext);
      };
      const publishTelemetrySummary = (status: "success" | "error", meta?: Record<string, unknown>) => {
        telemetry.stopTimer("llm_cloud_total");
        const summary = telemetry.exportSummary();
        setTelemetrySummary(summary);
        trackBackendPerformanceSummary(summary, {
          status,
          route: "/llmapi",
          meta: {
            provider,
            sourceMode,
            modelId: activeModelId,
            ...(meta ?? {}),
          },
        });
      };

      try {
        const hfToken = hfApiToken.trim();
        const mistralKey = mistralApiKey.trim();
        const mistralApiUrl = cloudMistralApiUrl.trim();
        const pipelineConfig = activePipelineConfig;
        const modelId = pipelineConfig.modelId.trim();
        const temperature = pipelineConfig.temperature;
        telemetry.logEvent("LLM_RUN_START", {
          provider,
          sourceMode,
          modelId: modelId || "unset",
          formatOrder,
        });
        logger.info("[llm-api] run start", {
          provider,
          sourceMode,
          modelId: modelId || "unset",
          formatOrder,
        });

        if (provider === "huggingface" && !hfToken) {
          throw new Error("Renseignez un token Hugging Face.");
        }
        if (provider === "mistral" && !mistralKey) {
          throw new Error("Renseignez une cle API Mistral.");
        }

        if (!modelId) {
          throw new Error("Renseignez un model ID.");
        }

        const sourceText = resolveSourceText(input, sessionTranscriptMemories);
        resetLlmApiReportDrafts();
        setLlmApiResults({});
        markStage("source_resolved", {
          sourceLength: sourceText.length,
          sourceTokenEstimate: estimateTokenCount(sourceText),
        });

        let runtimeLimits: RuntimeModelLimits | undefined;
        let configuredMaxTokens = pipelineConfig.maxTokens;
        if (provider === "mistral") {
          configuredMaxTokens = Math.max(FALLBACK_MISTRAL_MAX_TOKENS, configuredMaxTokens);
          const models = await fetchMistralModelsSafe({
            apiUrl: mistralApiUrl,
            apiKey: mistralKey,
          });
          const modelMetadata = findMistralModelMetadata(models, modelId);
          if (modelMetadata?.maxContextTokens) {
            runtimeLimits = {
              contextWindowTokens: modelMetadata.maxContextTokens,
            };
            configuredMaxTokens = resolveMistralMaxTokens(modelMetadata);
          }
          markStage("mistral_model_metadata", {
            modelKnown: Boolean(modelMetadata),
            contextWindowTokens: modelMetadata?.maxContextTokens ?? null,
            configuredMaxTokens,
          });
        }

        const chunkingProfile = resolveLongInputChunkingProfile({
          modelId,
          configuredMaxTokens,
          runtimeLimits,
        });
        markStage("chunking_profile_resolved", {
          thresholdTokens: chunkingProfile.thresholdTokens,
          chunkTokens: chunkingProfile.chunkTokens,
          chunkOverlapTokens: chunkingProfile.chunkOverlapTokens,
        });

        setLlmApiStatus("preparing", "Préparation de la source");
        setLlmApiProgress(0.02);
        markStage("prepare_long_input_start");

        const hfClient = provider === "huggingface" ? await getLlmHfClient(hfToken) : null;

        const generateText = async (params: {
          systemPrompt: string;
          userPrompt: string;
          temperature: number;
          maxTokens: number;
          responseMode: "json" | "text";
        }) => {
          if (provider === "huggingface") {
            const generation = await generateWithChatThenFallbackText({
              client: hfClient!,
              modelId,
              systemPrompt: params.systemPrompt,
              userPrompt: params.userPrompt,
              temperature: params.temperature,
              maxTokens: params.maxTokens,
              responseMode: params.responseMode,
            });
            return generation.text;
          }

          const generation =
            provider === "mistral"
              ? await generateWithMistralChat({
                  apiUrl: mistralApiUrl,
                  apiKey: mistralKey,
                  modelId,
                  systemPrompt: params.systemPrompt,
                  userPrompt: params.userPrompt,
                  temperature: params.temperature,
                  maxTokens: params.maxTokens,
                  responseMode: params.responseMode,
                })
              : await generateWithDemeterChat({
                  modelId,
                  systemPrompt: params.systemPrompt,
                  userPrompt: params.userPrompt,
                  temperature: params.temperature,
                  maxTokens: params.maxTokens,
                  responseMode: params.responseMode,
                });
          return generation.text;
        };

        const generateCrnTranscriptReport = async (params: {
          detailLevel: ReportDetailLevel;
          reportMaxTokens: number;
          sequenceIndex: number;
          totalFormats: number;
        }): Promise<{
          report: ReportJson;
          rawResponse: string;
          strategy: GenerateReportDetailedResult["strategy"];
          pipelinePasses: number;
        }> => {
          const batches = buildCrnTranscriptBatches(sourceText, {
            linesPerBatch: 25,
            overlapLines: 0,
          });

          if (!batches.length) {
            throw new Error("Aucune transcription disponible dans la session.");
          }

          const largestBatchTokenCount = batches.reduce(
            (maxTokenCount, batch) => Math.max(maxTokenCount, estimateTokenCount(batch.text)),
            0
          );
          const batchTokenBudget = resolveModelTokenBudget({
            modelId,
            sourceTokens: largestBatchTokenCount,
            runtimeLimits,
          });
          if (batchTokenBudget.blockedByContext) {
            throw new Error(
              `Un lot CRN dépasse le contexte maximal pour ${modelId}. Contexte max : ${formatTokenCount(
                batchTokenBudget.contextWindowTokens ?? 0
              )} tokens.`
            );
          }

          const batchSpecs = batches.map((batch, batchIndex) => {
            const batchNumber = batchIndex + 1;
            const batchLabel = `CRN ${batchNumber}/${batches.length}`;
            const batchSourceTokenCount = estimateTokenCount(batch.text);
            const perBatchBudget = resolveModelTokenBudget({
              modelId,
              sourceTokens: batchSourceTokenCount,
              runtimeLimits,
            });

            if (perBatchBudget.blockedByContext) {
              throw new Error(
                `Le lot ${batchLabel} dépasse le contexte maximal pour ${modelId}. Contexte max : ${formatTokenCount(
                  perBatchBudget.contextWindowTokens ?? 0
                )} tokens.`
              );
            }

            return {
              batch,
              batchNumber,
              batchLabel,
              batchSourceTokenCount,
            };
          });

          stage = "crn_batch_generation";
          lastStageLabel = "Lots CRN en parallèle";
          lastGlobalPassIndex = 1;
          lastGlobalPassTotal = batches.length;
          setLlmApiStatus("generating", `Lancement parallèle des ${batchSpecs.length} lots CRN`);
          setLlmApiProgress(0.5);

          let finishedCount = 0;
          const totalBatches = batchSpecs.length;
          const demeterPollTimeoutMs = Math.max(90 * 60_000, totalBatches * 15_000);
          const updateParallelProgress = () => {
            finishedCount += 1;
            const nextProgress = Math.min(0.94, 0.5 + (finishedCount / totalBatches) * 0.4);
            setLlmApiProgress(nextProgress);
            setLlmApiStatus("generating", `${finishedCount}/${totalBatches} lots CRN terminés`);
          };

          const runBatchTask = async (batchSpec: (typeof batchSpecs)[number]) => {
            const { batch, batchNumber, batchLabel, batchSourceTokenCount } = batchSpec;

            logger.info("[llm-api] CRN batch generation start", {
              provider,
              modelId,
              batchLabel,
              sequenceIndex: params.sequenceIndex,
              sequenceTotal: params.totalFormats,
              startLine: batch.startLine + 1,
              endLine: batch.endLine,
              batchLineCount: batch.lines.length,
              batchTokenCount: batchSourceTokenCount,
            });

            try {
              let batchGeneration: GenerateReportDetailedResult;
              if (provider === "huggingface") {
                batchGeneration = await generateReportDetailed({
                  provider: "huggingface",
                  format: "CRN",
                  modelId,
                  sourceText: batch.text,
                  temperature,
                  maxTokens: params.reportMaxTokens,
                  detailLevel: params.detailLevel,
                  hfToken,
                });
              } else if (provider === "mistral") {
                batchGeneration = await generateReportDetailed({
                  provider: "mistral",
                  format: "CRN",
                  modelId,
                  sourceText: batch.text,
                  temperature,
                  maxTokens: params.reportMaxTokens,
                  detailLevel: params.detailLevel,
                  mistralApiKey: mistralKey,
                  mistralApiUrl,
                });
              } else {
                batchGeneration = await generateReportDetailed({
                  provider: "demeter_sante",
                  format: "CRN",
                  modelId,
                  sourceText: batch.text,
                  temperature,
                  maxTokens: params.reportMaxTokens,
                  detailLevel: params.detailLevel,
                  pollTimeoutMs: demeterPollTimeoutMs,
                });
              }

              logger.info("[llm-api] CRN batch generation done", {
                provider,
                modelId,
                batchLabel,
                sequenceIndex: params.sequenceIndex,
                sequenceTotal: params.totalFormats,
                outputLength: batchGeneration.rawResponse.length,
              });
              return batchGeneration;
            } catch (error) {
              const taskError = error instanceof Error ? error : new Error(String(error));
              (taskError as Error & {
                format?: ReportFormat;
                detailLevel?: string;
                generationMode?: string;
                sequenceIndex?: number;
                batchLabel?: string;
                batchIndex?: number;
              }).batchLabel = batchLabel;
              (taskError as Error & {
                format?: ReportFormat;
                detailLevel?: string;
                generationMode?: string;
                sequenceIndex?: number;
                batchLabel?: string;
                batchIndex?: number;
              }).batchIndex = batchNumber;
              logger.error("[llm-api] CRN batch generation failed", {
                provider,
                modelId,
                batchLabel,
                sequenceIndex: params.sequenceIndex,
                sequenceTotal: params.totalFormats,
                message: taskError.message,
              });
              throw taskError;
            } finally {
              updateParallelProgress();
            }
          };

          const batchResults = await Promise.allSettled(batchSpecs.map((batchSpec) => runBatchTask(batchSpec)));
          const failedBatch = batchResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected"
          );
          if (failedBatch) {
            throw failedBatch.reason;
          }

          const batchGenerations = batchResults.map((result) => {
            if (result.status === "rejected") {
              throw result.reason;
            }
            return result.value;
          });

          const mergedReport = mergeCrnReportResults(batchGenerations.map((generation) => generation.report));
          const mergedRawResponse = JSON.stringify(mergedReport);
          return {
            report: mergedReport,
            rawResponse: mergedRawResponse,
            strategy: batchGenerations[batchGenerations.length - 1]?.strategy ?? "chatCompletion",
            pipelinePasses: prepared.pipelinePasses + batches.length - 1,
          };
        };

        const prepared = await prepareLongInputForReports({
          sourceText,
          thresholdTokens: chunkingProfile.thresholdTokens,
          chunkTokens: chunkingProfile.chunkTokens,
          chunkOverlapTokens: chunkingProfile.chunkOverlapTokens,
          chunkRatio: llmApiReportChunkRatio,
          onProgress: (p, detail) => {
            setLlmApiStatus("preparing", detail);
            setLlmApiProgress(Math.min(0.45, 0.04 + p * 0.5));
          },
          summarizeChunk: async (chunkText, chunkIndex, chunkCount) => {
            const prompts = buildLongInputChunkPrompt(chunkText, chunkIndex, chunkCount);
            return generateText({
              systemPrompt: prompts.systemPrompt,
              userPrompt: prompts.userPrompt,
              temperature: 0,
              maxTokens: Math.min(1400, configuredMaxTokens),
              responseMode: "text",
            });
          },
          consolidateSummaries: async (chunkSummaries) => {
            const prompts = buildLongInputConsolidationPrompt(chunkSummaries);
            return generateText({
              systemPrompt: prompts.systemPrompt,
              userPrompt: prompts.userPrompt,
              temperature: 0,
              maxTokens: Math.min(2200, configuredMaxTokens),
              responseMode: "text",
            });
          },
        });
        markStage("prepare_long_input_done", {
          pipelinePasses: prepared.pipelinePasses,
          chunkCount: prepared.chunkCount,
          preparedLength: prepared.text.length,
          preparedTokenEstimate: estimateTokenCount(prepared.text),
        });

        const requiresMonoPassGeneration = true;
        const sourceTokensForGeneration = estimateTokenCount(prepared.text);
        const tokenBudget = requiresMonoPassGeneration
          ? resolveModelTokenBudget({
              modelId,
              sourceTokens: sourceTokensForGeneration,
              runtimeLimits,
            })
          : {
              blockedByContext: false,
              contextWindowTokens: runtimeLimits?.contextWindowTokens ?? null,
              effectiveMaxGenerationTokens: configuredMaxTokens,
            };
        if (requiresMonoPassGeneration && tokenBudget.blockedByContext) {
          throw new Error(
            `Source trop longue pour ${modelId}. Contexte max : ${formatTokenCount(
              tokenBudget.contextWindowTokens ?? 0
            )} tokens.`
          );
        }
        const requestedMaxTokens = configuredMaxTokens;
        const effectiveGenerationMaxTokens =
          typeof tokenBudget.effectiveMaxGenerationTokens === "number"
            ? Math.min(requestedMaxTokens, tokenBudget.effectiveMaxGenerationTokens)
            : requestedMaxTokens;
        const monoPassReportMaxTokens = Math.min(effectiveGenerationMaxTokens, llmApiReportMonoPassMaxTokens);
        if (monoPassReportMaxTokens < requestedMaxTokens) {
          setLlmApiStatus("preparing", "Max tokens ajustés selon le modèle et les réglages détaillés");
        }

        markStage("token_budget_resolved", {
          contextWindowTokens: tokenBudget.contextWindowTokens ?? null,
          effectiveMaxGenerationTokens: tokenBudget.effectiveMaxGenerationTokens ?? null,
          monoPassMaxTokens: llmApiReportMonoPassMaxTokens,
          monoPassReportMaxTokens,
          requiresMonoPassGeneration,
        });

        markStage("report_sequence_start", {
          formatOrder,
          totalFormats: activeFormatOrder.length,
        });
        setLlmApiStatus(
          "generating",
          `Lancement parallèle des ${activeFormatOrder.length} comptes rendus`
        );
        setLlmApiProgress(0.5);

        let finishedCount = 0;
        const totalFormats = activeFormatOrder.length;
        const updateParallelProgress = () => {
          finishedCount += 1;
          const nextProgress = Math.min(0.95, 0.5 + (finishedCount / totalFormats) * 0.45);
          setLlmApiProgress(nextProgress);
          setLlmApiStatus("generating", `${finishedCount}/${totalFormats} comptes rendus terminés`);
        };

        const runFormatTask = async (item: (typeof FORMAT_ORDER)[number], sequenceIndex: number) => {
          const detailLevel = llmApiReportDetailLevels[item.format];
          const generationMode = "mono_pass";
          const reportMaxTokens = monoPassReportMaxTokens;
          const taskContext = {
            format: item.format,
            detailLevel,
            generationMode,
            sequenceIndex,
          };
          const emitTaskStage = (nextStage: string, data?: Record<string, unknown>) => {
            const descriptor = resolveCloudRunStageDescriptor(nextStage, data, {
              provider,
              modelId: activeModelId,
              sourceMode,
              format: taskContext.format,
              detailLevel: taskContext.detailLevel,
              generationMode: taskContext.generationMode,
              sequenceIndex: taskContext.sequenceIndex,
              sequenceTotal: totalFormats,
            });
            lastStageLabel = descriptor.stageLabel;
            lastGlobalPassIndex = descriptor.globalPassIndex;
            lastGlobalPassTotal = descriptor.globalPassTotal;
            telemetry.logEvent("LLM_RUN_STAGE", descriptor.telemetryData);
            logger.info(descriptor.consoleMessage, descriptor.consoleContext);
          };
          logger.debug("[llm-api] format generation start", {
            format: item.format,
            detailLevel,
            generationMode,
            sequenceIndex,
            totalFormats,
          });
          emitTaskStage("format_generation_start", {
            format: item.format,
            detailLevel,
            generationMode,
            sequenceIndex,
            sequenceTotal: totalFormats,
            totalFormats,
          });
          try {
            let generation: GenerateReportDetailedResult;
            let pipelinePasses: number = prepared.pipelinePasses;
            if (sourceMode === "transcription" && item.format === "CRN") {
              const crnGeneration = await generateCrnTranscriptReport({
                detailLevel,
                reportMaxTokens,
                sequenceIndex,
                totalFormats,
              });
              generation = {
                report: crnGeneration.report,
                rawResponse: crnGeneration.rawResponse,
                strategy: crnGeneration.strategy,
              };
              pipelinePasses = crnGeneration.pipelinePasses;
            } else if (provider === "huggingface") {
              generation = await generateReportDetailed({
                provider: "huggingface",
                format: item.format,
                modelId,
                sourceText: prepared.text,
                temperature,
                maxTokens: reportMaxTokens,
                detailLevel,
                hfToken,
              });
            } else if (provider === "mistral") {
              generation = await generateReportDetailed({
                provider: "mistral",
                format: item.format,
                modelId,
                sourceText: prepared.text,
                temperature,
                maxTokens: reportMaxTokens,
                detailLevel,
                mistralApiKey: mistralKey,
                mistralApiUrl,
              });
            } else {
              generation = await generateReportDetailed({
                provider: "demeter_sante",
                format: item.format,
                modelId,
                sourceText: prepared.text,
                temperature,
                maxTokens: reportMaxTokens,
                detailLevel,
              });
            }

            const result: ReportResult = {
              format: item.format,
              report: generation.report,
              rawResponse: generation.rawResponse,
              modelId,
              generatedAt: new Date().toISOString(),
              sourceMode: input.source,
              sourceTokenCount: estimateTokenCount(sourceText),
              pipelinePasses,
              strategy: generation.strategy,
              detailLevel,
            };

            setLlmApiResult(reportFormatToKey(item.format), result);
            logger.debug("[llm-api] format generation done", {
              format: item.format,
              detailLevel,
              generationMode,
              sequenceIndex,
              totalFormats,
              sectionCount: result.report.sections.length,
              outputLength: result.rawResponse.length,
              pipelinePasses: result.pipelinePasses,
            });
            emitTaskStage("format_generation_done", {
              format: item.format,
              detailLevel,
              generationMode,
              sequenceIndex,
              sequenceTotal: totalFormats,
              sectionCount: result.report.sections.length,
              outputLength: result.rawResponse.length,
              pipelinePasses: result.pipelinePasses,
            });
            return result;
          } catch (error) {
            const taskError = error instanceof Error ? error : new Error(String(error));
            (taskError as Error & {
              format?: ReportFormat;
              detailLevel?: string;
              generationMode?: string;
              sequenceIndex?: number;
            }).format = item.format;
            (taskError as Error & {
              format?: ReportFormat;
              detailLevel?: string;
              generationMode?: string;
              sequenceIndex?: number;
            }).detailLevel = detailLevel;
            (taskError as Error & {
              format?: ReportFormat;
              detailLevel?: string;
              generationMode?: string;
              sequenceIndex?: number;
            }).generationMode = generationMode;
            (taskError as Error & {
              format?: ReportFormat;
              detailLevel?: string;
              generationMode?: string;
              sequenceIndex?: number;
            }).sequenceIndex = sequenceIndex;
            logger.error("[llm-api] format generation failed", {
              format: item.format,
              detailLevel,
              generationMode,
              sequenceIndex,
              totalFormats,
              provider,
              modelId,
              sourceMode,
              message: taskError.message,
            });
            throw taskError;
          } finally {
            updateParallelProgress();
          }
        };

        const taskResults = await Promise.allSettled(
          activeFormatOrder.map((item, index) => runFormatTask(item, index + 1))
        );
        const failedTask = taskResults.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failedTask) {
          throw failedTask.reason;
        }

        setLlmApiStatus("done", "Génération terminée");
        setLlmApiProgress(1);
        telemetry.logEvent("LLM_RUN_DONE", {
          provider,
          modelId,
          sourceMode,
          formatCount: FORMAT_ORDER.length,
          formatOrder,
        });
        logger.info("[llm-api] run done", {
          provider,
          modelId,
          sourceMode,
          formatCount: FORMAT_ORDER.length,
          formatOrder,
        });
        trackBackendActivityEvent({
          eventKind: "report",
          sourceMode: resolveLlmActivitySourceMode(provider),
          provider,
          status: "success",
          meta: {
            source: sourceMode,
            modelId: modelId || "unset",
          },
        });
        publishTelemetrySummary("success", {
          modelId,
          sourceMode,
        });
      } catch (error) {
        if (isBackendSessionExpiredError(error)) {
          telemetry.stopTimer("llm_cloud_total");
          setLlmApiProgress(0);
          setLlmApiStatus("idle", "Session expirée");
          return;
        }
        const unauthorized = isBackendUnauthorizedError(error);
        const forbidden = isBackendForbiddenError(error);
        if (unauthorized) {
          logger.info("[llm-api] unauthorized, attempting refresh before final error handling");
          const refreshResult = await backendRefresh();
          if (refreshResult === "expired") {
            telemetry.stopTimer("llm_cloud_total");
            setLlmApiProgress(0);
            setLlmApiStatus("idle", "Session expirée");
            return;
          }
          if (refreshResult === "failed") {
            logger.debug("[llm-api] refresh request failed");
          }
        }
        const message =
          unauthorized || forbidden
            ? formatBackendErrorMessage(error)
            : error instanceof Error
              ? error.message
              : "Erreur inconnue lors de la génération";
        if (unauthorized || forbidden) {
          telemetry.stopTimer("llm_cloud_total");
        }
        logger.error("[llm-api] run failed", {
          stage,
          stageLabel: lastStageLabel,
          globalPassIndex: lastGlobalPassIndex,
          globalPassTotal: lastGlobalPassTotal,
          message,
          provider,
          modelId: activeModelId,
          sourceMode,
          ...extractReportGenerationErrorContext(error),
        });
        telemetry.logEvent("LLM_RUN_ERROR", {
          stage,
          stageLabel: lastStageLabel,
          globalPassIndex: lastGlobalPassIndex,
          globalPassTotal: lastGlobalPassTotal,
          message,
          provider,
          modelId: activeModelId,
          sourceMode,
          ...extractReportGenerationErrorContext(error),
        });
        trackBackendActivityEvent({
          eventKind: "report",
          sourceMode: resolveLlmActivitySourceMode(provider),
          provider,
          status: "error",
          meta: {
            source: sourceMode,
            stage,
            message,
            modelId: activeModelId,
          },
        });
        publishTelemetrySummary("error", {
          modelId: activeModelId,
          sourceMode,
          stage,
          message,
        });
        setLlmApiStatus("error", message);
      }
    },
    [
      mistralApiKey,
      cloudMistralApiUrl,
      effectiveProvider,
      hfApiToken,
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiHfMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiMistralMaxTokens,
      llmApiReportDetailLevels,
      llmApiReportEnabledFormats,
      llmApiReportChunkRatio,
      llmApiReportMonoPassMaxTokens,
      registerTelemetry,
      sessionTranscriptMemories,
      setLlmApiProgress,
      setLlmApiResult,
      setLlmApiResults,
      setLlmApiStatus,
      setTelemetrySummary,
      resetLlmApiReportDrafts,
    ]
  );

  const downloadDocx = useCallback(
    async (format: ReportResultKey) => {
      const result = results[format];
      if (!result) {
        throw new Error("Aucun résultat disponible pour ce format.");
      }
      const report = reportDrafts[format] ?? result.report;
      const telemetry = useAsrStore.getState().telemetryCollector;
      logger.info("[llm-api] docx download start", {
        format: result.format,
        modelId: result.modelId,
      });
      telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
        format: result.format,
        modelId: result.modelId,
        status: "start",
      });

      setLlmApiStatus("formatting", `Préparation DOCX ${buildReportFormatLabel(result.format)}`);
      setLlmApiProgress(0.97);
      try {
        const blob = await buildReportDocx(report, {
          format: result.format,
          modelId: result.modelId,
          generatedAt: result.generatedAt,
          sourceMode: result.sourceMode,
          sourceTokenCount: result.sourceTokenCount,
          detailLevel: result.detailLevel,
        });
        const filename = formatReportDocxFilename(format, new Date(result.generatedAt), result.detailLevel);
        downloadDocxBlob(blob, filename);

        setLlmApiStatus("done", "DOCX téléchargé");
        setLlmApiProgress(1);
        logger.info("[llm-api] docx download done", {
          format: result.format,
          modelId: result.modelId,
          filename,
        });
        telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
          format: result.format,
          modelId: result.modelId,
          filename,
          status: "done",
        });
        if (telemetry) {
          setTelemetrySummary(telemetry.exportSummary());
        }
      } catch (error) {
        logger.error("[llm-api] docx download failed", {
          format: result.format,
          modelId: result.modelId,
          message: error instanceof Error ? error.message : String(error),
        });
        telemetry?.logEvent("LLM_DOCX_DOWNLOAD", {
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
    [reportDrafts, results, setLlmApiProgress, setLlmApiStatus, setTelemetrySummary]
  );

  return {
    status,
    progress,
    results,
    generateAll,
    downloadDocx,
  };
}

function resolveSourceText(
  input: GenerateInput,
  sessionTranscriptMemories: Record<SessionTranscriptMode, SessionTranscriptMemoryEntry | null>
): string {
  if (input.source === "text") {
    const text = input.text?.trim() ?? "";
    if (!text) {
      throw new Error("Saisissez un texte source avant de generer.");
    }
    return text;
  }

  const providedSourceText = input.sourceText?.trim() ?? "";
  if (providedSourceText.length > 0) {
    return providedSourceText;
  }

  const entry = sessionTranscriptMemories[input.transcriptMode];
  const fromSegments = entry ? getSessionTranscriptText(entry) : "";

  if (!fromSegments) {
    throw new Error("Aucune transcription disponible dans la session.");
  }

  return fromSegments;
}

function resolveLlmActivitySourceMode(provider: string): "cloud_direct" | "cloud_backend" {
  return provider === "demeter_sante" ? "cloud_backend" : "cloud_direct";
}

function extractReportGenerationErrorContext(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return {};
  }
  const candidate = error as {
    format?: ReportFormat;
    detailLevel?: string;
    generationMode?: string;
    sequenceIndex?: number;
    batchLabel?: string;
    batchIndex?: number;
  };
  const context: Record<string, unknown> = {};
  if (candidate.format) context.format = candidate.format;
  if (candidate.detailLevel) context.detailLevel = candidate.detailLevel;
  if (candidate.generationMode) context.generationMode = candidate.generationMode;
  if (typeof candidate.sequenceIndex === "number") context.sequenceIndex = candidate.sequenceIndex;
  if (candidate.batchLabel) context.batchLabel = candidate.batchLabel;
  if (typeof candidate.batchIndex === "number") context.batchIndex = candidate.batchIndex;
  return context;
}
