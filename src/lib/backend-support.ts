import { useAsrStore } from "@/store/asr-store";

let webGpuSupportPromise: Promise<boolean> | null = null;

function requestWebGpuSupport(): Promise<boolean> {
  if (typeof navigator === "undefined") {
    return Promise.resolve(false);
  }
  const candidate = navigator as Navigator & {
    gpu?: { requestAdapter?: () => Promise<unknown> };
  };
  if (!candidate.gpu || typeof candidate.gpu.requestAdapter !== "function") {
    return Promise.resolve(false);
  }
  return candidate.gpu
    .requestAdapter()
    .then((adapter) => adapter != null)
    .catch(() => false);
}

export function detectWebGpuSupport(): Promise<boolean> {
  if (!webGpuSupportPromise) {
    webGpuSupportPromise = requestWebGpuSupport();
  }
  return webGpuSupportPromise;
}

export function resetWebGpuSupportCache() {
  webGpuSupportPromise = null;
}

async function checkWasmAssets(): Promise<boolean> {
  const candidates = [
    "/onnx/ort-wasm-simd-threaded.jsep.wasm",
    "/onnx/ort-wasm-simd-threaded.wasm",
      "/onnx/ort-wasm-simd.jsep.wasm",
      "/onnx/ort-wasm-simd.wasm",
  ];
  for (const url of candidates) {
    try {
      const resp = await fetch(url, { method: "GET" });
      if (resp && resp.ok) {
        return true;
      }
    } catch (e) {
      // try next
    }
  }
  return false;
}

export async function initializeBackendSupport(): Promise<boolean> {
  const supported = await detectWebGpuSupport();
  const { setWebGpuSupport, setBackendPreference, setWasmAvailable } = useAsrStore.getState();
  setWebGpuSupport(supported);

  // Check WASM assets availability so we can skip attempting WASM when missing.
  const wasmAvailable = await checkWasmAssets();
  setWasmAvailable(wasmAvailable);

  // choose sensible default preference: prefer webgpu when supported, otherwise wasm only if available
  if (supported) {
    setBackendPreference("webgpu");
  } else if (wasmAvailable) {
    setBackendPreference("wasm");
  } else {
    // neither backend appears runnable; prefer wasm (will fail with clearer message later)
    setBackendPreference("wasm");
  }

  return supported;
}
