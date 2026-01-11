export function cleanTranscriptText(input: string | undefined | null): string {
  if (!input) {
    return "";
  }
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  const tokens = normalized.split(" ");
  if (tokens.length < 6) {
    return restorePunctuation(tokens);
  }

  const collapsed = collapseRepeatedPhrases(tokens);
  const limitedRuns = limitSingleTokenRuns(collapsed, 2);
  return restorePunctuation(limitedRuns);
}

function collapseRepeatedPhrases(tokens: string[]): string[] {
  const result: string[] = [];
  const maxPattern = Math.min(24, Math.floor(tokens.length / 2));
  const minPattern = 4;
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
  tokens: string[],
  start: number,
  length: number,
  otherStart?: number
): boolean {
  const compareStart = otherStart ?? start + length;
  for (let i = 0; i < length; i += 1) {
    if (tokens[start + i] !== tokens[compareStart + i]) {
      return false;
    }
  }
  return true;
}

function limitSingleTokenRuns(tokens: string[], maxRepeat: number): string[] {
  if (tokens.length === 0) {
    return tokens;
  }
  const result: string[] = [];
  let lastToken = "";
  let runLength = 0;

  for (const token of tokens) {
    if (token === lastToken) {
      runLength += 1;
      if (runLength >= maxRepeat) {
        continue;
      }
    } else {
      lastToken = token;
      runLength = 0;
    }
    result.push(token);
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
