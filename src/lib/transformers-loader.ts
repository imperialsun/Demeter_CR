import type { AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import { setTransformersVersion } from "@/lib/telemetry";
import logger from "@/lib/logger";


type GenericPipeline = {
  dispose?: () => void | Promise<void>;
};

type TransformersModule = typeof import("@huggingface/transformers");

import * as ort from "onnxruntime-web";

let transformersPromise: Promise<TransformersModule> | null = null;
let ortPromise: Promise<typeof ort> | null = null;
let environmentConfigured = false;

async function ensureTransformersModule(): Promise<TransformersModule> {
  if (!transformersPromise) {
    logger.info("[asr][transformers-loader] loading transformers module");
    transformersPromise = import("@huggingface/transformers").then(async (module) => {
      const version = resolveTransformersVersion(module);
      setTransformersVersion(version);
      await ensureOrtPatched();
      configureEnvironment(module);
      logger.info("[asr][transformers-loader] transformers module ready", {
        version,
      });
      return module;
    }).catch((error) => {
      // Reset cached promise so a subsequent user action can retry after transient
      // failures (e.g. Vite dev server restart during dependency re-optimization).
      transformersPromise = null;
      logger.error("[asr][transformers-loader] failed to load transformers module", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }
  return transformersPromise;
}

async function ensureOrtPatched() {
  if (!ortPromise) {
    logger.debug("[asr][transformers-loader] patching onnxruntime module");
    // resolve promise immediately with already-imported ort module
    ortPromise = Promise.resolve(ort as typeof ort);
  }
  return ortPromise;
}

function resolveTransformersVersion(module: TransformersModule): string {
  const version = (module as { env?: { version?: unknown } }).env?.version;
  return typeof version === "string" ? version : "unknown";
}

function configureEnvironment(module: TransformersModule) {
  if (environmentConfigured) return;
  const env = (module as { env?: unknown }).env;
  if (!env || typeof env !== "object") {
    logger.warn("[asr][transformers-loader] unable to configure environment: env object missing");
    return;
  }
  type BackendsMap = Record<string, Record<string, unknown>>;
  const envMutable = env as {
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
    backends?: BackendsMap;
  };
  envMutable.allowLocalModels = false;
  envMutable.useBrowserCache = true;
  const backends = (envMutable.backends ??= {}) as BackendsMap;
  const onnxBackends = (backends.onnx ??= {}) as Record<string, unknown>;
  const wasmBackend = (onnxBackends.wasm ??= {}) as Record<string, unknown>;
  onnxBackends.webgpu = onnxBackends.webgpu ?? {};

  wasmBackend.wasmPaths = wasmBackend.wasmPaths ?? "/onnx/";
  // Default to single-threaded, proxy worker on, no-JSEP to avoid COEP requirements while keeping UI responsive.
  wasmBackend.proxy = true;
  wasmBackend.useJsep = false;
  wasmBackend.simd = true;
  wasmBackend.numThreads = 1;
  environmentConfigured = true;
  logger.info("[asr][transformers-loader] environment configured", {
    allowLocalModels: envMutable.allowLocalModels ?? false,
    useBrowserCache: envMutable.useBrowserCache ?? true,
    wasmProxy: wasmBackend.proxy,
    wasmUseJsep: wasmBackend.useJsep,
    wasmSimd: wasmBackend.simd,
    wasmThreads: wasmBackend.numThreads,
    wasmPaths: typeof wasmBackend.wasmPaths === "string" ? wasmBackend.wasmPaths : "custom",
  });
}



export async function loadTransformers() {
  return ensureTransformersModule();
}

export type { AutomaticSpeechRecognitionPipeline, GenericPipeline };
