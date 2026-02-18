import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const create = vi.fn(async (_buffer: unknown, options?: Record<string, unknown>) => ({
    options,
  }));
  return {
    create,
    ort: {
      InferenceSession: {
        create,
      },
      env: {
        wasm: {
          numThreads: 1,
        },
      },
    },
    loggerWarn: vi.fn(() => {}),
  };
});

vi.mock("onnxruntime-web", () => mocks.ort);

vi.mock("@/lib/logger", () => ({
  default: {
    warn: mocks.loggerWarn,
  },
}));

describe("ort-wasm helpers", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.create.mockClear();
    mocks.loggerWarn.mockClear();
    mocks.ort.env.wasm = { numThreads: 1 };
  });

  it("flags options and enforces wasm provider during session create", async () => {
    const { flagWasmSessionOptions } = await import("@/lib/ort-wasm");
    const options: Record<string, unknown> = {
      executionProviders: ["webgpu", "wasm"],
    };

    flagWasmSessionOptions(options);
    await mocks.ort.InferenceSession.create("dummy-model", options);

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const [, forwardedOptions] = mocks.create.mock.calls[0]!;
    expect(forwardedOptions?.executionProviders).toEqual(["wasm"]);
  });

  it("patches ort wasm env config", async () => {
    const { patchOrtWasmEnv } = await import("@/lib/ort-wasm");

    patchOrtWasmEnv({ numThreads: 4, proxy: true });

    expect(mocks.ort.env.wasm).toMatchObject({
      numThreads: 4,
      proxy: true,
    });
  });
});

