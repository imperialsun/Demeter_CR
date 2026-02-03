export function cleanTranscriptText(input: string | undefined | null): string {
  if (!input) {
    return "";
  }
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const tokens = normalized.split(" ");
  const pairs = tokens.map((raw) => ({ raw, norm: normalizeToken(raw) }));

  const collapsed = collapseRepeatedPhrases(pairs);
  const deduped = removeAdjacentDuplicateTokens(collapsed);
  const limitedRuns = limitSingleTokenRuns(deduped, 2);
  return restorePunctuation(limitedRuns.map((pair) => pair.raw));
}

type TokenPair = { raw: string; norm: string };

function collapseRepeatedPhrases(tokens: TokenPair[]): TokenPair[] {
  const result: TokenPair[] = [];
  const maxPattern = Math.min(24, Math.floor(tokens.length / 2));
  const minPattern = 2;
  let index = 0;

  while (index < tokens.length) {
    let patternLength = 0;
    let repetitions = 1;

    for (let length = maxPattern; length >= minPattern; length--) {
      if (index + length * 2 > tokens.length) {
        continue;
      }
      if (!segmentsEqual(tokens, index, length)) {
        continue;
      }

      patternLength = length;
      repetitions = 2;
      let offset = index + length * 2;
      while (offset + length <= tokens.length && segmentsEqual(tokens, index, length, offset)) {
        repetitions += 1;
        offset += length;
      }
      break;
    }

    if (patternLength > 0) {
      result.push(...tokens.slice(index, index + patternLength));
      index += patternLength * repetitions;
      continue;
    }

    result.push(tokens[index]);
    index += 1;
  }

  return result;
}

function segmentsEqual(
  tokens: TokenPair[],
  start: number,
  length: number,
  otherStart?: number
): boolean {
  const compareStart = otherStart ?? start + length;
  for (let i = 0; i < length; i += 1) {
    if (tokens[start + i]!.norm !== tokens[compareStart + i]!.norm) {
      return false;
    }
  }
  return true;
}

function removeAdjacentDuplicateTokens(tokens: TokenPair[]): TokenPair[] {
  if (!tokens.length) {
    return tokens;
  }
  const result: TokenPair[] = [];
  for (const pair of tokens) {
    const last = result[result.length - 1];
    if (last && last.norm === pair.norm && shouldCollapseDuplicate(last.raw, pair.raw, pair.norm)) {
      if (hasSentenceBoundary(last.raw)) {
        last.raw = stripTrailingBoundary(last.raw);
      }
      continue;
    }
    result.push(pair);
  }
  return result;
}

function shouldCollapseDuplicate(prevRaw: string, currRaw: string, norm: string): boolean {
  if (!norm) return false;
  if (norm.length >= 6) return true;
  if (hasSentenceBoundary(prevRaw) || hasSentenceBoundary(currRaw)) return true;
  return false;
}

function hasSentenceBoundary(token: string): boolean {
  return /[.!?;:,]$/.test(token);
}

function stripTrailingBoundary(token: string): string {
  return token.replace(/[.!?;:,]+$/, "");
}

function limitSingleTokenRuns(tokens: TokenPair[], maxRepeat: number): TokenPair[] {
  if (tokens.length === 0) {
    return tokens;
  }
  const result: TokenPair[] = [];
  let lastToken = "";
  let runLength = 0;

  for (const pair of tokens) {
    if (pair.norm === lastToken) {
      runLength += 1;
      if (runLength >= maxRepeat) {
        continue;
      }
    } else {
      lastToken = pair.norm;
      runLength = 0;
    }
    result.push(pair);
  }

  return result;
}

function restorePunctuation(tokens: string[]): string {
  if (!tokens.length) {
    return "";
  }
  const joined = tokens.join(" ");
  return joined.replace(/\s+([.,!?;:])/g, "$1").trim();
}

function normalizeToken(token: string): string {
  try {
    return token
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  } catch (err) {
    void err;
    return token.toLowerCase().replace(/[^a-z0-9]+/gi, "");
  }
}
