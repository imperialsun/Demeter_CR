/**
 * Lightweight "cheap" text-based confidence estimator for French.
 * Output: number in [0,1]
 *
 * Strategy: compute simple features (language heuristics, fluency, repetition, format, length) and combine with weights.
 */

const FRENCH_STOPWORDS = new Set([
  "le","la","les","de","du","des","un","une","et","à","en","pour","que","qui","dans","ce","ces","se","sur","par","avec","ne","pas","mais","ou","si","est","sont","été","être","avoir","fait","faire"
]);

const COMMON_FRENCH = new Set([
  "il","elle","on","nous","vous","ils","elles","au","aux","plus","moins","entre","comme","aussi","bien","très","tout","tous","toutes","mais","donc","où","quand","quel","quelle","quelques","peu","beaucoup"
]);

function tokenise(text: string) {
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""));
}

export function langScore(text: string) {
  const tokens = tokenise(text.toLowerCase());
  if (!tokens.length) return 0;
  // stopword ratio
  const stopCount = tokens.reduce((acc, t) => (FRENCH_STOPWORDS.has(t) ? acc + 1 : acc), 0);
  const stopRatio = stopCount / tokens.length; // higher is better
  // accented characters presence (éèàùâêîôûç)
  const accents = (text.match(/[éèêëàâäîïôöùûüçœæ]/gi) || []).length;
  const accentRatio = Math.min(1, accents / Math.max(1, tokens.length * 0.25));
  // simple heuristic: combine stopwords + common words + suffix heuristics + accents
  const commonCount = tokens.reduce((acc, t) => (COMMON_FRENCH.has(t) ? acc + 1 : acc), 0);
  const commonRatio = commonCount / tokens.length;
  const suffixCount = tokens.reduce((acc, t) => (/ment$|tion$|ique$|ence$|ance$|isme$|iste$|eau$|eur$/.test(t) ? acc + 1 : acc), 0);
  const suffixRatio = suffixCount / tokens.length;
  const wordRatio = (stopRatio + commonRatio + suffixRatio) / 3;
  // boost a bit for longer inputs to avoid penalising verbose news text
  const lengthBoost = Math.min(1, tokens.length / 50);
  const avgWordLen = tokens.length ? tokens.reduce((a, b) => a + b.length, 0) / tokens.length : 0;
  const avgLenScore = Math.max(0, Math.min(1, (avgWordLen - 3) / 7));
  // more tolerant: include average word length as a positive indicator for formal text
  const base = Math.min(1, 0.55 * wordRatio + 0.25 * accentRatio + 0.2 * avgLenScore);
  // Bonus for long, well-formed news text to avoid under-scoring long-form transcripts
  // Aggressive long-text boost to ensure long news-like texts are not under-scored
  const longTextBonus = tokens.length >= 80 ? 0.34 : tokens.length >= 40 ? 0.27 : 0;
  const score = Math.max(0, Math.min(1, Math.min(1, base * (0.6 + 0.4 * lengthBoost)) + longTextBonus));
  return score;
}

export function fluencyScore(text: string) {
  // punctuation balance and sentence starts
  if (!text || !text.trim()) return 0;
  const clauses = text.split(/[.!?;]+|,+/).map((s) => s.trim()).filter(Boolean);
  const clauseCount = Math.max(1, clauses.length);
  const tokens = tokenise(text);
  const avgWordLen = tokens.length ? tokens.reduce((a, b) => a + b.length, 0) / tokens.length : 0;
  const punctCount = (text.match(/[.!?,;:]/g) || []).length;
  const punctPerClause = punctCount / clauseCount;
  // Cap: reasonable clauses have some punctuation; allow comma-heavy sentences
  const punctScore = Math.min(1, punctPerClause / 1.0);
  const wordLenScore = Math.max(0, Math.min(1, (avgWordLen - 3) / 7));
  // soften fluency weighting a bit to be more tolerant
  return Math.min(1, 0.5 * punctScore + 0.5 * wordLenScore);
}

export function repetitionScore(text: string) {
  const tokens = tokenise(text.toLowerCase());
  if (!tokens.length) return 0.6;
  const n = Math.min(3, Math.max(1, Math.floor(tokens.length / 2)));
  // compute proportion of repeated n-grams
  const grams = new Map<string, number>();
  for (let i = 0; i + n <= tokens.length; i++) {
    const g = tokens.slice(i, i + n).join(" ");
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let repeats = 0;
  for (const v of grams.values()) {
    if (v > 1) repeats += v - 1;
  }
  const repeatRatio = repeats / Math.max(1, grams.size);
  // return 1 - normalized repeatRatio (clamped) with softer penalty
  return Math.max(0, Math.min(1, 1 - repeatRatio * 1.5));
}

export function formatScore(text: string) {
  if (!text) return 0.6;
  // detect timestamps, weird long sequences of punctuation or digits
  const hasTimestamp = /\d{1,2}:\d{2}(:\d{2})?/.test(text);
  // hyphen placed at the end of the class to avoid escaping
  // eslint-disable-next-line no-useless-escape
  const weirdSeq = /[^\p{L}\p{N}\s,.!?;:'"()\-]/u.test(text);
  const longPunct = /[!?.]{4,}/.test(text);
  const unbalancedParen = (text.match(/\(/g) || []).length !== (text.match(/\)/g) || []).length;
  let score = 1;
  if (hasTimestamp) score -= 0.4;
  if (weirdSeq) score -= 0.3;
  if (longPunct) score -= 0.2;
  if (unbalancedParen) score -= 0.2;
  return Math.max(0, Math.min(1, score));
}

export function lengthScore(text: string, durationSec?: number) {
  if (!durationSec) return 0.6;
  const tokens = tokenise(text);
  const words = tokens.length;
  const wps = words / Math.max(0.001, durationSec);
  // typical speech is ~2-4.5 words/s, ideal near 3.0
  const ideal = 3.0;
  const diff = Math.abs(wps - ideal);
  // convert to score where diff 0 -> 1, diff >= 3 -> 0
  const score = Math.max(0, Math.min(1, 1 - diff / 3));
  return score;
}

export function estimateConfidenceFromText(text: string, durationSec?: number) {
  const ls = langScore(text);
  const fs = fluencyScore(text);
  const rs = repetitionScore(text);
  const fr = formatScore(text);
  const le = lengthScore(text, durationSec);

  // Rebalanced weights to emphasize fluency and length for long-form news-like content
  const w_lang = 0.25;
  const w_fluency = 0.28;
  const w_repetition = 0.20;
  const w_format = 0.10;
  const w_length = 0.17;

  const combined = Math.max(0, Math.min(1, w_lang * ls + w_fluency * fs + w_repetition * rs + w_format * fr + w_length * le));
  return combined;
}

export function scoreDetails(text: string, durationSec?: number) {
  const ls = langScore(text);
  const fs = fluencyScore(text);
  const rs = repetitionScore(text);
  const fr = formatScore(text);
  const le = lengthScore(text, durationSec);
  const combined = estimateConfidenceFromText(text, durationSec);
  return { lang: ls, fluency: fs, repetition: rs, format: fr, length: le, combined };
}

export default estimateConfidenceFromText;
