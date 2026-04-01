import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportLogEntries, setLogLevelProvider } from "@/lib/logger";
import { DEFAULT_SETTINGS } from "@/lib/storage";
import {
  type AsrConfigStore,
  MODEL_PRESETS,
  normalizeMistralModel,
  resolveLighterPresetForMemoryFallback,
  useAsrStore,
} from "./asr-store";
import { SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY } from "@/lib/sessionTranscriptMemory";

const STORAGE_KEY = "demeter-asr-settings";
let originalLocalStorage: Storage | undefined;

const resetStore = () => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  useAsrStore.getState().resetApp();
  useAsrStore.setState({ hasHydrated: false } as Partial<AsrConfigStore>);
};

describe("asr-store mutation guards", () => {
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
    setLogLevelProvider(() => useAsrStore.getState().logLevel);
    resetStore();
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
      });
    }
    vi.restoreAllMocks();
  });

  it("normalizes mistral models and computes memory fallback presets", () => {
    expect(normalizeMistralModel(" voxtral-mini-transcribe-26-02 ", "fallback")).toBe("voxtral-mini-latest");
    expect(normalizeMistralModel("custom-model", "fallback")).toBe("custom-model");
    expect(normalizeMistralModel("   ", "fallback")).toBe("fallback");

    expect(resolveLighterPresetForMemoryFallback("quality")).toBe("medium");
    expect(resolveLighterPresetForMemoryFallback("custom", ["balanced"])).toBe("fast");
    expect(resolveLighterPresetForMemoryFallback("balanced", ["fast"])).toBeNull();
  });

  it("hydrates empty storage and marks store as hydrated", () => {
    useAsrStore.getState().hydrateFromStorage();
    expect(useAsrStore.getState().hasHydrated).toBe(true);
  });

  it("emits an explicit debug confirmation entry when debug level is enabled", () => {
    const beforeCount = exportLogEntries().length;

    useAsrStore.getState().setLogLevel("debug");

    const entries = exportLogEntries().slice(beforeCount);
    expect(entries.some((entry) => entry.message === "debug logging enabled" && entry.level === "debug")).toBe(true);
  });

  it("persists session transcript memories only in sessionStorage and clears them on reset", () => {
    useAsrStore.setState({ hasHydrated: true } as Partial<AsrConfigStore>);

    const state = useAsrStore.getState();
    state.setSessionTranscriptMemory("upload", {
      mode: "upload",
      provider: "upload",
      label: "Locale · demo.wav",
      transcriptText: "Bonjour",
      segmentCount: 1,
      audioSource: { id: "upload-1", label: "demo.wav", type: "file" },
      audioMetadata: { durationSec: 10, sampleRate: 16000, channels: 1 },
      updatedAt: "2026-03-12T10:00:00.000Z",
    });
    state.setSessionTranscriptMemory("cloud", {
      mode: "cloud",
      provider: "mistral",
      label: "Cloud Mistral · demo.wav",
      transcriptText: "Salut",
      segmentCount: 1,
      audioSource: { id: "cloud-1", label: "demo.wav", type: "file" },
      audioMetadata: { durationSec: 12, sampleRate: 16000, channels: 1 },
      updatedAt: "2026-03-12T10:05:00.000Z",
    });

    expect(useAsrStore.getState().sessionTranscriptMemories.upload?.label).toContain("Locale");
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.label).toContain("Cloud Mistral");
    expect(useAsrStore.getState().sessionTranscriptMemories.mic).toBeNull();
    expect(useAsrStore.getState().sessionTranscriptMemories.upload?.transcriptText).toBe("Bonjour");
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud?.segmentCount).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(useAsrStore.getState().sessionTranscriptMemories.upload ?? {}, "segments")).toBe(false);

    const persistedAfterSet = JSON.parse(
      window.sessionStorage.getItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY) ?? "{}"
    ) as Record<string, unknown>;
    expect(persistedAfterSet.upload).toMatchObject({
      mode: "upload",
      provider: "upload",
      transcriptText: "Bonjour",
      segmentCount: 1,
    });
    expect(persistedAfterSet.cloud).toMatchObject({
      mode: "cloud",
      provider: "mistral",
      transcriptText: "Salut",
      segmentCount: 1,
    });

    state.clearSessionTranscriptMemory("upload");
    expect(useAsrStore.getState().sessionTranscriptMemories.upload).toBeNull();
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud).not.toBeNull();

    const persistedAfterClear = JSON.parse(
      window.sessionStorage.getItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY) ?? "{}"
    ) as Record<string, unknown>;
    expect(persistedAfterClear.upload).toBeNull();
    expect(persistedAfterClear.cloud).toMatchObject({
      mode: "cloud",
      provider: "mistral",
    });

    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(persisted.sessionTranscriptMemories).toBeUndefined();

    state.resetApp();
    expect(useAsrStore.getState().sessionTranscriptMemories.upload).toBeNull();
    expect(useAsrStore.getState().sessionTranscriptMemories.cloud).toBeNull();
    expect(useAsrStore.getState().sessionTranscriptMemories.mic).toBeNull();
    expect(window.sessionStorage.getItem(SESSION_TRANSCRIPT_MEMORIES_STORAGE_KEY)).toBeNull();
  });

  it("migrates legacy debugConfidence to logLevel=debug", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      logLevel: undefined,
      debugConfidence: true,
    };

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    useAsrStore.getState().hydrateFromStorage();

    expect(useAsrStore.getState().logLevel).toBe("debug");
  });

  it("sanitizes persisted presets, quantization and cloud model values", () => {
    useAsrStore.setState(
      {
        webGpuSupported: false,
        wasmAvailable: true,
        backendPreference: "wasm",
        micBackendPreference: "wasm",
      } as Partial<AsrConfigStore>
    );

    const payload = {
      ...DEFAULT_SETTINGS,
      activePreset: "unknown-preset",
      presetQuantizationOverrides: {
        fast: { webgpu: "fp16", wasm: "invalid-dtype" },
        custom: { webgpu: "q8" },
        balanced: "not-an-object",
      },
      blockedPresets: ["custom", "balanced", "unknown-preset"],
      backendPreference: "webgpu",
      micBackendPreference: "webgpu",
      cloudMistralModel: "voxtral-mini-transcribe-26-02",
      cloudDemeterModel: "voxtral-mini-transcribe-26-02",
      llmApiProvider: "invalid-provider",
      llmLocalModelProfile: "invalid-profile",
      llmLocalSettingsByProfile: {
        qwen_1_7b: {
          modelId: " onnx-community/Qwen3-1.7B-Instruct-2507-ONNX ",
          temperature: 8,
          maxTokens: 99999,
          dtypeWebgpu: "bad",
          dtypeWasm: "q4",
        },
        ministral_3_3b: {
          modelId: "",
          temperature: -4,
          maxTokens: 7,
          dtypeWebgpu: "fp16",
          dtypeWasm: "bad",
          appendNoThinkDirective: false,
        },
      },
    } as unknown as Record<string, unknown>;

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    useAsrStore.getState().hydrateFromStorage();

    const state = useAsrStore.getState();
    expect(state.hasHydrated).toBe(true);
    expect(state.activePreset).not.toBe("unknown-preset");
    expect(state.modelQuantizationOverrides).toBeTypeOf("object");
    expect((state.modelQuantizationOverrides as Record<string, unknown>).custom).toBeUndefined();
    expect(state.blockedPresets).toEqual(["balanced"]);
    expect(state.backendPreference).toBe("wasm");
    expect(state.micBackendPreference).toBe("wasm");
    expect(state.cloudMistralModel).toBe("voxtral-mini-latest");
    expect(state.cloudDemeterModel).toBe("voxtral-mini-latest");
    expect(state.llmApiProvider).toBe("huggingface");
    expect(state.llmLocalModelProfile).toBe("qwen_1_7b");
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.modelId).toBe("onnx-community/Qwen3-1.7B-ONNX");
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.temperature).toBe(2);
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.maxTokens).toBe(4096);
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.dtypeWebgpu).toBe("q4f16");
    expect(state.llmLocalSettingsByProfile.qwen_1_7b.dtypeWasm).toBe("q4");
    expect(state.llmLocalSettingsByProfile.ministral_3_3b.maxTokens).toBe(128);
    expect(state.llmLocalSettingsByProfile.ministral_3_3b.modelId).toContain("Ministral-3-3B");
  });

  it("updates preset quantization, chunk params and backend fallbacks", () => {
    useAsrStore.getState().setPresetQuantization("fast", "webgpu", "fp16");
    expect(useAsrStore.getState().modelQuantizationOverrides.fast?.webgpu).toBe("fp16");

    useAsrStore.getState().setPresetQuantization("fast", "webgpu", MODEL_PRESETS.fast.quantization.webgpu!);
    expect(useAsrStore.getState().modelQuantizationOverrides.fast).toBeUndefined();

    useAsrStore.getState().setBlockedPresets(["custom", "fast"]);
    expect(useAsrStore.getState().blockedPresets).toEqual(["fast"]);

    useAsrStore.getState().updateChunkParameters({ chunkDurationSec: 20 });
    expect(useAsrStore.getState().maxChunkMs).toBe(20000);
    expect(useAsrStore.getState().overlapSec).toBe(0.9);

    useAsrStore.getState().updateChunkParameters({ chunkDurationSec: 16, maxChunkMs: 12345, overlapSec: 0.5 });
    expect(useAsrStore.getState().maxChunkMs).toBe(12345);
    expect(useAsrStore.getState().overlapSec).toBe(0.5);

    useAsrStore.setState(
      {
        webGpuSupported: false,
        wasmAvailable: false,
        backendPreference: "webgpu",
        micBackendPreference: "webgpu",
        llmLocalBackendPreference: "wasm",
      } as Partial<AsrConfigStore>
    );

    useAsrStore.getState().setBackendPreference("webgpu");
    expect(useAsrStore.getState().backendPreference).toBe("wasm");

    useAsrStore.setState({ backendPreference: "wasm" } as Partial<AsrConfigStore>);
    useAsrStore.getState().setBackendPreference("webgpu");
    expect(useAsrStore.getState().backendPreference).toBe("wasm");

    useAsrStore.getState().setMicBackendPreference("webgpu");
    expect(useAsrStore.getState().micBackendPreference).toBe("wasm");

    useAsrStore.setState({ micBackendPreference: "wasm" } as Partial<AsrConfigStore>);
    useAsrStore.getState().setMicBackendPreference("webgpu");
    expect(useAsrStore.getState().micBackendPreference).toBe("wasm");

    useAsrStore.getState().setLlmLocalBackendPreference("webgpu");
    expect(useAsrStore.getState().llmLocalBackendPreference).toBe("wasm");

    useAsrStore.getState().setLlmLocalBackendPreference("wasm");
    expect(useAsrStore.getState().llmLocalBackendPreference).toBe("webgpu");
  });

  it("applies mic/cloud setters and request toggles", () => {
    const state = useAsrStore.getState();
    state.setMemoryMode("progressive");
    state.setChunkStrategy("silence");
    state.setSegmentationMode("silence");
    state.setDedupeMode("normal");
    state.setCleanIntraChunk(false);
    state.setProgressiveSegmentDurationSec(120);
    state.setShowSegments(false);
    state.setShowExportVtt(true);
    state.setShowExportSrt(true);
    state.setShowExportJson(true);
    state.setShowExportTelemetry(true);
    state.setPreprocessingMode("quick");
    state.setPreprocessingStatus("processing");
    state.setPreprocessingProgress(0.25);
    state.setSegmentationStatus("segmenting");
    state.setSegmentationProgress(0.45);
    state.setDenoiseParams({ denoiseNoiseFloorDb: -30 });
    state.setPreprocessParams({ preprocessHighpassHz: 120 });

    state.setMicPreset("custom", "mic/model");
    state.setMicPreprocessingMode("quick");
    state.setMicSegmentationMode("chunks");
    state.setMicNoiseCalibrationMarginDb(Number.NaN);
    state.setMicSilenceParams({ minSilenceMs: 700, maxChunkMs: 22000 });
    state.setMicShowExportVtt(true);
    state.setMicShowExportSrt(true);
    state.setMicShowExportJson(true);
    state.setMicShowExportTelemetry(true);
    state.setMicDenoiseParams({ denoiseReductionDb: 7 });
    state.setMicPreprocessParams({ preprocessLowpassHz: 5000, preprocessOverlapSec: 0.6 });
    state.setMicAutoTunePreprocess(false);
    state.setMicEnableWordTimestamps(true);
    state.setMicShowSegmentConfidence(true);
    state.setMicForceSingleThread(true);

    state.setCloudStatus("transcribing");
    state.setHfApiToken("hf-token");
    state.setCloudMistralApiUrl("https://mistral.local");
    state.setMistralApiKey("secret");
    state.setCloudMistralModel("voxtral-mini-latest");
    state.setCloudMistralDiarizationEnabled(false);
    state.setCloudDemeterModel("voxtral-demeter-latest");
    state.setCloudDemeterDiarizationEnabled(false);
    state.setCloudWhisperChunking({ chunkDurationSec: 55, overlapSec: 0.1 });
    state.setCloudMistralChunking({ chunkDurationSec: 400, overlapSec: 2 });
    state.setCloudMaxTokens(8192);
    state.setCloudTemperature(0.7);
    state.setCloudTopP(0.6);
    state.setCloudDoSample(true);
    state.setCloudShowSegments(false);
    state.setCloudShowExportVtt(true);
    state.setCloudShowExportSrt(true);
    state.setCloudShowExportJson(true);
    state.setCloudShowExportTelemetry(true);
    state.setCloudPreprocessingMode("quick");
    state.setCloudDenoiseParams({ denoiseCalibrationSeconds: 3 });
    state.setCloudPreprocessParams({ preprocessEnableLufs: false, preprocessLimiterSoftness: 0.8 });
    state.setCloudAutoTunePreprocess(false);
    state.setCloudEnableWordTimestamps(true);
    state.setCloudShowSegmentConfidence(true);

    const next = useAsrStore.getState();
    expect(next.memoryMode).toBe("progressive");
    expect(next.chunkStrategy).toBe("silence");
    expect(next.segmentationMode).toBe("silence");
    expect(next.dedupeMode).toBe("normal");
    expect(next.cleanIntraChunk).toBe(false);
    expect(next.progressiveSegmentDurationSec).toBe(120);
    expect(next.showExportTelemetry).toBe(true);
    expect(next.preprocessingStatus).toBe("processing");
    expect(next.micActivePreset).toBe("custom");
    expect(next.micCustomModelId).toBe("mic/model");
    expect(next.micNoiseCalibrationMarginDb).toBe(6);
    expect(next.micPreprocessLowpassHz).toBe(5000);
    expect(next.micPreprocessOverlapSec).toBe(0.6);
    expect(next.cloudStatus).toBe("transcribing");
    expect(next.cloudDemeterModel).toBe("voxtral-demeter-latest");
    expect(next.cloudDemeterDiarizationEnabled).toBe(false);
    expect(next.cloudWhisperChunkDurationSec).toBe(55);
    expect(next.cloudMistralOverlapSec).toBe(2);
    expect(next.cloudDoSample).toBe(true);
    expect(next.cloudShowSegmentConfidence).toBe(true);

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(123456);
    state.requestNoiseCalibration();
    expect(useAsrStore.getState().noiseCalibrationRequestedAt).toBe(123456);
    state.clearNoiseCalibrationRequest();
    expect(useAsrStore.getState().noiseCalibrationRequestedAt).toBeNull();
    nowSpy.mockRestore();
    state.requestStop();
    expect(useAsrStore.getState().stopRequested).toBe(true);
    state.resetStopRequest();
    expect(useAsrStore.getState().stopRequested).toBe(false);
  });

  it("applies llm api/local setters, session reset and app reset", () => {
    const state = useAsrStore.getState();
    state.setLlmApiProvider("mistral");
    state.setHfApiToken("hf");
    state.setLlmApiHfModelId("openai/gpt-oss-120b");
    state.setLlmApiHfTemperature(10);
    state.setLlmApiHfMaxTokens(42);
    state.setLlmApiMistralModelId("mistral-small-latest");
    state.setLlmApiMistralTemperature(-5);
    state.setLlmApiMistralMaxTokens(91);
    state.setLlmApiStatus("generating");
    state.setLlmApiProgress(2);
    state.setLlmApiResult("cri", { text: "x" });
    state.setLlmApiResults({ cro: { text: "y" } });
    state.setLlmApiReportDraft("cri", {
      format: "CRI",
      title: "Titre edite",
      sections: [{ heading: "Section", paragraphs: ["Paragraphe"] }],
    } as never);
    state.resetLlmApiSession();
    expect(useAsrStore.getState().llmApiReportDrafts).toEqual({});

    state.setLlmLocalModelProfile("ministral_3_3b");
    state.setLlmLocalModelId(" mistralai/Ministral-3-3B-Instruct-2512-ONNX ");
    state.setLlmLocalTemperature(8);
    state.setLlmLocalMaxTokens(10);
    state.setLlmLocalDtypeWebgpu("bad" as never);
    state.setLlmLocalDtypeWasm("bad" as never);
    state.setLlmLocalForceSingleThread(true);
    state.setLlmLocalModelSettings("qwen_1_7b", { temperature: 0.4, maxTokens: 1024 });
    state.setLlmLocalModelSettings("ministral_3_3b", { temperature: 0.3, maxTokens: 2048, dtypeWasm: "q4" });
    state.resetLlmLocalModelSettings("qwen_1_7b");
    state.resetLlmLocalModelSettings("ministral_3_3b");
    state.setLlmLocalStatus("formatting");
    state.setLlmLocalProgress(-1);
    state.setLlmLocalResult("cri", { text: "z" });
    state.setLlmLocalResults({ crs: { text: "w" } });
    state.setLocalUploadModelSizeAlert({
      title: "Size",
      description: "Too big",
      severity: "warning",
      signature: "sig-a",
    });
    state.setLlmLocalModelSizeAlert({
      title: "Size",
      description: "Too big",
      severity: "error",
      signature: "sig-b",
    });
    state.resetLlmLocalSession();
    state.clearLocalUploadModelSizeAlert();
    state.clearLlmLocalModelSizeAlert();

    state.setAutoTunePreprocess(false);
    state.setLastAutoTuneParams({
      denoiseNoiseFloorDb: -35,
      denoiseReductionDb: 9,
      denoiseSmoothing: 0.7,
      denoiseCalibrationSeconds: 4,
      preprocessHighpassHz: 100,
      preprocessLowpassHz: 7000,
      preprocessTargetLufs: -18,
    });

    const file = new File(["demo"], "sample.txt", { type: "text/plain" });
    state.setUploadedFile(file);
    state.setPreviewUrl("blob:preview");
    state.setLogLevel("debug");
    state.setTranscriptionConfidence(0.8);
    state.setTranscriptionConfidenceSource("model");
    state.setForceSingleThread(true);
    state.setWasmThreads(4);
    state.setIsTranscribing(true);
    state.setProgress(0.7);
    state.setWebGpuSupport(false);
    state.setWasmAvailable(false);
    state.setEnableWordTimestamps(true);
    state.setShowSegmentConfidence(true);

    state.resetSession();
    const afterSessionReset = useAsrStore.getState();
    expect(afterSessionReset.logLevel).toBe("debug");
    expect(afterSessionReset.previewUrl).toBe("blob:preview");
    expect(afterSessionReset.status).toBe("idle");
    expect(afterSessionReset.llmApiStatus).toBe("idle");
    expect(afterSessionReset.llmLocalStatus).toBe("idle");

    useAsrStore.getState().resetApp();
    const afterAppReset = useAsrStore.getState();
    expect(afterAppReset.hasHydrated).toBe(true);
    expect(afterAppReset.webGpuSupported).toBe(false);
    expect(afterAppReset.wasmAvailable).toBe(false);
    expect(afterAppReset.enableWordTimestamps).toBe(false);
    expect(afterAppReset.showSegmentConfidence).toBe(false);
    expect(afterAppReset.llmApiHfTemperature).toBe(0.2);
    expect(afterAppReset.llmApiHfMaxTokens).toBe(131072);
    expect(afterAppReset.llmApiMistralTemperature).toBe(0.2);
    expect(afterAppReset.llmApiMistralMaxTokens).toBe(8192);
    expect(afterAppReset.llmLocalTemperature).toBe(0.2);
    expect(afterAppReset.llmLocalMaxTokens).toBe(4096);
    expect(afterAppReset.llmLocalModelId).toContain("Qwen3-1.7B");
  });

  it("handles speaker assignments as session-only state", () => {
    const state = useAsrStore.getState();

    state.setSpeakerAssignment("cloud", " SPEAKER_00 ", {
      firstName: " Alice ",
      lastName: " Dupont ",
    });
    expect(useAsrStore.getState().speakerAssignments.cloud.SPEAKER_00).toEqual({
      firstName: "Alice",
      lastName: "Dupont",
    });

    state.setSpeakerAssignments("mic", {
      " SPEAKER_01 ": { firstName: " John ", lastName: " Doe " },
      SPEAKER_02: { firstName: "  ", lastName: " " },
    });
    expect(useAsrStore.getState().speakerAssignments.mic).toEqual({
      SPEAKER_01: { firstName: "John", lastName: "Doe" },
    });

    state.setSpeakerAssignment("cloud", "SPEAKER_00", {
      firstName: " ",
      lastName: " ",
    });
    expect(useAsrStore.getState().speakerAssignments.cloud.SPEAKER_00).toBeUndefined();

    state.clearSpeakerAssignments("mic");
    expect(useAsrStore.getState().speakerAssignments.mic).toEqual({});

    state.setSpeakerAssignment("upload", "SPEAKER_00", {
      firstName: "Alice",
      lastName: "Dupont",
    });
    state.resetSession();
    expect(useAsrStore.getState().speakerAssignments).toEqual({
      upload: {},
      mic: {},
      cloud: {},
    });

    useAsrStore.setState({ hasHydrated: true } as Partial<AsrConfigStore>);
    useAsrStore.getState().setSpeakerAssignment("upload", "SPEAKER_01", {
      firstName: "Jane",
      lastName: "Doe",
    });
    const persisted = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(persisted.speakerAssignments).toBeUndefined();

    useAsrStore.getState().resetApp();
    expect(useAsrStore.getState().speakerAssignments).toEqual({
      upload: {},
      mic: {},
      cloud: {},
    });
  });
});
