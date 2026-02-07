import { describe, it, expect } from "vitest";
import {
  MODEL_PRESETS,
  normalizeCloudApiUrl,
  resolveEffectiveModelDtype,
  resolveModelDtype,
  resolveModelId,
} from "./asr-store";

describe("normalizeCloudApiUrl", () => {
  const fallback = "https://transcode.demeter-sante.fr/gradio";

  it("keeps gradio base paths and trims trailing slashes", () => {
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio", fallback)).toBe(
      "https://transcode.demeter-sante.fr/gradio"
    );
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio/", fallback)).toBe(
      "https://transcode.demeter-sante.fr/gradio"
    );
  });

  it("normalizes gradio api paths back to origin", () => {
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio_api", fallback)).toBe(
      "https://transcode.demeter-sante.fr"
    );
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio_api/info", fallback)).toBe(
      "https://transcode.demeter-sante.fr"
    );
  });

  it("returns fallback on empty inputs", () => {
    expect(normalizeCloudApiUrl("", fallback)).toBe(fallback);
    expect(normalizeCloudApiUrl("   ", fallback)).toBe(fallback);
    expect(normalizeCloudApiUrl(undefined, fallback)).toBe(fallback);
  });
});

describe("preset model resolution", () => {
  it("returns model id for regular presets", () => {
    expect(resolveModelId("fast", "")).toBe("Xenova/whisper-tiny");
    expect(resolveModelId("turbo", "")).toBe("onnx-community/whisper-large-v3-turbo");
  });

  it("returns custom model id when provided", () => {
    expect(resolveModelId("custom", "  user/model-id  ")).toBe("user/model-id");
  });

  it("falls back to fast preset model id when custom is empty", () => {
    expect(resolveModelId("custom", "   ")).toBe(MODEL_PRESETS.fast.modelId);
  });

  it("resolves quantization by preset and backend", () => {
    expect(resolveModelDtype("fast", "webgpu")).toBe("q4");
    expect(resolveModelDtype("balanced", "wasm")).toBe("q8");
    expect(resolveModelDtype("quality", "webgpu")).toBe("fp16");
    expect(resolveModelDtype("turbo", "wasm")).toBe("q8");
  });

  it("prefers user override quantization when provided", () => {
    expect(
      resolveEffectiveModelDtype("fast", "webgpu", {
        fast: { webgpu: "fp16" },
      })
    ).toBe("fp16");
    expect(
      resolveEffectiveModelDtype("fast", "wasm", {
        fast: { webgpu: "fp16" },
      })
    ).toBe("q8");
  });

  it("does not force quantization for custom preset", () => {
    expect(resolveModelDtype("custom", "webgpu")).toBeUndefined();
    expect(resolveModelDtype("custom", "wasm")).toBeUndefined();
  });

  it("defines quantization for both backends on every built-in preset", () => {
    const presets = Object.entries(MODEL_PRESETS);
    for (const [presetName, preset] of presets) {
      expect(preset.quantization.webgpu, `${presetName} webgpu quantization`).toBeTruthy();
      expect(preset.quantization.wasm, `${presetName} wasm quantization`).toBeTruthy();
    }
  });
});
