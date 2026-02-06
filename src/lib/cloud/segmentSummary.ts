import type { TranscriptionSegment } from "@/lib/export";
import { estimateTokenCount } from "@/lib/tokens";

const TEXT_PREVIEW_LIMIT = 80;

export interface SegmentSummaryItem {
  start: number;
  end: number;
  chunkId: string;
  strategy: TranscriptionSegment["strategy"];
  textSample: string;
}

export interface SegmentSummary {
  count: number;
  totalDurationSec: number;
  textChars: number;
  tokenCount: number;
  first?: SegmentSummaryItem;
  last?: SegmentSummaryItem;
}

function buildSample(segment: TranscriptionSegment): SegmentSummaryItem {
  const trimmed = segment.text.trim();
  const textSample =
    trimmed.length > TEXT_PREVIEW_LIMIT ? `${trimmed.slice(0, TEXT_PREVIEW_LIMIT)}...` : trimmed;
  return {
    start: segment.start,
    end: segment.end,
    chunkId: segment.chunkId,
    strategy: segment.strategy,
    textSample,
  };
}

export function summarizeSegments(segments: TranscriptionSegment[]): SegmentSummary {
  if (!segments.length) {
    return { count: 0, totalDurationSec: 0, textChars: 0, tokenCount: 0 };
  }
  const totalDurationSec = segments.reduce(
    (acc, segment) => acc + Math.max(0, segment.end - segment.start),
    0
  );
  const textChars = segments.reduce((acc, segment) => acc + segment.text.trim().length, 0);
  const tokenCount = segments.reduce((acc, segment) => acc + estimateTokenCount(segment.text), 0);
  return {
    count: segments.length,
    totalDurationSec,
    textChars,
    tokenCount,
    first: buildSample(segments[0]!),
    last: buildSample(segments[segments.length - 1]!),
  };
}
