import logger from "@/lib/logger";
import { buildFixedSegments, type ChunkDefinition } from "@/lib/chunking";

export const DEFAULT_BATCH_DURATION_SEC = 45 * 60;

export function buildBatchPlan(
  durationSec: number,
  batchDurationSec: number = DEFAULT_BATCH_DURATION_SEC
): ChunkDefinition[] {
  const safeDuration = Math.max(0, durationSec);
  logger.debug("[cloud][batch-plan] build requested", {
    durationSec,
    safeDuration,
    batchDurationSec,
  });
  if (safeDuration === 0) {
    logger.warn("[cloud][batch-plan] zero duration batch plan");
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
  const plan = buildFixedSegments({
    durationSec: safeDuration,
    segmentDurationSec: batchDurationSec,
    overlapSec: 0,
  });
  logger.debug("[cloud][batch-plan] build completed", {
    batchCount: plan.length,
  });
  return plan;
}
