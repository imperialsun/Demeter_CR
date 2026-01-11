import type { AutomaticSpeechRecognitionPipeline, Pipeline as GenericPipeline } from "@huggingface/transformers";
import type { InferenceSession } from "onnxruntime-web";
import { setTransformersVersion } from "@/lib/telemetry";

const FALLBACK_MARKER = Symbol("wasmFallback");

type ExecutionProvider = string | { name?: string } | Record<string, unknown>;

type SessionOptions = InferenceSession.SessionOptions & {
  [FALLBACK_MARKER]?: boolean;
};

type TransformersModule = typeof import("@huggingface/transformers");

let transformersPromise: Promise<TransformersModule> | null = null;
let ortPromise: Promise<typeof import("onnxruntime-web")> | null = null;
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
    ortPromise = import("onnxruntime-web").then((ort) => {
      const backend = (ort as { backend?: unknown }).backend as
        | {
            resolveBackendAndExecutionProviders?: (
              options: SessionOptions
            ) => Promise<[unknown, SessionOptions]>;
          }
        | undefined;

      if (backend?.resolveBackendAndExecutionProviders) {
        const originalResolve = backend.resolveBackendAndExecutionProviders.bind(backend);

        backend.resolveBackendAndExecutionProviders = async (options: SessionOptions) => {
          try {
            return await originalResolve(options);
          } catch (error) {
            if (options?.[FALLBACK_MARKER]) {
              throw error;
            }
            const fallbackOptions = withWasmPreference(options);
            return originalResolve(fallbackOptions);
          }
        };
      }

      return ort;
    });
  }
  return ortPromise;
}

function configureEnvironment(module: TransformersModule) {
  if (environmentConfigured) return;
  const { env } = module;
  const envMutable = env as unknown as {
    allowLocalModels: boolean;
    useBrowserCache: boolean;
    backends?: Record<string, any>;
  };
  envMutable.allowLocalModels = false;
  envMutable.useBrowserCache = true;
  const backends = (envMutable.backends ??= {});
  const onnxBackends = (backends.onnx ??= {});
  const wasmBackend = (onnxBackends.wasm ??= {});
  onnxBackends.webgpu = onnxBackends.webgpu ?? {};

  wasmBackend.wasmPaths = wasmBackend.wasmPaths ?? "/onnx/";
  // Default to single-threaded, proxy worker on, no-JSEP to avoid COEP requirements while keeping UI responsive.
  wasmBackend.proxy = true;
  wasmBackend.useJsep = false;
  wasmBackend.simd = true;
  wasmBackend.numThreads = 1;
  environmentConfigured = true;
}

function withWasmPreference(options?: SessionOptions) {
  const base: SessionOptions = { ...(options ?? {}) };
  const executionProviders: ExecutionProvider[] = Array.isArray(base.executionProviders)
    ? base.executionProviders.filter((provider): provider is ExecutionProvider => !!provider)
    : [];

  const sanitizedProviders = executionProviders.filter((provider) => {
    if (typeof provider === "string") {
      return provider !== "webgpu";
    }
    const name = (provider as { name?: string }).name;
    return name !== "webgpu";
  });

  const hasWasm = sanitizedProviders.some((provider) => {
    if (typeof provider === "string") {
      return provider === "wasm";
    }
    const name = (provider as { name?: string }).name;
    return name === "wasm";
  });

  if (!hasWasm) {
    sanitizedProviders.unshift("wasm");
  }

  base.executionProviders = sanitizedProviders;
  base[FALLBACK_MARKER] = true;
  return base;
}

export async function loadTransformers() {
  return ensureTransformersModule();
}

export type { AutomaticSpeechRecognitionPipeline, GenericPipeline };
