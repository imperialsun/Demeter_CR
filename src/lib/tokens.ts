const TOKEN_REGEX = /[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu;

export function estimateTokenCount(text: string): number {
  if (!text) return 0;
  const matches = text.trim().match(TOKEN_REGEX);
  return matches ? matches.length : 0;
}
