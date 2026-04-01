import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { waitFor } from "@testing-library/react";
import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import {
  type AsrConfigStore,
  MODEL_PRESETS,
  useAsrStore,
  resolveEffectiveModelDtype,
  resolveModelDtype,
  resolveModelId,
  serializePersistedSettings,
} from "./asr-store";
import { DEFAULT_SETTINGS, loadSettings, PERSISTED_SETTINGS_KEYS } from "@/lib/storage";
import { clearSecureTokens, loadSecureTokens, saveSecureTokens } from "@/lib/secure-token-vault";
import {
  createDefaultLocalModelSettingsByProfile,
  getLocalLlmModelProfile,
} from "@/lib/llm/localModelCatalog";
import { SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY } from "@/lib/sessionTranscriptMemory";

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
    window.sessionStorage.clear();
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

  it("hydrates an empty persisted blob with canonical defaults and no undefined settings", () => {
    window.localStorage.setItem(storageKey, JSON.stringify({}));
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.memoryMode).toBe(DEFAULT_SETTINGS.memoryMode);
    expect(state.chunkStrategy).toBe(DEFAULT_SETTINGS.chunkStrategy);
    expect(state.segmentationMode).toBe(DEFAULT_SETTINGS.segmentationMode);
    expect(state.chunkDurationSec).toBe(DEFAULT_SETTINGS.chunkDurationSec);
    expect(state.overlapSec).toBe(DEFAULT_SETTINGS.overlapSec);
    expect(state.maxChunkMs).toBe(DEFAULT_SETTINGS.maxChunkMs);
    expect(state.autoTunePreprocess).toBe(DEFAULT_SETTINGS.autoTunePreprocess);

    const serialized = serializePersistedSettings(state);
    for (const key of PERSISTED_SETTINGS_KEYS) {
      expect(serialized[key]).not.toBeUndefined();
    }
  });

  it("hydrates session transcript memories from sessionStorage", () => {
    window.sessionStorage.setItem(
      SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY,
      JSON.stringify({
        upload: {
          mode: "upload",
          provider: "upload",
          label: "Locale · demo.wav",
          transcriptText: "Bonjour",
          segmentCount: 1,
          audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
          audioMetadata: null,
          updatedAt: "2026-03-12T10:00:00.000Z",
        },
        mic: null,
        cloud: null,
      })
    );

    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.sessionTranscriptMemories.upload?.label).toBe("Locale · demo.wav");
    expect(state.sessionTranscriptMemories.upload?.transcriptText).toBe("Bonjour");
    expect(state.sessionTranscriptMemories.upload?.segmentCount).toBe(1);
    expect(state.sessionTranscriptMemories.cloud).toBeNull();
    expect(state.sessionTranscriptMemories.mic).toBeNull();
  });

  it("falls back to frontend defaults for missing backend settings while keeping provided values", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        activePreset: "balanced",
        chunkDurationSec: 42,
      })
    );

    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.activePreset).toBe("balanced");
    expect(state.chunkDurationSec).toBe(42);
    expect(state.memoryMode).toBe(DEFAULT_SETTINGS.memoryMode);
    expect(state.chunkStrategy).toBe(DEFAULT_SETTINGS.chunkStrategy);
    expect(state.overlapSec).toBe(DEFAULT_SETTINGS.overlapSec);
    expect(state.maxChunkMs).toBe(DEFAULT_SETTINGS.maxChunkMs);
    expect(state.micPreprocessVadThresholdDb).toBe(DEFAULT_SETTINGS.micPreprocessVadThresholdDb);
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

  it("rewrites a full canonical payload after mutating a partial legacy blob", () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        llmApiProvider: "huggingface",
        llmApiModelId: "legacy/hf-model",
        llmApiTemperature: 0.6,
        llmApiMaxTokens: 7777,
        debugConfidence: true,
      })
    );

    useAsrStore.getState().hydrateFromStorage();
    useAsrStore.getState().setShowSegments(false);

    const persisted = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([...PERSISTED_SETTINGS_KEYS].sort());
    expect(persisted.showSegments).toBe(false);
    expect(persisted.autoTunePreprocess).toBe(DEFAULT_SETTINGS.autoTunePreprocess);
    expect(persisted.debugConfidence).toBeUndefined();
    expect(persisted.llmApiModelId).toBeUndefined();
    expect(persisted.llmApiTemperature).toBeUndefined();
    expect(persisted.llmApiMaxTokens).toBeUndefined();
    expect(persisted.llmApiHfModelId).toBe("legacy/hf-model");
    expect(persisted.llmApiHfTemperature).toBe(0.6);
    expect(persisted.llmApiHfMaxTokens).toBe(7777);
  });

  it("does not persist llm api report drafts", () => {
    window.localStorage.setItem(storageKey, JSON.stringify(DEFAULT_SETTINGS));
    useAsrStore.getState().hydrateFromStorage();

    const before = window.localStorage.getItem(storageKey);
    useAsrStore.getState().setLlmApiReportDraft("cri", {
      format: "CRI",
      title: "Titre modifie",
      sections: [{ heading: "Contexte", paragraphs: ["Paragraphe"] }],
    });

    const after = window.localStorage.getItem(storageKey);
    expect(after).toBe(before);
    expect(JSON.parse(after ?? "{}").llmApiReportDrafts).toBeUndefined();
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

  it("migrates demeter cloud settings from legacy mistral fields when dedicated keys are absent", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      cloudDemeterModel: undefined,
      cloudDemeterDiarizationEnabled: undefined,
      cloudMistralModel: "voxtral-mini-transcribe-26-02",
      cloudMistralDiarizationEnabled: false,
    };

    window.localStorage.setItem(storageKey, JSON.stringify(payload));
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.cloudMistralModel).toBe("voxtral-mini-latest");
    expect(state.cloudDemeterModel).toBe("voxtral-mini-latest");
    expect(state.cloudDemeterDiarizationEnabled).toBe(false);
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

describe("secure token vault hydration", () => {
  const storageKey = "demeter-asr-settings";
  let originalIndexedDb: IDBFactory | undefined;
  let originalLocalStorage: Storage | undefined;

  beforeEach(async () => {
    originalIndexedDb = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDb,
      configurable: true,
    });

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

    await clearSecureTokens();
    window.localStorage.clear();
    window.sessionStorage.clear();
    useAsrStore.getState().resetApp();
    useAsrStore.setState({ hasHydrated: false } as Partial<AsrConfigStore>);
  });

  afterEach(async () => {
    await clearSecureTokens();
    if (originalIndexedDb) {
      Object.defineProperty(globalThis, "indexedDB", {
        value: originalIndexedDb,
        configurable: true,
      });
    }
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
      });
    }
  });

  it("restores secure tokens from vault and keeps local storage sensitive-free", async () => {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        hfApiToken: "hf_local_storage",
        mistralApiKey: "mistral_local_storage",
      })
    );
    await saveSecureTokens({
      hfApiToken: "hf_secure",
      mistralApiKey: "mistral_secure",
    });

    useAsrStore.getState().hydrateFromStorage();

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.hfApiToken).toBe("hf_secure");
      expect(state.mistralApiKey).toBe("mistral_secure");
    });

    const persisted = JSON.parse(window.localStorage.getItem(storageKey) ?? "{}") as Record<string, unknown>;
    expect(persisted.hfApiToken).toBeUndefined();
    expect(persisted.mistralApiKey).toBeUndefined();
    expect(persisted.cloudHfToken).toBeUndefined();
    expect(persisted.cloudMistralApiKey).toBeUndefined();
  });

  it("clears secure tokens from vault on resetApp", async () => {
    await saveSecureTokens({
      hfApiToken: "hf_secure",
      mistralApiKey: "mistral_secure",
    });

    useAsrStore.setState({
      hfApiToken: "hf_secure",
      mistralApiKey: "mistral_secure",
      hasHydrated: true,
    } as Partial<AsrConfigStore>);

    useAsrStore.getState().resetApp();

    await waitFor(async () => {
      await expect(loadSecureTokens()).resolves.toBeNull();
    });

    const state = useAsrStore.getState();
    expect(state.hfApiToken).toBe("");
    expect(state.mistralApiKey).toBe("");
  });
});
