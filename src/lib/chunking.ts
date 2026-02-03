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

export interface FixedSegmentConfig {
  durationSec: number;
  segmentDurationSec: number;
  overlapSec: number;
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

export function buildFixedSegments(config: FixedSegmentConfig): ChunkDefinition[] {
  const durationSec = Math.max(0, config.durationSec);
  const segmentDurationSec = Math.max(1, config.segmentDurationSec);
  const overlapSec = Math.min(Math.max(0, config.overlapSec), Math.max(0, segmentDurationSec - 1));
  const step = Math.max(1, segmentDurationSec - overlapSec);
  const segments: ChunkDefinition[] = [];
  let index = 0;
  for (let start = 0; start < durationSec; start += step) {
    const end = Math.min(start + segmentDurationSec, durationSec);
    segments.push({
      id: crypto.randomUUID(),
      index,
      start,
      end,
      paddedStart: start,
      paddedEnd: end,
    });
    index += 1;
    if (end >= durationSec) break;
  }
  return segments;
}

export function offsetChunks(
  chunks: ChunkDefinition[],
  offsetSec: number,
  startIndex: number
): ChunkDefinition[] {
  return chunks.map((chunk, idx) => ({
    id: crypto.randomUUID(),
    index: startIndex + idx,
    start: chunk.start + offsetSec,
    end: chunk.end + offsetSec,
    paddedStart: chunk.paddedStart + offsetSec,
    paddedEnd: chunk.paddedEnd + offsetSec,
  }));
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
    // Silence-based segments are already boundary-aligned; avoid extra overlap padding.
    chunks.push(toChunkDefinition(index++, start, end, 0));
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
// Business rule: overlap = clamp(6% of duration, 0.2s..0.9s), rounded to 2 decimals.
export function computeDefaultOverlap(durationSec: number) {
  const raw = durationSec * 0.06;
  const clamped = Math.min(0.9, Math.max(0.2, raw));
  return Math.round(clamped * 100) / 100;
}
