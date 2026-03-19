import type { ChunkDefinition } from "@/lib/chunking";
import type { WordSegment } from "@/lib/export";
import { createOrtWasmPaths } from "@/lib/ort-wasm-paths";

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
const WEBGPU_RUNTIME_RE = /onnxruntime::webgpu|\/providers\/webgpu\/|webgpu\/program\.cc/i;
const WEBGPU_ALIGNMENT_RE =
  /cannot reduce shape|getreducedshape|component\s*=\s*4|%\s*component\s*==\s*0\s*was\s*false/i;
const WASM_CSP_RE = /content security policy|wasm-unsafe-eval|unsafe-eval/i;

export function normalizeWhitespace(value: string | undefined | null) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function isModelTooLargeMessage(message: string) {
  return MODEL_TOO_LARGE_RE.test(message);
}

export function isWebGpuRuntimeIncompatibilityMessage(message: string) {
  if (!message) return false;
  const hasExplicitShapeSignature =
    /cannot reduce shape\s*\{[^}]+\}\s*by component\s*=\s*4/i.test(message);
  if (hasExplicitShapeSignature) return true;
  return WEBGPU_RUNTIME_RE.test(message) && WEBGPU_ALIGNMENT_RE.test(message);
}

export function isWebGpuRuntimeIncompatibilityError(error: unknown) {
  if (error === undefined || error === null) return false;
  const message =
    typeof error === "string"
      ? error
      : typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error);
  return isWebGpuRuntimeIncompatibilityMessage(message);
}

export function resolveWasmExecutionOptions(args: {
  forceSingleThread?: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency?: number;
  wasmBinaryPath?: string;
}) {
  const forceSingle = args.forceSingleThread === true;
  let numThreads = 1;
  if (!forceSingle && args.crossOriginIsolated) {
    numThreads = Math.max(2, args.hardwareConcurrency || 2);
  }
  return {
    wasmPaths: createOrtWasmPaths(args.wasmBinaryPath),
    numThreads,
    // Keep WASM execution on the main thread to avoid the proxy-worker bundle path.
    proxy: false,
    simd: true,
    useJsep: false,
  } as const;
}

export function isWasmCspBlockedMessage(message: string) {
  return WASM_CSP_RE.test(message);
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
  } else if (!args.webGpuAvailable && args.wasmAvailable && isWasmCspBlockedMessage(lastMessage)) {
    message =
      `Erreur d'initialisation WASM : ${lastMessage}. La CSP bloque la compilation WebAssembly. Ajoutez 'wasm-unsafe-eval' à script-src sur la réponse HTML, ou desserrez la policy du reverse proxy.`;
  } else if (!args.webGpuAvailable && args.wasmAvailable && /WASM/i.test(lastMessage)) {
    message = `Erreur d'initialisation WASM : ${lastMessage}. Vérifiez la disponibilité des assets et les en-têtes COOP/COEP.`;
  }
  return message;
}
