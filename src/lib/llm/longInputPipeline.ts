import { estimateTokenCount } from "@/lib/tokens";
import logger from "@/lib/logger";
import { normalizeLlmReportChunkRatio } from "@/lib/storage";

export interface LongInputPipelineOptions {
  sourceText: string;
  thresholdTokens?: number;
  chunkTokens?: number;
  chunkOverlapTokens?: number;
  chunkRatio?: number;
  summarizeChunk: (chunkText: string, chunkIndex: number, chunkCount: number) => Promise<string>;
  consolidateSummaries: (chunkSummaries: string[]) => Promise<string>;
  onProgress?: (progress: number, detail: string) => void;
}

export interface LongInputPipelineResult {
  text: string;
  sourceTokenCount: number;
  chunkCount: number;
  pipelinePasses: 1 | 2;
}

export function splitTextIntoTokenChunks(
  text: string,
  maxTokensPerChunk: number,
  overlapTokens: number
): string[] {
  const normalized = text.trim();
  if (!normalized) return [];

  const tokens = normalized.split(/\s+/);
  const chunkSize = Math.max(1, Math.floor(maxTokensPerChunk));
  const safeOverlap = Math.max(0, Math.min(Math.floor(overlapTokens), chunkSize - 1));

  if (tokens.length <= chunkSize) {
    logger.debug("[llm-api][long-input] source fits in one chunk", {
      tokenCount: tokens.length,
      chunkSize,
      overlapTokens: safeOverlap,
    });
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < tokens.length) {
    const end = Math.min(tokens.length, cursor + chunkSize);
    chunks.push(tokens.slice(cursor, end).join(" "));
    if (end >= tokens.length) break;

    const next = end - safeOverlap;
    cursor = next > cursor ? next : end;
  }

  return chunks;
}

export async function prepareLongInputForReports(
  options: LongInputPipelineOptions
): Promise<LongInputPipelineResult> {
  const sourceText = options.sourceText.trim();
  if (!sourceText) {
    throw new Error("Source vide pour la generation du compte rendu.");
  }

  const sourceTokenCount = estimateTokenCount(sourceText);
  const thresholdTokens = options.thresholdTokens ?? 6500;
  const normalizedThresholdTokens = Number.isFinite(thresholdTokens)
    ? Math.max(1, Math.floor(thresholdTokens))
    : 6500;
  const chunkRatio = normalizeLlmReportChunkRatio(options.chunkRatio);
  const ratioChunkTokens = Math.max(1, Math.floor(sourceTokenCount * chunkRatio));
  const modelChunkTokens = Math.max(1, Math.floor(options.chunkTokens ?? 2400));
  const effectiveChunkTokens = Math.min(ratioChunkTokens, normalizedThresholdTokens);
  logger.info("[llm-api][long-input] Préparation source · pipeline lancé", {
    sourceTokenCount,
    thresholdTokens,
    modelChunkTokens,
    ratioChunkTokens,
    effectiveChunkTokens,
    chunkOverlapTokens: options.chunkOverlapTokens ?? 180,
    chunkRatio,
  });

  if (sourceTokenCount <= thresholdTokens) {
    logger.info("[llm-api][long-input] Source courte · génération directe", {
      sourceTokenCount,
      thresholdTokens,
    });
    options.onProgress?.(0.1, "Source courte : génération directe");
    return {
      text: sourceText,
      sourceTokenCount,
      chunkCount: 1,
      pipelinePasses: 1,
    };
  }

  const chunks = splitTextIntoTokenChunks(
    sourceText,
    effectiveChunkTokens,
    options.chunkOverlapTokens ?? 180
  );

  if (!chunks.length) {
    throw new Error("Impossible de decouper la source longue.");
  }
  logger.info("[llm-api][long-input] Source longue · découpage en chunks", {
    sourceTokenCount,
    chunkCount: chunks.length,
  });

  options.onProgress?.(0.05, `Source longue détectée : ${chunks.length} chunks`);

  const chunkSummaries: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    logger.info("[llm-api][long-input] Chunk extraction · démarrage", {
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      chunkTokenEstimate: estimateTokenCount(chunk),
      chunkTextLength: chunk.length,
    });
    const summary = await options.summarizeChunk(chunk, index, chunks.length);
    const normalizedSummary = summary.trim();
    chunkSummaries.push(normalizedSummary);
    logger.info("[llm-api][long-input] Chunk extraction · terminé", {
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      summaryLength: normalizedSummary.length,
      summaryTokenEstimate: estimateTokenCount(normalizedSummary),
    });
    const stepProgress = 0.05 + 0.55 * ((index + 1) / chunks.length);
    options.onProgress?.(stepProgress, `Extraction factuelle chunk ${index + 1}/${chunks.length}`);
  }

  options.onProgress?.(0.7, "Consolidation des résumés en cours");
  logger.info("[llm-api][long-input] Consolidation des résumés", {
    chunkCount: chunkSummaries.length,
  });
  const consolidated = (await options.consolidateSummaries(chunkSummaries)).trim();
  const consolidatedText = consolidated || chunkSummaries.join("\n\n");
  logger.info("[llm-api][long-input] Consolidation terminée", {
    consolidatedLength: consolidatedText.length,
    consolidatedTokenEstimate: estimateTokenCount(consolidatedText),
    usedFallbackJoin: !consolidated,
  });

  options.onProgress?.(0.8, "Consolidation terminée");

  return {
    text: consolidatedText,
    sourceTokenCount,
    chunkCount: chunks.length,
    pipelinePasses: 2,
  };
}
