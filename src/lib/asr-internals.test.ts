import { describe, expect, it } from "vitest";

import {
  isModelTooLargeMessage,
  isWebGpuRuntimeIncompatibilityError,
  isWebGpuRuntimeIncompatibilityMessage,
  normalizePipelineOutput,
  normalizeWhitespace,
  resolveBackendSelectionErrorMessage,
  resolveWasmExecutionOptions,
} from "@/lib/asr-internals";
import { ORT_WASM_BINARY_PATH } from "@/lib/ort-wasm-paths";

describe("asr-internals", () => {
  it("normalizes whitespace", () => {
    expect(normalizeWhitespace("  a   b   c  ")).toBe("a b c");
    expect(normalizeWhitespace("")).toBe("");
    expect(normalizeWhitespace(undefined)).toBe("");
  });

  it("detects model-too-large messages", () => {
    expect(isModelTooLargeMessage("std::bad_alloc")).toBe(true);
    expect(isModelTooLargeMessage("out of memory")).toBe(true);
    expect(isModelTooLargeMessage("error_code: 6")).toBe(true);
    expect(isModelTooLargeMessage("network timeout")).toBe(false);
  });

  it("detects webgpu runtime shape-incompatibility messages", () => {
    const message =
      "failed to call OrtRun(). ERROR_CODE: 1, ERROR_MESSAGE: /onnxruntime/core/providers/webgpu/program.cc:247 TensorShape ... Cannot reduce shape {1280,51866} by component=4";
    expect(isWebGpuRuntimeIncompatibilityMessage(message)).toBe(true);
    expect(isWebGpuRuntimeIncompatibilityError(new Error(message))).toBe(true);
    expect(isWebGpuRuntimeIncompatibilityMessage("network timeout")).toBe(false);
  });

  it("builds wasm execution options with multithread support", () => {
    const opts = resolveWasmExecutionOptions({
      forceSingleThread: false,
      crossOriginIsolated: true,
      hardwareConcurrency: 8,
      wasmBinaryPath: ORT_WASM_BINARY_PATH,
    });
    expect(opts).toMatchObject({
      wasmPaths: {
        wasm: ORT_WASM_BINARY_PATH,
      },
      numThreads: 8,
      proxy: false,
      simd: true,
      useJsep: false,
    });
  });

  it("forces single-thread wasm when requested", () => {
    const opts = resolveWasmExecutionOptions({
      forceSingleThread: true,
      crossOriginIsolated: true,
      hardwareConcurrency: 12,
    });
    expect(opts.numThreads).toBe(1);
  });

  it("normalizes pipeline output from chunk list and words", () => {
    const out = normalizePipelineOutput({
      result: {
        text: "  texte global  ",
        chunks: [
          {
            text: "  Bonjour  ",
            timestamp: [0.1, 0.4],
            probability: 0.8,
            words: [
              { word: "Bon", start: 0.1, end: 0.2, probability: 0.7 },
              { text: "jour", timestamp: [0.2, 0.4], score: 0.9 },
            ],
          },
        ],
      },
      chunk: {
        id: "c1",
        index: 0,
        start: 5,
        end: 6,
        paddedStart: 5,
        paddedEnd: 6,
      },
      cleanIntraChunk: false,
      cleanText: (value) => String(value ?? "").trim(),
    });

    expect(out.cleanedText).toBe("texte global");
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({
      start: 5.1,
      end: 5.4,
      text: "Bonjour",
      confidence: 0.8,
    });
    expect(out.segments[0]?.words).toHaveLength(2);
    expect(out.segments[0]?.words?.[0]).toMatchObject({
      word: "Bon",
      start: 5.1,
      end: 5.2,
      confidence: 0.7,
    });
    expect(out.segments[0]?.words?.[1]).toMatchObject({
      word: "jour",
      start: 5.2,
      end: 5.4,
      confidence: 0.9,
    });
  });

  it("returns fallback segment when chunk text list is empty", () => {
    const out = normalizePipelineOutput({
      result: {
        text: "  Fallback phrase ",
        chunks: [],
      },
      chunk: {
        id: "c2",
        index: 1,
        start: 10,
        end: 12,
        paddedStart: 10,
        paddedEnd: 12,
      },
      cleanIntraChunk: true,
      cleanText: (value) => String(value ?? "").replace(/\s+/g, " ").trim(),
    });

    expect(out.cleanedText).toBe("Fallback phrase");
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]).toMatchObject({
      start: 10,
      end: 12,
      text: "Fallback phrase",
    });
  });

  it("builds backend selection message with explicit fallback guidance", () => {
    expect(
      resolveBackendSelectionErrorMessage({
        lastError: new Error("WASM init error"),
        webGpuAvailable: false,
        wasmAvailable: true,
      })
    ).toContain("Erreur d'initialisation WASM");

    expect(
      resolveBackendSelectionErrorMessage({
        lastError: null,
        webGpuAvailable: false,
        wasmAvailable: false,
      })
    ).toContain("Aucun backend utilisable");
  });

  it("surfaces a CSP-specific guidance message for wasm failures", () => {
    const message = resolveBackendSelectionErrorMessage({
      lastError: new Error(
        "RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): Compiling or instantiating WebAssembly module violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: )"
      ),
      webGpuAvailable: false,
      wasmAvailable: true,
    });

    expect(message).toContain("wasm-unsafe-eval");
    expect(message).toContain("CSP");
  });
});
