import { useCallback } from "react";
import { useAsrStore } from "@/store/asr-store";
import { TelemetryCollector } from "@/lib/telemetry";
import {
  reportFormatToKey,
  type ReportFormat,
  type ReportResultKey,
  type ReportResult,
} from "@/lib/llm/reportSchema";
import { buildLongInputChunkPrompt, buildLongInputConsolidationPrompt } from "@/lib/llm/reportPrompts";
import { generateReportDetailed } from "@/lib/llm/reportService";
import { getLlmHfClient, generateWithChatThenFallbackText } from "@/lib/llm/hfClient";
import { generateWithMistralChat } from "@/lib/llm/mistralChatClient";
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
import { resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";
import logger from "@/lib/logger";

const FORMAT_ORDER: Array<{ key: ReportResultKey; format: ReportFormat }> = [
  { key: "cri", format: "CRI" },
  { key: "cro", format: "CRO" },
  { key: "crs", format: "CRS" },
];

type GenerateInput = { source: "transcription" | "text"; text?: string };

export function useLlmReports() {
  const segments = useAsrStore((state) => state.segments);

  const hfApiToken = useAsrStore((state) => state.hfApiToken);
  const llmApiProvider = useAsrStore((state) => state.llmApiProvider);
  const llmApiHfModelId = useAsrStore((state) => state.llmApiHfModelId);
  const llmApiHfTemperature = useAsrStore((state) => state.llmApiHfTemperature);
  const llmApiHfMaxTokens = useAsrStore((state) => state.llmApiHfMaxTokens);
  const llmApiMistralModelId = useAsrStore((state) => state.llmApiMistralModelId);
  const llmApiMistralTemperature = useAsrStore((state) => state.llmApiMistralTemperature);
  const llmApiMistralMaxTokens = useAsrStore((state) => state.llmApiMistralMaxTokens);
  const mistralApiKey = useAsrStore((state) => state.mistralApiKey);
  const cloudMistralApiUrl = useAsrStore((state) => state.cloudMistralApiUrl);

  const status = useAsrStore((state) => state.llmApiStatus);
  const progress = useAsrStore((state) => state.llmApiProgress);
  const results = useAsrStore((state) => state.llmApiResults);

  const setLlmApiStatus = useAsrStore((state) => state.setLlmApiStatus);
  const setLlmApiProgress = useAsrStore((state) => state.setLlmApiProgress);
  const setLlmApiResult = useAsrStore((state) => state.setLlmApiResult);
  const setLlmApiResults = useAsrStore((state) => state.setLlmApiResults);
  const registerTelemetry = useAsrStore((state) => state.registerTelemetry);
  const setTelemetrySummary = useAsrStore((state) => state.setTelemetrySummary);

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
        llmApiProvider
      );
      const telemetry = new TelemetryCollector();
      registerTelemetry(telemetry);
      setTelemetrySummary(null);
      let stage = "init";
      const provider = llmApiProvider;
      const sourceMode = input.source;
      const activeModelId = activePipelineConfig.modelId.trim() || "unset";
      const markStage = (nextStage: string, data?: Record<string, unknown>) => {
        stage = nextStage;
        telemetry.logEvent("LLM_RUN_STAGE", {
          stage: nextStage,
          provider,
          modelId: activeModelId,
          sourceMode,
          ...(data ?? {}),
        });
        logger.info("[llm-api] stage", {
          stage: nextStage,
          provider,
          modelId: activeModelId,
          sourceMode,
          ...(data ?? {}),
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
        });
        logger.info("[llm-api] run start", {
          provider,
          sourceMode,
          modelId: modelId || "unset",
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

        const sourceText = resolveSourceText(input, segments);
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

        setLlmApiResults({});
        setLlmApiStatus("preparing", "Preparation de la source");
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

          const generation = await generateWithMistralChat({
            apiUrl: mistralApiUrl,
            apiKey: mistralKey,
            modelId,
            systemPrompt: params.systemPrompt,
            userPrompt: params.userPrompt,
            temperature: params.temperature,
            maxTokens: params.maxTokens,
            responseMode: params.responseMode,
          });
          return generation.text;
        };

        const prepared = await prepareLongInputForReports({
          sourceText,
          thresholdTokens: chunkingProfile.thresholdTokens,
          chunkTokens: chunkingProfile.chunkTokens,
          chunkOverlapTokens: chunkingProfile.chunkOverlapTokens,
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

        const sourceTokensForGeneration = estimateTokenCount(prepared.text);
        const tokenBudget = resolveModelTokenBudget({
          modelId,
          sourceTokens: sourceTokensForGeneration,
          runtimeLimits,
        });
        if (tokenBudget.blockedByContext) {
          throw new Error(
            `Source trop longue pour ${modelId}. Contexte max: ${formatTokenCount(
              tokenBudget.contextWindowTokens ?? 0
            )} tokens.`
          );
        }
        markStage("token_budget_resolved", {
          contextWindowTokens: tokenBudget.contextWindowTokens ?? null,
          effectiveMaxGenerationTokens: tokenBudget.effectiveMaxGenerationTokens ?? null,
        });

        const requestedMaxTokens = configuredMaxTokens;
        const effectiveGenerationMaxTokens =
          typeof tokenBudget.effectiveMaxGenerationTokens === "number"
            ? Math.min(requestedMaxTokens, tokenBudget.effectiveMaxGenerationTokens)
            : requestedMaxTokens;
        if (effectiveGenerationMaxTokens < requestedMaxTokens) {
          setLlmApiStatus("preparing", `Max tokens ajuste a ${effectiveGenerationMaxTokens} selon le modele`);
        }

        for (let index = 0; index < FORMAT_ORDER.length; index += 1) {
          const item = FORMAT_ORDER[index]!;
          setLlmApiStatus("generating", `Generation ${item.format} (${index + 1}/3)`);
          const generationProgress = 0.5 + (index / FORMAT_ORDER.length) * 0.4;
          setLlmApiProgress(generationProgress);
          markStage("format_generation_start", {
            format: item.format,
            sequence: index + 1,
            totalFormats: FORMAT_ORDER.length,
          });

          const generation =
            provider === "huggingface"
              ? await generateReportDetailed({
                  provider: "huggingface",
                  format: item.format,
                  modelId,
                  sourceText: prepared.text,
                  temperature,
                  maxTokens: effectiveGenerationMaxTokens,
                  hfToken,
                })
              : await generateReportDetailed({
                  provider: "mistral",
                  format: item.format,
                  modelId,
                  sourceText: prepared.text,
                  temperature,
                  maxTokens: effectiveGenerationMaxTokens,
                  mistralApiKey: mistralKey,
                  mistralApiUrl,
                });

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

          setLlmApiResult(reportFormatToKey(item.format), result);
          markStage("format_generation_done", {
            format: item.format,
            sequence: index + 1,
            sectionCount: result.report.sections.length,
            outputLength: result.rawResponse.length,
          });
        }

        setLlmApiStatus("done", "Generation terminee");
        setLlmApiProgress(1);
        telemetry.logEvent("LLM_RUN_DONE", {
          provider,
          modelId,
          sourceMode,
          formatCount: FORMAT_ORDER.length,
        });
        logger.info("[llm-api] run done", {
          provider,
          modelId,
          sourceMode,
          formatCount: FORMAT_ORDER.length,
        });
        setTelemetrySummary(telemetry.exportSummary());
      } catch (error) {
        const message = error instanceof Error ? error.message : "Erreur inconnue lors de la generation";
        logger.error("[llm-api] run failed", {
          stage,
          message,
          provider,
          modelId: activeModelId,
          sourceMode,
        });
        telemetry.logEvent("LLM_RUN_ERROR", {
          stage,
          message,
          provider,
          modelId: activeModelId,
          sourceMode,
        });
        setTelemetrySummary(telemetry.exportSummary());
        setLlmApiStatus("error", message);
      }
    },
    [
      mistralApiKey,
      cloudMistralApiUrl,
      llmApiProvider,
      hfApiToken,
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiHfMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiMistralMaxTokens,
      registerTelemetry,
      segments,
      setLlmApiProgress,
      setLlmApiResult,
      setLlmApiResults,
      setLlmApiStatus,
      setTelemetrySummary,
    ]
  );

  const downloadDocx = useCallback(
    async (format: ReportResultKey) => {
      const result = results[format];
      if (!result) {
        throw new Error("Aucun resultat disponible pour ce format.");
      }
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

      setLlmApiStatus("formatting", `Preparation DOCX ${result.format}`);
      setLlmApiProgress(0.97);
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

        setLlmApiStatus("done", "DOCX telecharge");
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
    [results, setLlmApiProgress, setLlmApiStatus, setTelemetrySummary]
  );

  return {
    status,
    progress,
    results,
    generateAll,
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
