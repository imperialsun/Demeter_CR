import type { TranscriptionSegment } from "@/lib/export";

/**
 * Compute duration-weighted overall confidence from segments.
 * Returns number 0..1 or null if unavailable.
 */
export function computeOverallConfidence(segs: TranscriptionSegment[]): number | null {
  const items = segs
    .map((s) => ({ conf: s.confidence, dur: Math.max(0.001, s.end - s.start) }))
    .filter((x) => typeof x.conf === "number" && !Number.isNaN(x.conf));
  if (!items.length) return null;
  const totalDur = items.reduce((acc, it) => acc + it.dur, 0);
  if (totalDur <= 0) return items.reduce((acc, it) => acc + (it.conf ?? 0), 0) / items.length;
  const weighted = items.reduce((acc, it) => acc + (it.conf ?? 0) * it.dur, 0) / totalDur;
  return Math.max(0, Math.min(1, weighted));
}

export function computeOverallConfidenceSource(segs: TranscriptionSegment[]): 'model' | 'estimated' | null {
  // Sum duration contributed by estimated vs model confidences
  let modelDur = 0;
  let estimatedDur = 0;
  for (const s of segs) {
    const dur = Math.max(0.001, s.end - s.start);
    if (s.confidenceSource === 'estimated') estimatedDur += dur;
    else if (s.confidenceSource === 'model') modelDur += dur;
  }
  if (modelDur === 0 && estimatedDur === 0) return null;
  return estimatedDur > modelDur ? 'estimated' : 'model';
} 
