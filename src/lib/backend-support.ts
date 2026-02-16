import { useAsrStore } from "@/store/asr-store";
import logger from "@/lib/logger";

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
  if (typeof window === "undefined") {
    logger.info("checkWasmAssets: skipped (non-browser)");
    return false;
  }
  const candidates = [
    "/onnx/ort-wasm-simd-threaded.jsep.wasm",
    "/onnx/ort-wasm-simd-threaded.wasm",
    "/onnx/ort-wasm-simd-threaded.asyncify.wasm",
    "/onnx/ort-wasm-simd.jsep.wasm",
    "/onnx/ort-wasm-simd.wasm",
  ];
  for (const url of candidates) {
    try {
      // Diagnostic logging to help debug deployment and caching issues
      logger.debug("checkWasmAssets: testing", { url });
      const resp = await fetch(url, { method: "GET" });
      logger.debug("checkWasmAssets: response", {
        url,
        ok: resp?.ok,
        status: resp?.status,
        type: resp?.type,
        contentType: resp?.headers?.get?.("content-type"),
      });
      // Treat only a successful non-opaque response as available
      if (resp && resp.ok && resp.type !== 'opaque') {
        logger.info("checkWasmAssets: found wasm", { url });
        return true;
      }
      if (resp && resp.ok && resp.type === 'opaque') {
        logger.warn("checkWasmAssets: wasm response is opaque (possible service worker or cross-origin issue)", { url });
      }
    } catch (err) {
      logger.warn("checkWasmAssets: fetch failed", { url, err });
    }
  }
  logger.info("checkWasmAssets: no wasm asset found");
  return false;
}

export async function initializeBackendSupport(): Promise<boolean> {
  const supported = await detectWebGpuSupport();
  const { setWebGpuSupport, setBackendPreference, setWasmAvailable } = useAsrStore.getState();
  setWebGpuSupport(supported);

  // Check WASM assets availability so we can skip attempting WASM when missing.
  const wasmAvailable = await checkWasmAssets();
  setWasmAvailable(wasmAvailable);

  // Run multithreaded WASM test when WASM is available (store result for later use)
  try {
    const res = await testWasmMultithreadSupport(1000);
    if (res.ok) {
      // Choose a reasonable thread count based on hardware, default to 2
      const threads = typeof navigator !== "undefined" ? Math.max(2, navigator.hardwareConcurrency || 2) : 2;
      useAsrStore.getState().setWasmThreads(threads);
    } else {
      useAsrStore.getState().setWasmThreads(null);
    }
    // Emit telemetry if available
    try {
      const telemetry = useAsrStore.getState().telemetryCollector;
      if (telemetry?.logEvent) telemetry.logEvent("WASM_MULTITHREAD_TEST", { ok: res.ok, reason: res.reason });
    } catch (err) {
      void err;
    }
  } catch (err) {
    void err;
    useAsrStore.getState().setWasmThreads(null);
  }

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
  if (((window as unknown) as { crossOriginIsolated?: boolean }).crossOriginIsolated !== true) return { ok: false, reason: "not_cross_origin_isolated" };
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
        const data = ev.data as unknown as { ok?: boolean; err?: unknown } | undefined;
        if (data && data.ok) resolve({ ok: true });
        else resolve({ ok: false, reason: String(data?.err ?? 'worker_failed') });
      };
      worker.onerror = (e) => {
        if (timedOut) return;
        clearTimeout(timer);
        worker.terminate();
        URL.revokeObjectURL(url);
        const errMsg = (e as ErrorEvent)?.message ?? (e as unknown as { message?: string })?.message ?? 'worker_error';
        resolve({ ok: false, reason: String(errMsg) });
      };
      // post the SAB to worker
      worker.postMessage(sab);
    } catch (err) {
      if (timedOut) return;
      clearTimeout(timer);
      try { URL.revokeObjectURL(url); } catch (err) { void err; }
      resolve({ ok: false, reason: String(((err as unknown) as { message?: string })?.message ?? err) });
    }
  });
}
