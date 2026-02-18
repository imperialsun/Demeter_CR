import type { ChunkDefinition } from "@/lib/chunking";
import type { WordSegment } from "@/lib/export";

export interface PipelineInvokeChunk {
  text?: string;
  timestamp?: [number, number];
  probability?: number;
  words?: Array<{
    word?: string;
    text?: string;
    start?: number;
    end?: number;
    timestamp?: [number, number];
    probability?: number;
    score?: number;
  }>;
}

export interface PipelineInvokeResult {
  text?: string;
  chunks?: PipelineInvokeChunk[];
  words?: Array<{
    word?: string;
    text?: string;
    start?: number;
    end?: number;
    timestamp?: [number, number];
    probability?: number;
    score?: number;
  }>;
  [key: string]: unknown;
}

export interface NormalizedAsrSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
  words?: WordSegment[];
}

const MODEL_TOO_LARGE_RE =
  /1261431424|out of memory|oom|insufficient memory|memory limit|cannot allocate|js_out_of_memory|wasm memory|std::bad_alloc|\bbad_alloc\b|error_code:\s*6\b/i;

const DEFAULT_WASM_PATH = "/onnx/";

export function normalizeWhitespace(value: string | undefined | null) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function isModelTooLargeMessage(message: string) {
  return MODEL_TOO_LARGE_RE.test(message);
}

export function resolveWasmExecutionOptions(args: {
  forceSingleThread?: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency?: number;
  wasmPath?: string;
}) {
  const forceSingle = args.forceSingleThread === true;
  let numThreads = 1;
  if (!forceSingle && args.crossOriginIsolated) {
    numThreads = Math.max(2, args.hardwareConcurrency || 2);
  }
  return {
    wasmPaths: args.wasmPath ?? DEFAULT_WASM_PATH,
    numThreads,
    proxy: true,
    simd: true,
    useJsep: false,
  } as const;
}

function normalizeWords(
  rawWords: unknown,
  chunkStart: number
): WordSegment[] | undefined {
  if (!Array.isArray(rawWords)) return undefined;
  const words = rawWords
    .map((wordObj) => {
      const word = wordObj as Record<string, unknown>;
      const start =
        typeof word.start === "number"
          ? word.start
          : Array.isArray(word.timestamp) && typeof word.timestamp[0] === "number"
            ? (word.timestamp[0] as number)
            : 0;
      const end =
        typeof word.end === "number"
          ? word.end
          : Array.isArray(word.timestamp) && typeof word.timestamp[1] === "number"
            ? (word.timestamp[1] as number)
            : start;
      const text = typeof (word.word ?? word.text) === "string" ? String(word.word ?? word.text) : "";
      const confidence =
        typeof word.probability === "number"
          ? word.probability
          : typeof word.score === "number"
            ? word.score
            : undefined;
      return {
        word: text,
        start: chunkStart + start,
        end: chunkStart + end,
        confidence,
      } as WordSegment;
    })
    .filter((word) => word.word.length > 0);
  return words.length ? words : undefined;
}

export function normalizePipelineOutput(args: {
  result: PipelineInvokeResult;
  chunk: ChunkDefinition;
  cleanIntraChunk: boolean;
  cleanText: (value: string | undefined | null) => string;
}) {
  const cleanedText = args.cleanIntraChunk
    ? args.cleanText(args.result.text)
    : normalizeWhitespace(args.result.text);

  let segments: NormalizedAsrSegment[] = Array.isArray(args.result.chunks)
    ? args.result.chunks
        .map((segment) => {
          const timestamp = Array.isArray(segment.timestamp) ? segment.timestamp : undefined;
          const rawStart = timestamp?.[0] ?? 0;
          const rawEnd = timestamp?.[1] ?? args.chunk.end - args.chunk.start;
          const text = args.cleanIntraChunk ? args.cleanText(segment.text) : normalizeWhitespace(segment.text);
          return {
            start: args.chunk.start + rawStart,
            end: args.chunk.start + rawEnd,
            text,
            confidence: segment.probability,
            words: normalizeWords(segment.words, args.chunk.start),
          };
        })
        .filter((segment) => segment.text.length > 0)
    : [
        {
          start: args.chunk.start,
          end: args.chunk.end,
          text: cleanedText,
          words: normalizeWords(args.result.words, args.chunk.start),
        },
      ];

  if (segments.length === 0) {
    segments = [
      {
        start: args.chunk.start,
        end: args.chunk.end,
        text: cleanedText,
      },
    ];
  }

  return {
    cleanedText,
    segments,
  };
}

export function resolveBackendSelectionErrorMessage(args: {
  lastError: unknown;
  webGpuAvailable: boolean;
  wasmAvailable: boolean;
}) {
  const lastMessage =
    args.lastError && typeof args.lastError === "object" && "message" in args.lastError
      ? String((args.lastError as { message?: unknown }).message ?? "")
      : String(args.lastError ?? "");
  let message = lastMessage || "Impossible de charger le pipeline ASR";

  if (!args.webGpuAvailable && !args.wasmAvailable) {
    message =
      "Aucun backend utilisable trouvé : WebGPU non supporté et fichiers WASM manquants ou inaccessibles (/onnx/). Vérifiez que les assets WASM ont bien été déployés et que les en-têtes COOP/COEP sont configurés pour permettre WASM multithread (SharedArrayBuffer).";
  } else if (!args.webGpuAvailable && args.wasmAvailable && /WASM/i.test(lastMessage)) {
    message = `Erreur d'initialisation WASM : ${lastMessage}. Vérifiez la disponibilité des assets et les en-têtes COOP/COEP.`;
  }
  return message;
}

