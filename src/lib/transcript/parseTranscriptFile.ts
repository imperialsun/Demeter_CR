import { parseSrtToSegments } from "@/lib/cloud/parseSrt";
import { parseVttToSegments } from "@/lib/transcript/parseVtt";
import logger from "@/lib/logger";

export const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

const SUPPORTED_EXTENSIONS = new Set([".txt", ".srt", ".vtt", ".json"]);
const JSON_TEXT_KEYS = new Set(["text", "transcript", "utterance"]);
const MAX_FALLBACK_DEPTH = 4;

export type ParsedTranscriptFile = {
  text: string;
  format: "txt" | "srt" | "vtt" | "json";
  extraction: "plain" | "segments" | "results" | "transcript" | "fallback";
  segmentCount?: number;
};

export async function parseTranscriptFile(
  file: File,
  options?: { maxBytes?: number }
): Promise<ParsedTranscriptFile> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  logger.info("[llm-api][import] parse transcript file start", {
    name: file.name,
    sizeBytes: file.size,
    type: file.type,
    maxBytes,
  });
  try {
    if (file.size > maxBytes) {
      throw new Error("Fichier trop volumineux (max 50 Mo).");
    }

    const extension = getExtension(file.name);
    if (extension && !SUPPORTED_EXTENSIONS.has(extension)) {
      throw new Error("Format non supporte. Utilisez .txt, .srt, .vtt ou .json.");
    }

    const raw = normalizeText(await readFileAsText(file));
    if (!raw) {
      throw new Error("Fichier vide.");
    }

    const format = resolveFormat(extension, file.type);
    if (format === "txt") {
      logger.info("[llm-api][import] parse transcript file success", {
        name: file.name,
        format,
        extraction: "plain",
        textLength: raw.length,
      });
      return {
        text: raw,
        format,
        extraction: "plain",
      };
    }

    if (format === "srt") {
      const segments = parseSrtToSegments(raw, { chunkIdPrefix: "import" });
      const lines = segments.map((segment) => cleanLine(segment.text)).filter(Boolean);
      if (!lines.length) {
        throw new Error("Fichier non interpretable: aucun texte de transcription detecte.");
      }
      logger.info("[llm-api][import] parse transcript file success", {
        name: file.name,
        format,
        extraction: "segments",
        segmentCount: lines.length,
      });
      return {
        text: lines.join("\n"),
        format,
        extraction: "segments",
        segmentCount: lines.length,
      };
    }

    if (format === "vtt") {
      const segments = parseVttToSegments(raw, { chunkIdPrefix: "import" });
      const lines = segments.map((segment) => cleanLine(segment.text)).filter(Boolean);
      if (!lines.length) {
        throw new Error("Fichier non interpretable: aucun texte de transcription detecte.");
      }
      logger.info("[llm-api][import] parse transcript file success", {
        name: file.name,
        format,
        extraction: "segments",
        segmentCount: lines.length,
      });
      return {
        text: lines.join("\n"),
        format,
        extraction: "segments",
        segmentCount: lines.length,
      };
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error("JSON invalide.");
    }

    const jsonExtraction = extractTextFromTranscriptJson(parsedJson);
    if (!jsonExtraction) {
      throw new Error("Fichier non interpretable: aucun texte de transcription detecte.");
    }

    logger.info("[llm-api][import] parse transcript file success", {
      name: file.name,
      format,
      extraction: jsonExtraction.extraction,
      segmentCount: jsonExtraction.segmentCount ?? null,
      textLength: jsonExtraction.text.length,
    });
    return {
      text: jsonExtraction.text,
      format,
      extraction: jsonExtraction.extraction,
      segmentCount: jsonExtraction.segmentCount,
    };
  } catch (error) {
    logger.error("[llm-api][import] parse transcript file failed", {
      name: file.name,
      sizeBytes: file.size,
      type: file.type,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function resolveFormat(extension: string, mimeType: string): ParsedTranscriptFile["format"] {
  if (extension === ".srt") return "srt";
  if (extension === ".vtt") return "vtt";
  if (extension === ".json") return "json";
  if (extension === ".txt") return "txt";

  const mime = mimeType.toLowerCase();
  if (mime.includes("json")) return "json";
  if (mime.includes("vtt")) return "vtt";
  if (mime.includes("srt") || mime.includes("subrip")) return "srt";
  return "txt";
}

function extractTextFromTranscriptJson(
  parsed: unknown
): { text: string; extraction: ParsedTranscriptFile["extraction"]; segmentCount?: number } | null {
  const segments = readArrayField(parsed, "segments");
  const segmentLines = extractLinesFromRecords(segments);
  if (segmentLines.length > 0) {
    return {
      text: segmentLines.join("\n"),
      extraction: "segments",
      segmentCount: segmentLines.length,
    };
  }

  const results = readArrayField(parsed, "results");
  const resultLines = extractLinesFromResults(results);
  if (resultLines.length > 0) {
    return {
      text: resultLines.join("\n"),
      extraction: "results",
      segmentCount: resultLines.length,
    };
  }

  const channels = readArrayField(parsed, "channels");
  const channelLines = extractLinesFromChannels(channels);
  if (channelLines.length > 0) {
    return {
      text: channelLines.join("\n"),
      extraction: "results",
      segmentCount: channelLines.length,
    };
  }

  const topLevel = extractTextField(parsed);
  if (topLevel) {
    return {
      text: topLevel,
      extraction: "transcript",
    };
  }

  const fallbackLines: string[] = [];
  collectFallbackText(parsed, 0, fallbackLines);
  const fallback = dedupeLines(fallbackLines);
  if (fallback.length > 0) {
    return {
      text: fallback.join("\n"),
      extraction: "fallback",
      segmentCount: fallback.length,
    };
  }

  return null;
}

function extractLinesFromResults(results: unknown[]): string[] {
  const lines: string[] = [];
  for (const result of results) {
    const direct = extractTextField(result);
    if (direct) lines.push(direct);

    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    const alternatives = readArrayField(result, "alternatives");
    lines.push(...extractLinesFromRecords(alternatives));
  }
  return dedupeLines(lines);
}

function extractLinesFromChannels(channels: unknown[]): string[] {
  const lines: string[] = [];
  for (const channel of channels) {
    if (!channel || typeof channel !== "object" || Array.isArray(channel)) continue;
    const alternatives = readArrayField(channel, "alternatives");
    lines.push(...extractLinesFromRecords(alternatives));
  }
  return dedupeLines(lines);
}

function extractLinesFromRecords(entries: unknown[]): string[] {
  const lines: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      const line = cleanLine(entry);
      if (line) lines.push(line);
      continue;
    }

    const direct = extractTextField(entry);
    if (direct) lines.push(direct);
  }
  return dedupeLines(lines);
}

function extractTextField(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["transcript", "text", "utterance"]) {
    const candidate = record[key];
    if (typeof candidate === "string") {
      const cleaned = cleanLine(candidate);
      if (cleaned) return cleaned;
    }
  }
  return null;
}

function collectFallbackText(value: unknown, depth: number, lines: string[]) {
  if (depth > MAX_FALLBACK_DEPTH) return;
  if (!value) return;
  if (typeof value === "string") return;

  if (Array.isArray(value)) {
    for (const item of value) {
      collectFallbackText(item, depth + 1, lines);
    }
    return;
  }

  if (typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    if (JSON_TEXT_KEYS.has(key.toLowerCase()) && typeof child === "string") {
      const cleaned = cleanLine(child);
      if (cleaned) lines.push(cleaned);
      continue;
    }
    collectFallbackText(child, depth + 1, lines);
  }
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    const cleaned = cleanLine(line);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

function cleanLine(value: string): string {
  return normalizeText(value);
}

function readArrayField(value: unknown, field: string): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>)[field];
  return Array.isArray(candidate) ? candidate : [];
}

function getExtension(name: string): string {
  const index = name.lastIndexOf(".");
  if (index === -1) return "";
  return name.slice(index).toLowerCase();
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/^\uFEFF/, "").trim();
}

async function readFileAsText(file: File): Promise<string> {
  const candidate = file as File & { text?: () => Promise<string> };
  if (typeof candidate.text === "function") {
    return candidate.text();
  }

  if (typeof FileReader === "undefined") {
    throw new Error("Impossible de lire le fichier.");
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Impossible de lire le fichier."));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  });
}
