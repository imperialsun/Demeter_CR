import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    importCount: 0,
  };
  const module = {
    env: {
      version: "4.0.0-test",
      backends: {
        onnx: {
          wasm: {},
        },
      },
    },
    pipeline: vi.fn(async () => ({ dispose: vi.fn() })),
  };
  return {
    state,
    module,
    setTransformersVersion: vi.fn(() => {}),
    ort: {
      InferenceSession: {
        create: vi.fn(async () => ({ ok: true })),
      },
      env: {
        wasm: {},
      },
    },
  };
});

vi.mock("@huggingface/transformers", () => {
  mocks.state.importCount += 1;
  return mocks.module;
});

vi.mock("onnxruntime-web", () => mocks.ort);

vi.mock("@/lib/telemetry", async () => {
  const actual = await vi.importActual("@/lib/telemetry");
  return {
    ...actual,
    setTransformersVersion: mocks.setTransformersVersion,
  };
});

describe("transformers-loader", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.state.importCount = 0;
    mocks.setTransformersVersion.mockClear();
    mocks.module.pipeline.mockClear();
    (mocks.module.env.backends.onnx.wasm as Record<string, unknown>) = {};
  });

  it("loads transformers once and configures environment", async () => {
    const { loadTransformers } = await import("@/lib/transformers-loader");
    const first = await loadTransformers();
    const second = await loadTransformers();

    expect(first).toBe(second);
    expect(mocks.state.importCount).toBe(1);
    expect(mocks.setTransformersVersion).toHaveBeenCalledWith("4.0.0-test");
    expect(mocks.module.env.allowLocalModels).toBe(false);
    expect(mocks.module.env.useBrowserCache).toBe(true);
    expect(mocks.module.env.backends.onnx.wasm).toMatchObject({
      wasmPaths: "/onnx/",
      proxy: true,
      useJsep: false,
      simd: true,
      numThreads: 1,
    });
  });

  it("resets cached promise after an import failure and retries", async () => {
    const { loadTransformers } = await import("@/lib/transformers-loader");
    mocks.setTransformersVersion.mockImplementationOnce(() => {
      throw new Error("boom");
    });

    await expect(loadTransformers()).rejects.toThrow("boom");
    expect(mocks.setTransformersVersion).toHaveBeenCalledTimes(1);

    const module = await loadTransformers();
    expect(module).toBeDefined();
    expect("pipeline" in module).toBe(true);
    expect(typeof module.pipeline).toBe("function");
    expect(mocks.setTransformersVersion).toHaveBeenCalledTimes(2);
  });
});
