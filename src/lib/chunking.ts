import { detectSilenceRegions, type SilenceDetectionOptions } from "@/lib/silence";

export type ChunkingStrategy = "sequential" | "overlap" | "silence";

export interface ChunkingConfig {
  chunkDurationSec: number;
  overlapSec: number;
  silence: SilenceDetectionOptions;
  strategy: ChunkingStrategy;
  durationSec: number;
}

export interface ChunkDefinition {
  id: string;
  index: number;
  start: number;
  end: number;
  paddedStart: number;
  paddedEnd: number;
}

export function buildChunks(
  config: ChunkingConfig,
  monoPcm?: Float32Array,
  sampleRate?: number
): ChunkDefinition[] {
  switch (config.strategy) {
    case "overlap":
      return buildOverlapChunks(config);
    case "silence":
      return buildSilenceAwareChunks(config, monoPcm, sampleRate);
    case "sequential":
    default:
      return buildSequentialChunks(config);
  }
}

function buildSequentialChunks(config: ChunkingConfig): ChunkDefinition[] {
  const chunks: ChunkDefinition[] = [];
  const step = config.chunkDurationSec;
  const total = config.durationSec;
  let index = 0;
  for (let start = 0; start < total; start += step) {
    const end = Math.min(start + step, total);
    chunks.push(toChunkDefinition(index++, start, end, config.overlapSec));
  }
  return chunks;
}

function buildOverlapChunks(config: ChunkingConfig): ChunkDefinition[] {
  const chunks: ChunkDefinition[] = [];
  const step = Math.max(0.5, config.chunkDurationSec - config.overlapSec);
  const total = config.durationSec;
  let index = 0;
  for (let start = 0; start < total; start += step) {
    const end = Math.min(start + config.chunkDurationSec, total);
    chunks.push(toChunkDefinition(index++, start, end, config.overlapSec));
    if (end >= total) break;
  }
  return chunks;
}

function buildSilenceAwareChunks(
  config: ChunkingConfig,
  monoPcm: Float32Array | undefined,
  sampleRate: number | undefined
): ChunkDefinition[] {
  if (!monoPcm || !sampleRate) {
    return buildOverlapChunks(config);
  }

  const ranges = detectSilenceRegions(monoPcm, {
    ...config.silence,
    sampleRate,
  });

  if (!ranges.length) {
    return buildOverlapChunks(config);
  }

  const chunks: ChunkDefinition[] = [];
  let index = 0;
  for (const range of ranges) {
    const start = range.startSec;
    const end = range.endSec;
    chunks.push(toChunkDefinition(index++, start, end, config.overlapSec));
  }

  return chunks;
}

function toChunkDefinition(
  index: number,
  start: number,
  end: number,
  overlapSec: number
): ChunkDefinition {
  const padded = overlapSec / 2;
  return {
    id: crypto.randomUUID(),
    index,
    start,
    end,
    paddedStart: Math.max(0, start - padded),
    paddedEnd: end + padded,
  };
}

// deduplicateOverlaps removed: overlaps are preserved to honor chunking settings.

// Compute the default overlap for a given chunk duration.
// Business rule: overlap = max(0.5s, 10% of chunk duration), rounded to 2 decimals.
export function computeDefaultOverlap(durationSec: number) {
  const raw = durationSec * 0.1;
  const clamped = Math.max(0.5, raw);
  return Math.round(clamped * 100) / 100;
}
