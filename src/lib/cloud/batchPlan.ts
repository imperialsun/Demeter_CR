import { buildFixedSegments, type ChunkDefinition } from "@/lib/chunking";

export const DEFAULT_BATCH_DURATION_SEC = 45 * 60;

export function buildBatchPlan(
  durationSec: number,
  batchDurationSec: number = DEFAULT_BATCH_DURATION_SEC
): ChunkDefinition[] {
  const safeDuration = Math.max(0, durationSec);
  if (safeDuration === 0) {
    return [
      {
        id: crypto.randomUUID(),
        index: 0,
        start: 0,
        end: 0,
        paddedStart: 0,
        paddedEnd: 0,
      },
    ];
  }
  return buildFixedSegments({
    durationSec: safeDuration,
    segmentDurationSec: batchDurationSec,
    overlapSec: 0,
  });
}
