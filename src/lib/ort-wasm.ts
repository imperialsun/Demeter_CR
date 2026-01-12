import * as ort from "onnxruntime-web";

// Force ONNXRuntime to prefer WASM when WebGPU is unavailable.
type ExecutionProviderEntry = string | { name: string } | Record<string, unknown>;

const FORCE_WASM_FLAG = "__forceWasmExecutionProvider";

let patchApplied = false;
let originalCreate:
  | ((
      buffer: Parameters<typeof ort.InferenceSession.create>[0],
      options?: Parameters<typeof ort.InferenceSession.create>[1]
    ) => ReturnType<typeof ort.InferenceSession.create>)
  | null = null;

function ensurePatched() {
  if (patchApplied) {
    return;
  }

  originalCreate = ort.InferenceSession.create.bind(ort.InferenceSession);

  ort.InferenceSession.create = async (
    buffer: Parameters<typeof ort.InferenceSession.create>[0],
    options?: Parameters<typeof ort.InferenceSession.create>[1]
  ) => {
    if (!options || !(options as Record<string, unknown>)[FORCE_WASM_FLAG]) {
      return originalCreate!(buffer, options);
    }

    const sanitizedOptions: Record<string, unknown> = { ...options };
    delete sanitizedOptions[FORCE_WASM_FLAG];

    const providers = Array.isArray(sanitizedOptions.executionProviders)
      ? (sanitizedOptions.executionProviders as ExecutionProviderEntry[])
      : [];

    const filtered = providers.filter((provider) => {
      if (typeof provider === "string") {
        return provider === "wasm";
      }
      const name = typeof provider === "object" ? (provider as { name?: string }).name : undefined;
      return name === "wasm";
    });

    if (filtered.length === 0) {
      sanitizedOptions.executionProviders = ["wasm"];
    } else {
      sanitizedOptions.executionProviders = filtered;
    }

    return originalCreate!(
      buffer,
      sanitizedOptions as Parameters<typeof ort.InferenceSession.create>[1]
    );
  };

  patchApplied = true;
}

export function flagWasmSessionOptions(options: Record<string, unknown>) {
  options[FORCE_WASM_FLAG] = true;
  ensurePatched();
}

// Apply a runtime patch to onnxruntime-web's WASM env settings when available.
export function patchOrtWasmEnv(config: Record<string, unknown>) {
  try {
    const env = (ort as unknown as { env?: { wasm?: Record<string, unknown> } }).env;
    if (env?.wasm && typeof env.wasm === "object") {
      Object.assign(env.wasm, config);
    }
  } catch (error) {
    console.warn("patchOrtWasmEnv failed", error);
  }
}


