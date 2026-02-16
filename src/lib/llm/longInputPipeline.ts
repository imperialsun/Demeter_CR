import { estimateTokenCount } from "@/lib/tokens";
import logger from "@/lib/logger";

export interface LongInputPipelineOptions {
  sourceText: string;
  thresholdTokens?: number;
  chunkTokens?: number;
  chunkOverlapTokens?: number;
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
  logger.info("[llm-api][long-input] pipeline start", {
    sourceTokenCount,
    thresholdTokens,
    chunkTokens: options.chunkTokens ?? 2400,
    chunkOverlapTokens: options.chunkOverlapTokens ?? 180,
  });

  if (sourceTokenCount <= thresholdTokens) {
    logger.info("[llm-api][long-input] short source, direct generation", {
      sourceTokenCount,
      thresholdTokens,
    });
    options.onProgress?.(0.1, "Source courte: generation directe");
    return {
      text: sourceText,
      sourceTokenCount,
      chunkCount: 1,
      pipelinePasses: 1,
    };
  }

  const chunks = splitTextIntoTokenChunks(
    sourceText,
    options.chunkTokens ?? 2400,
    options.chunkOverlapTokens ?? 180
  );

  if (!chunks.length) {
    throw new Error("Impossible de decouper la source longue.");
  }
  logger.info("[llm-api][long-input] long source split", {
    sourceTokenCount,
    chunkCount: chunks.length,
  });

  options.onProgress?.(0.05, `Source longue detectee: ${chunks.length} chunks`);

  const chunkSummaries: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    logger.debug("[llm-api][long-input] summarize chunk start", {
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      chunkTokenEstimate: estimateTokenCount(chunk),
      chunkTextLength: chunk.length,
    });
    const summary = await options.summarizeChunk(chunk, index, chunks.length);
    const normalizedSummary = summary.trim();
    chunkSummaries.push(normalizedSummary);
    logger.debug("[llm-api][long-input] summarize chunk done", {
      chunkIndex: index + 1,
      chunkCount: chunks.length,
      summaryLength: normalizedSummary.length,
      summaryTokenEstimate: estimateTokenCount(normalizedSummary),
    });
    const stepProgress = 0.05 + 0.55 * ((index + 1) / chunks.length);
    options.onProgress?.(stepProgress, `Extraction factuelle chunk ${index + 1}/${chunks.length}`);
  }

  options.onProgress?.(0.7, "Consolidation des resumes en cours");
  logger.info("[llm-api][long-input] consolidate chunk summaries", {
    chunkCount: chunkSummaries.length,
  });
  const consolidated = (await options.consolidateSummaries(chunkSummaries)).trim();
  const consolidatedText = consolidated || chunkSummaries.join("\n\n");
  logger.info("[llm-api][long-input] consolidation done", {
    consolidatedLength: consolidatedText.length,
    consolidatedTokenEstimate: estimateTokenCount(consolidatedText),
    usedFallbackJoin: !consolidated,
  });

  options.onProgress?.(0.8, "Consolidation terminee");

  return {
    text: consolidatedText,
    sourceTokenCount,
    chunkCount: chunks.length,
    pipelinePasses: 2,
  };
}
