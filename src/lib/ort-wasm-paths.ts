export const ORT_WASM_BINARY_PATH = "/onnx/ort-wasm-simd-threaded.jsep.wasm" as const;

export function createOrtWasmPaths(wasmBinaryPath: string = ORT_WASM_BINARY_PATH) {
  return {
    wasm: wasmBinaryPath,
  };
}
