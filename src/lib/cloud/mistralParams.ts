export const DEFAULT_MISTRAL_SEGMENT_DURATION_SEC = 30;

const VOXTRAL_MINI_MAX_DURATION_SEC = 30 * 60;

export function resolveMistralSegmentDurationSec(model: string): number {
  const normalized = model.trim().toLowerCase();
  if (!normalized) {
    return DEFAULT_MISTRAL_SEGMENT_DURATION_SEC;
  }

  if (normalized === "voxtral-mini-latest" || normalized.startsWith("voxtral-mini-")) {
    return VOXTRAL_MINI_MAX_DURATION_SEC;
  }

  return DEFAULT_MISTRAL_SEGMENT_DURATION_SEC;
}
