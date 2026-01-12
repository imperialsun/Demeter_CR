import type { AutomaticSpeechRecognitionPipeline, Pipeline as GenericPipeline } from "@huggingface/transformers";
import { setTransformersVersion } from "@/lib/telemetry";



type TransformersModule = typeof import("@huggingface/transformers");

import * as ort from "onnxruntime-web";

let transformersPromise: Promise<TransformersModule> | null = null;
let ortPromise: Promise<typeof ort> | null = null;
let environmentConfigured = false;

async function ensureTransformersModule(): Promise<TransformersModule> {
  if (!transformersPromise) {
    transformersPromise = import("@huggingface/transformers").then(async (module) => {
      setTransformersVersion(typeof module.env?.version === "string" ? module.env.version : "unknown");
      await ensureOrtPatched();
      configureEnvironment(module);
      return module;
    });
  }
  return transformersPromise;
}

async function ensureOrtPatched() {
  if (!ortPromise) {
    // resolve promise immediately with already-imported ort module
    ortPromise = Promise.resolve(ort as typeof ort);
  }
  return ortPromise;
}

function configureEnvironment(module: TransformersModule) {
  if (environmentConfigured) return;
  const { env } = module;
  type BackendsMap = Record<string, Record<string, unknown>>;
  const envMutable = env as unknown as {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
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
}



export async function loadTransformers() {
  return ensureTransformersModule();
}

export type { AutomaticSpeechRecognitionPipeline, GenericPipeline };
