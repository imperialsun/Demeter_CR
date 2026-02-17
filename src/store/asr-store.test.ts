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
import {
  createDefaultLocalModelSettingsByProfile,
  getLocalLlmModelProfile,
} from "@/lib/llm/localModelCatalog";

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
      llmLocalSettingsByProfile: undefined,
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
      llmLocalSettingsByProfile: undefined,
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

  it("hydrates llm local profile settings", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      llmLocalSettingsByProfile: undefined,
      llmLocalModelProfile: "ministral_3_3b",
      llmLocalModelId: "mistralai/Ministral-3-3B-Instruct-2512-ONNX",
      llmLocalMaxTokens: 4096,
      llmLocalTemperature: 0.4,
      llmLocalBackendPreference: "webgpu",
    };

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.llmLocalModelProfile).toBe("ministral_3_3b");
    expect(state.llmLocalModelId).toContain("Ministral-3-3B");
    expect(state.llmLocalMaxTokens).toBe(4096);
    expect(state.llmLocalTemperature).toBe(0.4);
  });

  it("hydrates llm local settings map when provided", () => {
    const defaults = createDefaultLocalModelSettingsByProfile();
    const payload = {
      ...DEFAULT_SETTINGS,
      llmLocalModelProfile: "ministral_3_3b",
      llmLocalSettingsByProfile: {
        qwen_1_7b: {
          ...defaults.qwen_1_7b,
          temperature: 0.7,
          maxTokens: 2048,
        },
        ministral_3_3b: {
          ...defaults.ministral_3_3b,
          modelId: "mistralai/Ministral-3-3B-Instruct-2512-ONNX",
          temperature: 0.3,
          maxTokens: 4096,
          appendNoThinkDirective: true,
        },
      },
    };

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.temperature).toBe(0.7);
    expect(state.llmLocalSettingsByProfile.ministral_3_3b.temperature).toBe(0.3);
    expect(state.llmLocalModelProfile).toBe("ministral_3_3b");
    expect(state.llmLocalModelId).toContain("Ministral-3-3B");
    expect(state.llmLocalTemperature).toBe(0.3);
    expect(state.llmLocalMaxTokens).toBe(4096);
  });

  it("keeps llm local settings isolated per profile and syncs legacy mirror", () => {
    useAsrStore.getState().resetApp();

    useAsrStore.getState().setLlmLocalModelSettings("qwen_1_7b", {
      temperature: 0.8,
      maxTokens: 99999,
    });
    useAsrStore.getState().setLlmLocalModelSettings("ministral_3_3b", {
      temperature: 0.25,
      maxTokens: 2048,
    });

    const qwenLimit = getLocalLlmModelProfile("qwen_1_7b").maxGenerationTokens;
    let state = useAsrStore.getState();
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.maxTokens).toBe(qwenLimit);
    expect(state.llmLocalSettingsByProfile.ministral_3_3b.maxTokens).toBe(2048);

    useAsrStore.getState().setLlmLocalModelProfile("ministral_3_3b");
    state = useAsrStore.getState();
    expect(state.llmLocalTemperature).toBe(0.25);
    expect(state.llmLocalMaxTokens).toBe(2048);
    expect(state.llmLocalModelId).toBe(state.llmLocalSettingsByProfile.ministral_3_3b.modelId);
  });
});
