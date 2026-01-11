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

/**
 * Perform a lightweight runtime test to determine if multithreaded WASM is usable.
 * Checks crossOriginIsolated, SharedArrayBuffer and attempts a small worker + Atomics
 */
export async function testWasmMultithreadSupport(timeoutMs = 1000): Promise<{ ok: boolean; reason?: string }> {
  if (typeof window === "undefined") return { ok: false, reason: "no-window" };
  if ((window as any).crossOriginIsolated !== true) return { ok: false, reason: "not_cross_origin_isolated" };
  if (typeof SharedArrayBuffer === "undefined") return { ok: false, reason: "no_SAB" };
  // try worker roundtrip using SharedArrayBuffer and Atomics
  return await new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      resolve({ ok: false, reason: "timeout" });
    }, timeoutMs);

    const blob = new Blob([
      `self.onmessage = function(e) { try { const sab = e.data; const v = new Int32Array(sab); Atomics.add(v, 0, 1); postMessage({ok:true}); } catch (err) { postMessage({ok:false, err: String(err)}); } }`
    ], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      const worker = new Worker(url);
      const sab = new SharedArrayBuffer(4);
      worker.onmessage = (ev) => {
        if (timedOut) return;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        const data = ev.data as any;
        if (data && data.ok) resolve({ ok: true });
        else resolve({ ok: false, reason: data?.err ?? 'worker_failed' });
      };
      worker.onerror = (e) => {
        if (timedOut) return;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve({ ok: false, reason: String(e?.message ?? 'worker_error') });
      };
      // post the SAB to worker
      worker.postMessage(sab);
    } catch (err: any) {
      if (timedOut) return;
      clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch (e) {}
      resolve({ ok: false, reason: String(err?.message ?? err) });
    }
  });
}
