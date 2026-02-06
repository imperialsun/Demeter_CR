import type { TranscriptionSegment } from "@/lib/export";

export function offsetSegments(
  segments: TranscriptionSegment[],
  offsetSec: number,
  startIndex: number,
  batchId: string
): TranscriptionSegment[] {
  return segments.map((segment, idx) => ({
    ...segment,
    index: startIndex + idx,
    start: segment.start + offsetSec,
    end: segment.end + offsetSec,
    chunkId: `${batchId}-${segment.chunkId}`,
  }));
}
