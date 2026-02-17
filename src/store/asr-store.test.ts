import { beforeEach, afterEach, describe, it, expect } from "vitest";
import {
  type AsrConfigStore,
  MODEL_PRESETS,
  normalizeCloudApiUrl,
  useAsrStore,
  resolveEffectiveModelDtype,
  resolveModelDtype,
  resolveModelId,
} from "./asr-store";
import { DEFAULT_SETTINGS, loadSettings } from "@/lib/storage";

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
    expect(resolveModelId("mms", "")).toBe("Xenova/mms-1b-all");
    expect(resolveModelId("turbo", "")).toBe("onnx-community/whisper-large-v3-turbo");
  });

  it("returns custom model id when provided", () => {
    expect(resolveModelId("custom", "  user/model-id  ")).toBe("user/model-id");
  });

  it("falls back to fast preset model id when custom is empty", () => {
    expect(resolveModelId("custom", "   ")).toBe(MODEL_PRESETS.fast.modelId);
  });

  it("resolves quantization by preset and backend", () => {
    expect(resolveModelDtype("fast", "webgpu")).toBe("q8");
    expect(resolveModelDtype("balanced", "wasm")).toBe("q8");
    expect(resolveModelDtype("quality", "webgpu")).toBe("q8");
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

describe("llm provider config hydration", () => {
  const storageKey = "demeter-asr-settings";
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    originalLocalStorage = window.localStorage;
    const store: Record<string, string> = {};
    const localStorageMock = {
      getItem: (key: string) => (key in store ? store[key]! : null),
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
      clear: () => {
        for (const key of Object.keys(store)) {
          delete store[key];
        }
      },
      key: (index: number) => Object.keys(store)[index] ?? null,
      get length() {
        return Object.keys(store).length;
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    window.localStorage.clear();
    useAsrStore.getState().resetApp();
    useAsrStore.setState({ hasHydrated: false } as Partial<AsrConfigStore>);
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
      });
    }
  });

  it("migrates legacy llm fields into hugging face config when provider is huggingface", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      llmApiProvider: "huggingface" as const,
      llmApiModelId: "legacy/hf-model",
      llmApiTemperature: 0.6,
      llmApiMaxTokens: 7777,
      llmApiHfModelId: null,
      llmApiHfTemperature: null,
      llmApiHfMaxTokens: null,
    } as unknown as Record<string, unknown>;

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    expect(loadSettings()?.llmApiProvider).toBe("huggingface");
    expect(loadSettings()?.llmApiModelId).toBe("legacy/hf-model");
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.llmApiProvider).toBe("huggingface");
    expect(state.llmApiHfModelId).toBe("legacy/hf-model");
    expect(state.llmApiHfTemperature).toBe(0.6);
    expect(state.llmApiHfMaxTokens).toBe(7777);
    expect(state.llmApiMistralModelId).toBe(DEFAULT_SETTINGS.llmApiMistralModelId);
  });

  it("migrates legacy llm fields into mistral config when provider is mistral", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      llmApiProvider: "mistral" as const,
      llmApiModelId: "legacy/mistral-model",
      llmApiTemperature: 0.4,
      llmApiMaxTokens: 4444,
      llmApiMistralModelId: null,
      llmApiMistralTemperature: null,
      llmApiMistralMaxTokens: null,
    } as unknown as Record<string, unknown>;

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    expect(loadSettings()?.llmApiProvider).toBe("mistral");
    expect(loadSettings()?.llmApiModelId).toBe("legacy/mistral-model");
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.llmApiProvider).toBe("mistral");
    expect(state.llmApiMistralModelId).toBe("legacy/mistral-model");
    expect(state.llmApiMistralTemperature).toBe(0.4);
    expect(state.llmApiMistralMaxTokens).toBe(4444);
    expect(state.llmApiHfModelId).toBe(DEFAULT_SETTINGS.llmApiHfModelId);
  });
});
