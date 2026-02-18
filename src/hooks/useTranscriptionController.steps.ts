import type { AsrConfigStore, DedupeMode } from "@/store/asr-store";

export function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export interface ConfidenceAccumulator {
  totalDur: number;
  weightedSum: number;
  modelDur: number;
  estimatedDur: number;
}

export function accumulateConfidenceFromSegments(
  current: ConfidenceAccumulator,
  segments: Array<{
    start: number;
    end: number;
    confidence?: number;
    confidenceSource?: "model" | "estimated" | string;
  }>
): ConfidenceAccumulator {
  const next = { ...current };
  for (const segment of segments) {
    const confidence = segment.confidence;
    if (typeof confidence !== "number" || Number.isNaN(confidence)) continue;
    const duration = Math.max(0.001, segment.end - segment.start);
    next.totalDur += duration;
    next.weightedSum += confidence * duration;
    if (segment.confidenceSource === "estimated") next.estimatedDur += duration;
    else if (segment.confidenceSource === "model") next.modelDur += duration;
  }
  return next;
}

export function resolveOverallConfidence(params: {
  accumulator: ConfidenceAccumulator;
  fallbackText?: string;
  fallbackDurationSec?: number;
  estimateFromText: (text: string, durationSec: number) => number;
}) {
  if (params.accumulator.totalDur > 0) {
    return {
      overall: clamp01(params.accumulator.weightedSum / params.accumulator.totalDur),
      source: (params.accumulator.estimatedDur > params.accumulator.modelDur
        ? "estimated"
        : "model") as "model" | "estimated",
    };
  }

  if (params.fallbackText && params.fallbackText.trim().length) {
    const duration = Math.max(0.001, params.fallbackDurationSec ?? 0.001);
    return {
      overall: clamp01(params.estimateFromText(params.fallbackText, duration)),
      source: "estimated" as const,
    };
  }

  return {
    overall: null,
    source: null,
  };
}

export function shouldEmitThrottledUpdate(params: {
  now: number;
  lastTimestamp: number;
  value: number;
  throttleMs: number;
  force?: boolean;
}) {
  if (params.force) return true;
  if (params.value <= 0 || params.value >= 1) return true;
  return params.now - params.lastTimestamp >= params.throttleMs;
}

export function isRunInvalidated(runId: number, currentRunId: number) {
  return runId !== currentRunId;
}

export function shouldStopRun(params: {
  runId?: number;
  currentRunId: number;
  stopRequested: boolean;
}) {
  if (typeof params.runId === "number" && isRunInvalidated(params.runId, params.currentRunId)) {
    return true;
  }
  return params.stopRequested;
}

export function resolveMemoryModeForDuration(params: {
  durationSec: number;
  requestedMode: AsrConfigStore["memoryMode"];
  thresholdSec?: number;
}) {
  const threshold = params.thresholdSec ?? 15 * 60;
  if (params.durationSec > threshold && params.requestedMode === "full") {
    return {
      mode: "progressive" as const,
      switched: true,
      thresholdSec: threshold,
    };
  }
  return {
    mode: params.requestedMode,
    switched: false,
    thresholdSec: threshold,
  };
}

const MAX_OVERLAP_TOKENS = 30;
const MIN_OVERLAP_TOKENS = 2;
const MAX_PREFIX_OFFSET = 2;
const FUZZY_TOKEN_THRESHOLD = 0.75;
const FUZZY_CHAR_THRESHOLD = 0.78;
const MAX_DEBRIS_PREFIX_TOKENS = 3;
const MIN_DEBRIS_REMAINING_TOKENS = 2;
const CONTINUATION_TOKENS = new Set([
  "de",
  "du",
  "des",
  "d",
  "l",
  "la",
  "le",
  "les",
  "que",
  "qui",
  "pour",
  "avec",
  "dans",
  "sur",
  "en",
  "au",
  "aux",
]);
const VERB_LIKE_TOKENS = new Set([
  "est",
  "sont",
  "ete",
  "etaient",
  "etait",
  "a",
  "ont",
  "avait",
  "avaient",
  "sera",
  "seront",
  "etre",
  "avoir",
  "fait",
  "font",
  "faisait",
  "faisaient",
  "dit",
  "disent",
  "peut",
  "peuvent",
  "doit",
  "doivent",
  "va",
  "vont",
  "allait",
  "allaient",
]);

type FilteredToken = { token: string; index: number };

export function trimChunkOverlap(
  previousText: string | undefined,
  currentText: string,
  mode: DedupeMode
): { text: string; overlapWords: number; removedTokens: number } {
  if (mode === "fuzzy") {
    return trimChunkOverlapFuzzy(previousText, currentText);
  }
  return trimChunkOverlapExact(previousText, currentText);
}

export function trimDebrisPrefix(
  previousText: string | undefined,
  currentText: string
): { text: string; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length || !previousText) {
    return { text: candidate, removedTokens: 0 };
  }
  if (endsWithTerminalPunctuation(previousText)) {
    return { text: candidate, removedTokens: 0 };
  }
  if (!endsWithContinuation(previousText)) {
    return { text: candidate, removedTokens: 0 };
  }

  const rawTokens = candidate.split(/\s+/);
  if (rawTokens.length <= MAX_DEBRIS_PREFIX_TOKENS) {
    return { text: candidate, removedTokens: 0 };
  }

  const firstToken = rawTokens[0] ?? "";
  if (startsWithUppercase(firstToken)) {
    return { text: candidate, removedTokens: 0 };
  }

  const prefixTokens = rawTokens.slice(0, MAX_DEBRIS_PREFIX_TOKENS);
  const normalizedPrefix = prefixTokens.map((token) => normalizeToken(token)).filter((token) => token.length);
  if (normalizedPrefix.some((token) => isVerbLike(token))) {
    return { text: candidate, removedTokens: 0 };
  }

  if (rawTokens.length - prefixTokens.length < MIN_DEBRIS_REMAINING_TOKENS) {
    return { text: candidate, removedTokens: 0 };
  }

  return { text: rawTokens.slice(prefixTokens.length).join(" "), removedTokens: prefixTokens.length };
}

function trimChunkOverlapExact(
  previousText: string | undefined,
  currentText: string
): { text: string; overlapWords: number; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length) {
    return { text: "", overlapWords: 0, removedTokens: 0 };
  }
  if (!previousText) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }

  const prevTrimmed = previousText.trim();
  if (!prevTrimmed.length) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }
  if (candidate === prevTrimmed) {
    const count = candidate.split(/\s+/).length;
    return { text: "", overlapWords: count, removedTokens: count };
  }

  const prevRawTokens = prevTrimmed.split(/\s+/);
  const currentRawTokens = candidate.split(/\s+/);
  const prevTokens = prevRawTokens.map((token) => normalizeToken(token));
  const currentTokens = currentRawTokens.map((token) => normalizeToken(token));
  const prevFiltered = prevTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const currentFiltered = currentTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const overlap = findOverlap(prevFiltered, currentFiltered, "exact");
  if (overlap) {
    return {
      text: currentRawTokens.slice(overlap.lastOverlapIndex + 1).join(" "),
      overlapWords: overlap.overlapWords,
      removedTokens: overlap.removedTokens,
    };
  }

  return { text: candidate, overlapWords: 0, removedTokens: 0 };
}

function trimChunkOverlapFuzzy(
  previousText: string | undefined,
  currentText: string
): { text: string; overlapWords: number; removedTokens: number } {
  const candidate = currentText.trim();
  if (!candidate.length) {
    return { text: "", overlapWords: 0, removedTokens: 0 };
  }
  if (!previousText) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }

  const prevTrimmed = previousText.trim();
  if (!prevTrimmed.length) {
    return { text: candidate, overlapWords: 0, removedTokens: 0 };
  }
  if (candidate === prevTrimmed) {
    const count = candidate.split(/\s+/).length;
    return { text: "", overlapWords: count, removedTokens: count };
  }

  const prevRawTokens = prevTrimmed.split(/\s+/);
  const currentRawTokens = candidate.split(/\s+/);
  const prevTokens = prevRawTokens.map((token) => normalizeToken(token));
  const currentTokens = currentRawTokens.map((token) => normalizeToken(token));
  const prevFiltered = prevTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const currentFiltered = currentTokens
    .map((token, index) => ({ token, index }))
    .filter((item) => item.token.length);
  const overlap = findOverlap(prevFiltered, currentFiltered, "fuzzy");
  if (overlap) {
    return {
      text: currentRawTokens.slice(overlap.lastOverlapIndex + 1).join(" "),
      overlapWords: overlap.overlapWords,
      removedTokens: overlap.removedTokens,
    };
  }

  return { text: candidate, overlapWords: 0, removedTokens: 0 };
}

function findOverlap(
  prevFiltered: FilteredToken[],
  currentFiltered: FilteredToken[],
  mode: "exact" | "fuzzy"
) {
  const maxOverlap = Math.min(prevFiltered.length, currentFiltered.length, MAX_OVERLAP_TOKENS);
  for (let size = maxOverlap; size >= MIN_OVERLAP_TOKENS; size -= 1) {
    const prevSlice = prevFiltered.slice(prevFiltered.length - size);
    const maxOffset = Math.min(MAX_PREFIX_OFFSET, currentFiltered.length - size);
    for (let offset = 0; offset <= maxOffset; offset += 1) {
      const currentSlice = currentFiltered.slice(offset, offset + size);
      if (!currentSlice.length) continue;
      if (!slicesMatch(prevSlice, currentSlice, mode)) continue;
      const lastOverlapIndex = currentSlice[size - 1]!.index;
      return {
        overlapWords: size,
        lastOverlapIndex,
        removedTokens: lastOverlapIndex + 1,
      };
    }
  }
  return null;
}

function slicesMatch(
  prevSlice: FilteredToken[],
  currentSlice: FilteredToken[],
  mode: "exact" | "fuzzy"
): boolean {
  if (mode === "exact") {
    for (let i = 0; i < prevSlice.length; i += 1) {
      if (prevSlice[i]!.token !== currentSlice[i]!.token) {
        return false;
      }
    }
    return true;
  }

  let matches = 0;
  for (let i = 0; i < prevSlice.length; i += 1) {
    if (areTokensSimilar(prevSlice[i]!.token, currentSlice[i]!.token)) {
      matches += 1;
    }
  }
  const similarity = matches / prevSlice.length;
  if (similarity >= FUZZY_TOKEN_THRESHOLD) {
    return true;
  }

  const prevStr = prevSlice.map((item) => item.token).join(" ");
  const currentStr = currentSlice.map((item) => item.token).join(" ");
  return diceCoefficient(prevStr, currentStr) >= FUZZY_CHAR_THRESHOLD;
}

function normalizeToken(token: string): string {
  try {
    return token
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  } catch (error) {
    void error;
    return token.toLowerCase().replace(/[^a-z0-9]+/gi, "");
  }
}

function endsWithTerminalPunctuation(text: string): boolean {
  return /[.!?…]$/.test(text.trim());
}

function endsWithContinuation(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return false;
  if (/(?:d|l|qu|s)['’]$/.test(trimmed)) {
    return true;
  }
  const lastRaw = trimmed.split(/\s+/).pop() ?? "";
  const normalized = normalizeToken(lastRaw);
  return CONTINUATION_TOKENS.has(normalized);
}

function startsWithUppercase(token: string): boolean {
  return /^[A-ZÀ-ÖØ-Ý]/.test(token);
}

function isVerbLike(token: string): boolean {
  if (!token) return false;
  if (VERB_LIKE_TOKENS.has(token)) return true;
  return token.endsWith("er") || token.endsWith("ir") || token.endsWith("re");
}

function areTokensSimilar(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length <= 3 || b.length <= 3) return false;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  return diceCoefficient(a, b) >= 0.72;
}

function diceCoefficient(a: string, b: string): number {
  if (a.length < 2 || b.length < 2) return 0;
  const aBigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i += 1) {
    const gram = a.slice(i, i + 2);
    aBigrams.set(gram, (aBigrams.get(gram) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i += 1) {
    const gram = b.slice(i, i + 2);
    const count = aBigrams.get(gram);
    if (count) {
      intersection += 1;
      if (count === 1) {
        aBigrams.delete(gram);
      } else {
        aBigrams.set(gram, count - 1);
      }
    }
  }
  const total = (a.length - 1) + (b.length - 1);
  return total > 0 ? (2 * intersection) / total : 0;
}
