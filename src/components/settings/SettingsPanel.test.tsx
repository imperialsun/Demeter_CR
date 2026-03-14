/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import { SettingsPanel } from './SettingsPanel';
import { useAsrStore } from '@/store/asr-store';
import * as toastMod from '@/components/ui/use-toast';
import { ThemeProvider } from '@/components/theme-provider';
import { waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

type MockMistralModel = {
  id: string;
  maxContextTokens?: number;
  supportsChat: boolean;
};

const { fetchMistralModelsSafeMock } = vi.hoisted(() => ({
  fetchMistralModelsSafeMock: vi.fn<(...args: unknown[]) => Promise<MockMistralModel[]>>(async () => []),
}));

const { clearSecureTokensMock } = vi.hoisted(() => ({
  clearSecureTokensMock: vi.fn<() => Promise<void>>(async () => {}),
}));

const {
  initializeBackendSupportMock,
  resetWebGpuSupportCacheMock,
  testWasmMultithreadSupportMock,
} = vi.hoisted(() => ({
  initializeBackendSupportMock: vi.fn(async () => true),
  resetWebGpuSupportCacheMock: vi.fn(),
  testWasmMultithreadSupportMock: vi.fn(async () => ({ ok: true, reason: "ok" })),
}));

const {
  canUseCloudProviderMock,
  canUseLlmProviderMock,
  isBackendModeMock,
} = vi.hoisted(() => ({
  canUseCloudProviderMock: vi.fn(() => true),
  canUseLlmProviderMock: vi.fn(() => true),
  isBackendModeMock: vi.fn(() => false),
}));

vi.mock('@/lib/backend-support', () => ({
  initializeBackendSupport: (...args: unknown[]) => initializeBackendSupportMock(...args),
  resetWebGpuSupportCache: (...args: unknown[]) => resetWebGpuSupportCacheMock(...args),
  testWasmMultithreadSupport: (...args: unknown[]) => testWasmMultithreadSupportMock(...args),
}));

vi.mock('@/lib/secure-token-vault', () => ({
  clearSecureTokens: (...args: unknown[]) => clearSecureTokensMock(...args),
}));

vi.mock('@/lib/llm/mistralModelsClient', () => ({
  DEFAULT_MISTRAL_LLM_MODEL_ID: 'mistral-medium-latest',
  FALLBACK_MISTRAL_MAX_TOKENS: 8192,
  fetchMistralModelsSafe: (...args: unknown[]) => fetchMistralModelsSafeMock(...args),
  findMistralModelMetadata: (models: Array<{ id: string }>, modelId: string) =>
    models.find((model) => model.id === modelId) ?? null,
  resolveMistralMaxTokens: (metadata?: { maxContextTokens?: number }) =>
    typeof metadata?.maxContextTokens === 'number' ? metadata.maxContextTokens - 512 : 8192,
}));

vi.mock('@/lib/backend-permissions', () => ({
  canAccessFeature: vi.fn(() => true),
  canAccessRoutePath: vi.fn(() => true),
  canUseCloudProvider: (...args: unknown[]) => canUseCloudProviderMock(...args),
  canUseLlmProvider: (...args: unknown[]) => canUseLlmProviderMock(...args),
  getAuthorizedSettingsTabs: vi.fn(() => ["local", "cloud", "llmlocal", "llm"]),
  getFirstAuthorizedRoute: vi.fn(() => "/localupload"),
}));

vi.mock('@/lib/runtime-config', () => ({
  isBackendMode: (...args: unknown[]) => isBackendModeMock(...args),
  getRuntimeConfig: () => ({
    mode: isBackendModeMock() ? "backend" : "standalone",
    backendBaseUrl: "/api/v1",
  }),
}));

describe('SettingsPanel', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useAsrStore.setState({
      showSegmentConfidence: false,
      enableWordTimestamps: false,
      mistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      llmApiProvider: "huggingface",
      hfApiToken: "",
      llmApiHfModelId: "openai/gpt-oss-20b",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 1024,
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
      llmApiMistralMaxTokens: 8192,
      setShowSegmentConfidence: (v: boolean) => useAsrStore.setState({ showSegmentConfidence: v }),
      setEnableWordTimestamps: (v: boolean) => useAsrStore.setState({ enableWordTimestamps: v }),
    } as any);
    fetchMistralModelsSafeMock.mockReset();
    fetchMistralModelsSafeMock.mockResolvedValue([]);
    clearSecureTokensMock.mockReset();
    clearSecureTokensMock.mockResolvedValue();
    initializeBackendSupportMock.mockReset();
    initializeBackendSupportMock.mockResolvedValue(true);
    resetWebGpuSupportCacheMock.mockReset();
    testWasmMultithreadSupportMock.mockReset();
    testWasmMultithreadSupportMock.mockResolvedValue({ ok: true, reason: "ok" });
    canUseCloudProviderMock.mockReset();
    canUseCloudProviderMock.mockReturnValue(true);
    canUseLlmProviderMock.mockReset();
    canUseLlmProviderMock.mockReturnValue(true);
    isBackendModeMock.mockReset();
    isBackendModeMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // restore caches if replaced
    try { delete (globalThis as any).caches; } catch { /* ignore */ }
  });

  it("toggles 'Afficher l'indice de confiance' and enables word timestamps", async () => {
    // Ensure initial state
    useAsrStore.setState({ showSegmentConfidence: false, enableWordTimestamps: false } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);
    const header = screen.getByText('Modèle Whisper');
    const headerContainer = header.closest('div');

    // Ensure the model section is visible; if it's collapsed, click the toggle button to expand it.
    const showBtn = headerContainer?.parentElement?.querySelector('button');
    expect(showBtn).toBeTruthy();
    if (showBtn?.textContent?.includes("Afficher")) {
      fireEvent.click(showBtn);
    }

    const segSwitch = await screen.findByRole('switch', { name: "Afficher l'indice de confiance" });
    expect(segSwitch).toBeTruthy();
    fireEvent.click(segSwitch!);

    // Assert the store values were updated
    expect(useAsrStore.getState().showSegmentConfidence).toBe(true);
    expect(useAsrStore.getState().enableWordTimestamps).toBe(true);
  }, 15000);

  it("shows quantization controls for built-in presets", async () => {
    useAsrStore.setState({ activePreset: "fast" } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);
    const header = screen.getByText('Modèle Whisper');
    const headerContainer = header.closest('div');
    const showBtn = headerContainer?.parentElement?.querySelector('button');
    expect(showBtn).toBeTruthy();
    if (showBtn?.textContent?.includes("Afficher")) {
      fireEvent.click(showBtn);
    }

    expect(await screen.findByText("Quantization du preset")).toBeTruthy();
    expect(screen.getByLabelText("WebGPU", { selector: "button#local-quantization-webgpu" })).toBeTruthy();
    expect(screen.getByLabelText("WASM", { selector: "button#local-quantization-wasm" })).toBeTruthy();
  });

  it("resets quantization overrides to preset defaults", async () => {
    useAsrStore.setState({
      activePreset: "fast",
      modelQuantizationOverrides: {
        fast: { webgpu: "fp32", wasm: "fp32" },
      },
    } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);
    const header = screen.getByText('Modèle Whisper');
    const headerContainer = header.closest('div');
    const showBtn = headerContainer?.parentElement?.querySelector('button');
    expect(showBtn).toBeTruthy();
    if (showBtn?.textContent?.includes("Afficher")) {
      fireEvent.click(showBtn);
    }

    const resetButtons = await screen.findAllByRole('button', { name: "Réinitialiser ce preset" });
    fireEvent.click(resetButtons[0]!);

    await waitFor(() => {
      expect(useAsrStore.getState().modelQuantizationOverrides.fast).toBeUndefined();
    });
  });

  it("clears caches and shows toast on confirm", async () => {
    // Mock caches API
    const keysSpy = vi.fn(async () => ['test-cache']);
    const deleteSpy = vi.fn(async () => true);
    (globalThis as any).caches = { keys: keysSpy, delete: deleteSpy } as any;

    const toastSpy = vi.spyOn(toastMod, 'toast');

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    const clearBtn = screen.getAllByText('Vider le cache').find((n) => n.tagName === 'BUTTON');
    expect(clearBtn).toBeTruthy();
    fireEvent.click(clearBtn!);

    // confirm dialog should appear; click 'Confirmer'
    const confirm = screen.getByText('Confirmer');
    fireEvent.click(confirm);

    // Wait for async to complete
    await waitFor(() => expect(keysSpy).toHaveBeenCalled());
    expect(deleteSpy).toHaveBeenCalledWith('test-cache');
    expect(clearSecureTokensMock).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('Cache vidé'));
  });

  it("toggles mic confidence and enables mic word timestamps", async () => {
    useAsrStore.setState({ micShowSegmentConfidence: false, micEnableWordTimestamps: false } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="mic" />
      </ThemeProvider>
    );

    const micSwitch = await screen.findByRole('switch', { name: "Afficher l'indice de confiance (micro)" });
    fireEvent.click(micSwitch);

    await waitFor(() => {
      expect(useAsrStore.getState().micShowSegmentConfidence).toBe(true);
      expect(useAsrStore.getState().micEnableWordTimestamps).toBe(true);
    });
  }, 15000);

  it("forces mic backend to wasm when WebGPU is unavailable", async () => {
    useAsrStore.setState({ webGpuSupported: false, micBackendPreference: "webgpu" } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    await waitFor(() => {
      expect(useAsrStore.getState().micBackendPreference).toBe("wasm");
    });
  });

  it("toggles mic autotune and enables mic controls", async () => {
    useAsrStore.setState({ micAutoTunePreprocess: true, micPreprocessingMode: "full" } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="mic" />
      </ThemeProvider>
    );

    const slider = screen.getByLabelText("Noise floor (dB)", { selector: "input#mic-noise-floor" });
    expect(slider).toBeDisabled();

    const autoTuneSwitch = await screen.findByRole('switch', { name: "Autotune prétraitement (micro)" });
    await userEvent.click(autoTuneSwitch);

    await waitFor(() => {
      expect(useAsrStore.getState().micAutoTunePreprocess).toBe(false);
      expect(slider).not.toBeDisabled();
    });
  }, 15000);

  it("updates mic noise calibration margin", async () => {
    useAsrStore.setState({ micNoiseCalibrationMarginDb: 6 } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="mic" />
      </ThemeProvider>
    );

    const input = screen.getByLabelText("Marge calibration bruit (dB)", { selector: "input#mic-noise-margin-db" });
    fireEvent.change(input, { target: { value: "10" } });

    expect(useAsrStore.getState().micNoiseCalibrationMarginDb).toBe(10);
  });

  it("hides the mic settings tab when disabled", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel showMicSettings={false} />
      </ThemeProvider>
    );

    expect(screen.queryByText('Enregistrement')).toBeNull();
  });

  it("shows the cloud settings tab by default", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    expect(screen.getByText('Cloud')).toBeTruthy();
  });

  it("updates cloud hf token from settings", async () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const cloudTab = screen.getByText("Cloud");
    await userEvent.click(cloudTab);
    await userEvent.click(screen.getByRole("tab", { name: "Whisper" }));

    const input = screen.getByLabelText("Token Hugging Face (Whisper)", { selector: "input#cloud-hf-token" });
    fireEvent.change(input, { target: { value: "hf_test_token" } });

    expect(useAsrStore.getState().hfApiToken).toBe("hf_test_token");
    expect(screen.getByText(/session en cours du navigateur/i)).toBeInTheDocument();
  });

  it("updates cloud mistral token from settings", async () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const cloudTab = screen.getByText("Cloud");
    await userEvent.click(cloudTab);
    await userEvent.click(screen.getByRole("tab", { name: "Mistral" }));

    fireEvent.change(
      screen.getByLabelText("Token API Mistral", { selector: "input#cloud-mistral-api-key" }),
      { target: { value: "mistral_secret" } }
    );

    expect(useAsrStore.getState().mistralApiKey).toBe("mistral_secret");
    expect(screen.getByText(/session en cours du navigateur/i)).toBeInTheDocument();
  });

  it("stores independent chunking/segmentation settings for whisper and mistral", async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    await user.click(screen.getByRole("tab", { name: "Cloud" }));

    await user.click(await screen.findByRole("tab", { name: "Whisper" }));
    fireEvent.change(
      screen.getByLabelText("Durée chunk (s)", { selector: "input#cloud-whisper-chunk-duration" }),
      { target: { value: "45" } }
    );
    fireEvent.change(
      screen.getByLabelText("Recouvrement (s)", { selector: "input#cloud-whisper-overlap" }),
      { target: { value: "2" } }
    );

    await user.click(await screen.findByRole("tab", { name: "Mistral" }));
    fireEvent.change(
      screen.getByLabelText("Durée chunk (s)", { selector: "input#cloud-mistral-chunk-duration" }),
      { target: { value: "120" } }
    );
    fireEvent.change(
      screen.getByLabelText("Recouvrement (s)", { selector: "input#cloud-mistral-overlap" }),
      { target: { value: "5" } }
    );

    const state = useAsrStore.getState();
    expect(state.cloudWhisperChunkDurationSec).toBe(45);
    expect(state.cloudWhisperOverlapSec).toBe(2);
    expect(state.cloudMistralChunkDurationSec).toBe(120);
    expect(state.cloudMistralOverlapSec).toBe(5);
  }, 10000);

  it("shows llm cloud tab by default", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    expect(screen.getByRole("tab", { name: "LLM Cloud" })).toBeInTheDocument();
  });

  it("shows llm local tab by default", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    expect(screen.getByRole("tab", { name: "LLM Local" })).toBeInTheDocument();
  });

  it("opens llm local tab when initialTab is llmlocal", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llmlocal" />
      </ThemeProvider>
    );

    expect(screen.getByText("Pipeline /llmlocal")).toBeInTheDocument();
  });

  it("opens llm tab when initialTab is llm", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    expect(screen.getByText("Pipeline /llmapi")).toBeInTheDocument();
  });

  it("shows hf and mistral cards at the same time in llm settings tab", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    expect(screen.getByText("Hugging Face")).toBeInTheDocument();
    expect(screen.getByText("Mistral")).toBeInTheDocument();
    expect(screen.getByLabelText("Token Hugging Face (LLM)", { selector: "input#settings-llm-hf-token" })).toBeInTheDocument();
    expect(screen.getByLabelText("Cle API Mistral (LLM)", { selector: "input#settings-llm-mistral-api-key" })).toBeInTheDocument();
  });

  it("updates mistral api url from llm settings tab", () => {
    useAsrStore.setState({ cloudMistralApiUrl: "https://api.mistral.ai" } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    const input = screen.getByLabelText("URL API Mistral (LLM)", { selector: "input#settings-llm-mistral-api-url" });
    fireEvent.change(input, { target: { value: "https://mistral.example.com" } });

    expect(useAsrStore.getState().cloudMistralApiUrl).toBe("https://mistral.example.com");
  });

  it("updates hf model id, temperature and max tokens from llm tab", () => {
    useAsrStore.setState({
      llmApiHfModelId: "custom/my-model",
      llmApiHfTemperature: 0.2,
      llmApiHfMaxTokens: 4096,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    fireEvent.change(screen.getByLabelText("Model ID (HF)", { selector: "input#settings-llm-hf-model-id" }), {
      target: { value: "custom/next-model" },
    });
    fireEvent.change(
      screen.getByLabelText("Temperature (HF)", { selector: "input#settings-llm-hf-temperature" }),
      { target: { value: "0.6" } }
    );
    fireEvent.change(
      screen.getByLabelText("Max tokens (HF)", { selector: "input#settings-llm-hf-max-tokens" }),
      { target: { value: "8192" } }
    );

    const state = useAsrStore.getState();
    expect(state.llmApiHfModelId).toBe("custom/next-model");
    expect(state.llmApiHfTemperature).toBe(0.6);
    expect(state.llmApiHfMaxTokens).toBe(8192);
  });

  it("updates mistral model id and temperature from llm tab", () => {
    useAsrStore.setState({
      llmApiMistralModelId: "mistral-medium-latest",
      llmApiMistralTemperature: 0.2,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    fireEvent.change(
      screen.getByLabelText("Model ID (Mistral)", { selector: "input#settings-llm-mistral-model-id" }),
      {
        target: { value: "mistral-large-latest" },
      }
    );
    fireEvent.change(
      screen.getByLabelText("Temperature (Mistral)", { selector: "input#settings-llm-mistral-temperature" }),
      { target: { value: "0.4" } }
    );

    const state = useAsrStore.getState();
    expect(state.llmApiMistralModelId).toBe("mistral-large-latest");
    expect(state.llmApiMistralTemperature).toBe(0.4);
  });

  it("loads mistral models in llm tab even when active provider is huggingface", async () => {
    fetchMistralModelsSafeMock.mockResolvedValue([
      { id: "mistral-medium-latest", maxContextTokens: 65536, supportsChat: true },
    ]);
    useAsrStore.setState({
      llmApiProvider: "huggingface",
      llmApiMistralModelId: "mistral-medium-latest",
      mistralApiKey: "mistral_key",
      cloudMistralApiUrl: "https://api.mistral.ai",
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="llm" />
      </ThemeProvider>
    );

    expect(
      screen.getByLabelText("Modeles Mistral disponibles (LLM)", { selector: "button#settings-llm-mistral-model-preset" })
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMistralModelsSafeMock).toHaveBeenCalled();
      expect(screen.getByText(/modeles detectes via/i)).toBeInTheDocument();
    });
  });

  it("renders cloud full preprocessing controls and updates cloud segment toggles", async () => {
    useAsrStore.setState({
      cloudPreprocessingMode: "full",
      cloudAutoTunePreprocess: false,
      cloudPreprocessEnableFilters: true,
      cloudPreprocessEnableLufs: true,
      cloudPreprocessLimiterEnabled: true,
      cloudPreprocessVadEnabled: true,
      cloudPreprocessOverlapAdd: true,
      cloudShowSegments: true,
      cloudShowSegmentConfidence: false,
      cloudEnableWordTimestamps: false,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="cloud" />
      </ThemeProvider>
    );

    expect(screen.getByText("Pré-traitement cloud")).toBeInTheDocument();
    expect(screen.getByLabelText("Passe-haut (Hz)", { selector: "input#cloud-pre-highpass" })).toBeInTheDocument();
    expect(screen.getByLabelText("Passe-bas (Hz)", { selector: "input#cloud-pre-lowpass" })).toBeInTheDocument();
    expect(screen.getByLabelText("Cible loudness (LUFS)", { selector: "input#cloud-pre-lufs-target" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Noise floor (dB)", { selector: "input#cloud-noise-floor" }), {
      target: { value: "-25" },
    });
    fireEvent.change(screen.getByLabelText("Réduction (dB)", { selector: "input#cloud-reduction-db" }), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("Lissage", { selector: "input#cloud-smoothing" }), {
      target: { value: "0.7" },
    });
    fireEvent.change(screen.getByLabelText("Passe-haut (Hz)", { selector: "input#cloud-pre-highpass" }), {
      target: { value: "110" },
    });
    fireEvent.change(screen.getByLabelText("Passe-bas (Hz)", { selector: "input#cloud-pre-lowpass" }), {
      target: { value: "6800" },
    });
    fireEvent.change(screen.getByLabelText("Cible loudness (LUFS)", { selector: "input#cloud-pre-lufs-target" }), {
      target: { value: "-18.5" },
    });
    fireEvent.change(screen.getByLabelText("Seuil limiteur (dBFS)", { selector: "input#cloud-pre-limiter-threshold" }), {
      target: { value: "-2.1" },
    });
    fireEvent.change(screen.getByLabelText("Seuil VAD (dB)", { selector: "input#cloud-pre-vad-threshold" }), {
      target: { value: "-38" },
    });
    fireEvent.change(screen.getByLabelText("Silence min (ms)", { selector: "input#cloud-pre-vad-min-silence" }), {
      target: { value: "400" },
    });
    fireEvent.change(screen.getByLabelText("Durée calibration (s)", { selector: "input#cloud-calibration-seconds" }), {
      target: { value: "3.5" },
    });

    const findSwitch = (label: string) =>
      screen.getByText(label).closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement | null;

    const filtersSwitch = findSwitch("Filtres passe-haut / passe-bas");
    const lufsSwitch = findSwitch("Normalisation loudness (LUFS)");
    const limiterSwitch = findSwitch("Limiteur doux");
    const vadSwitch = findSwitch("Calibration VAD (silence)");
    const overlapSwitch = findSwitch("Lissage overlap-add");
    const autoTuneSwitch = screen.getByRole("switch", { name: "Autotune prétraitement (cloud)" });

    expect(filtersSwitch).toBeTruthy();
    expect(lufsSwitch).toBeTruthy();
    expect(limiterSwitch).toBeTruthy();
    expect(vadSwitch).toBeTruthy();
    expect(overlapSwitch).toBeTruthy();

    fireEvent.click(filtersSwitch!);
    fireEvent.click(lufsSwitch!);
    fireEvent.click(limiterSwitch!);
    fireEvent.click(vadSwitch!);
    fireEvent.click(overlapSwitch!);
    fireEvent.click(autoTuneSwitch);

    const segmentsCard = screen.getByText("Afficher le tableau des segments").closest("div")?.parentElement;
    const confidenceCard = screen.getByText("Indice de confiance").closest("div")?.parentElement;
    const wordsCard = screen.getByText("Timestamps mots").closest("div")?.parentElement;

    const segmentsSwitch = segmentsCard?.querySelector('[role="switch"]') as HTMLElement | null;
    const confidenceSwitch = confidenceCard?.querySelector('[role="switch"]') as HTMLElement | null;
    const wordsSwitch = wordsCard?.querySelector('[role="switch"]') as HTMLElement | null;

    expect(segmentsSwitch).toBeTruthy();
    expect(confidenceSwitch).toBeTruthy();
    expect(wordsSwitch).toBeTruthy();

    fireEvent.click(segmentsSwitch!);
    fireEvent.click(confidenceSwitch!);
    fireEvent.click(wordsSwitch!);

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.cloudShowSegments).toBe(false);
      expect(state.cloudShowSegmentConfidence).toBe(true);
      expect(state.cloudEnableWordTimestamps).toBe(true);
      expect(state.cloudDenoiseNoiseFloorDb).toBe(-25);
      expect(state.cloudPreprocessEnableFilters).toBe(false);
      expect(state.cloudAutoTunePreprocess).toBe(true);
    });
  }, 15000);

  it("updates cloud export toggles from cloud settings", async () => {
    useAsrStore.setState({
      cloudShowExportVtt: true,
      cloudShowExportSrt: true,
      cloudShowExportJson: true,
      cloudShowExportTelemetry: true,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="cloud" />
      </ThemeProvider>
    );

    const vttCard = screen.getByText("VTT").closest("div")?.parentElement;
    const srtCard = screen.getByText("SRT").closest("div")?.parentElement;
    const jsonCard = screen.getByText("JSON segments").closest("div")?.parentElement;
    const telemetryCard = screen.getByText("Telemetry").closest("div")?.parentElement;

    fireEvent.click(vttCard?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(srtCard?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(jsonCard?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(telemetryCard?.querySelector('[role="switch"]') as HTMLElement);

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.cloudShowExportVtt).toBe(false);
      expect(state.cloudShowExportSrt).toBe(false);
      expect(state.cloudShowExportJson).toBe(false);
      expect(state.cloudShowExportTelemetry).toBe(false);
    });
  });

  it("computes cache stats and renders cache details", async () => {
    const originalCaches = (globalThis as any).caches;
    const originalIndexedDb = (globalThis as any).indexedDB;
    const originalNavigatorStorage = (navigator as any).storage;

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: vi.fn(async () => ({ usage: 12345 })),
      },
    });

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: vi.fn(async () => ["test-cache"]),
        open: vi.fn(async () => ({
          keys: vi.fn(async () => [new Request("https://cache.test/asset.js")]),
          match: vi.fn(async () => new Response("cached", { headers: { "content-length": "6" } })),
        })),
      },
    });

    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        databases: vi.fn(async () => []),
        open: vi.fn(() => {
          throw new Error("indexeddb unavailable in test");
        }),
      },
    });

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    await userEvent.click(screen.getByRole("button", { name: "Rafraîchir" }));

    await waitFor(() => {
      expect(screen.getByText("test-cache")).toBeInTheDocument();
      expect(screen.getByText(/Total estimé/i)).toBeInTheDocument();
    });

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: originalIndexedDb,
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: originalNavigatorStorage,
    });
  });

  it("updates local chunking, preprocessing and export settings from local tab", async () => {
    useAsrStore.setState({
      preprocessingMode: "quick",
      chunkStrategy: "sequential",
      memoryMode: "full",
      showSegments: false,
      showExportVtt: true,
      showExportSrt: true,
      showExportJson: true,
      showExportTelemetry: true,
      dedupeMode: "normal",
      cleanIntraChunk: false,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialModelOpen initialChunkingOpen initialTab="local" />
      </ThemeProvider>
    );

    const modeProgressifSwitch = screen.getByText("Mode progressif").closest("div")?.parentElement?.querySelector('[role="switch"]');
    expect(modeProgressifSwitch).toBeTruthy();
    fireEvent.click(modeProgressifSwitch as HTMLElement);

    const segmentDurationRow = screen.getByText("Taille du segment progressif").closest("div")?.parentElement;
    const segmentDurationTrigger = segmentDurationRow?.querySelector("button");
    fireEvent.click(segmentDurationTrigger as HTMLElement);
    fireEvent.click(await screen.findByText("20 minutes"));

    const chunkStrategyRow = screen.getByText("Stratégie de chunking").closest("div");
    const chunkStrategyTrigger = chunkStrategyRow?.querySelector("button");
    fireEvent.click(chunkStrategyTrigger as HTMLElement);
    fireEvent.click(await screen.findByText("Détection de silences (énergie)"));

    fireEvent.change(screen.getByLabelText("Overlap (s)", { selector: "input#overlap" }), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Seuil silence (dB)", { selector: "input#silence-threshold" }), {
      target: { value: "-33" },
    });
    fireEvent.change(screen.getByLabelText("Silence min (ms)", { selector: "input#min-silence" }), {
      target: { value: "900" },
    });
    fireEvent.change(screen.getByLabelText("Chunk min (ms)", { selector: "input#min-chunk" }), { target: { value: "1200" } });
    fireEvent.change(screen.getByLabelText("Chunk max (ms)", { selector: "input#max-chunk" }), { target: { value: "22000" } });

    const dedupeRow = screen.getByText("Méthode").closest("div")?.parentElement;
    const dedupeTrigger = dedupeRow?.querySelector("button");
    fireEvent.click(dedupeTrigger as HTMLElement);
    fireEvent.click(await screen.findByText("Fuzzy (tolérant)"));

    const cleanIntraSwitch = screen.getByRole("switch", { name: "Nettoyage intra-chunk" });
    fireEvent.click(cleanIntraSwitch);

    const preprocessModeRow = screen.getByText("Mode de pré-traitement").closest("div")?.parentElement;
    const preprocessModeTrigger = preprocessModeRow?.querySelector("button");
    fireEvent.click(preprocessModeTrigger as HTMLElement);
    fireEvent.click(await screen.findByText("Complet"));

    fireEvent.change(screen.getByLabelText("Noise floor (dB)", { selector: "input#noise-floor" }), {
      target: { value: "-24" },
    });
    fireEvent.change(screen.getByLabelText("Réduction (dB)", { selector: "input#reduction-db" }), {
      target: { value: "11" },
    });
    fireEvent.change(screen.getByLabelText("Lissage", { selector: "input#smoothing" }), {
      target: { value: "0.6" },
    });
    fireEvent.change(screen.getByLabelText("Durée calibration (s)", { selector: "input#calibration-seconds" }), {
      target: { value: "2.75" },
    });

    const findSwitch = (label: string) =>
      screen.getByText(label).closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement | null;
    fireEvent.click(findSwitch("Filtres passe-haut / passe-bas") as HTMLElement);
    fireEvent.click(findSwitch("Normalisation loudness (LUFS)") as HTMLElement);
    fireEvent.click(findSwitch("Limiteur doux") as HTMLElement);
    fireEvent.click(findSwitch("Calibration VAD (silence)") as HTMLElement);
    fireEvent.click(findSwitch("Lissage overlap-add") as HTMLElement);
    fireEvent.click(findSwitch("Autotune prétraitement") as HTMLElement);

    fireEvent.change(screen.getByLabelText("Passe-haut (Hz)", { selector: "input#pre-highpass" }), {
      target: { value: "100" },
    });
    fireEvent.change(screen.getByLabelText("Passe-bas (Hz)", { selector: "input#pre-lowpass" }), {
      target: { value: "6900" },
    });
    fireEvent.change(screen.getByLabelText("Cible loudness (LUFS)", { selector: "input#pre-lufs-target" }), {
      target: { value: "-19" },
    });
    fireEvent.change(screen.getByLabelText("Seuil limiteur (dBFS)", { selector: "input#pre-limiter-threshold" }), {
      target: { value: "-1.2" },
    });
    fireEvent.change(screen.getByLabelText("Douceur limiteur", { selector: "input#pre-limiter-softness" }), {
      target: { value: "0.8" },
    });
    fireEvent.change(screen.getByLabelText("Seuil VAD (dB)", { selector: "input#pre-vad-threshold" }), {
      target: { value: "-41" },
    });
    fireEvent.change(screen.getByLabelText("Silence min (ms)", { selector: "input#pre-vad-min-silence" }), {
      target: { value: "350" },
    });
    fireEvent.change(screen.getByLabelText("Fenêtre overlap (s)", { selector: "input#pre-overlap-block" }), {
      target: { value: "1.3" },
    });
    fireEvent.change(screen.getByLabelText("Recouvrement (s)", { selector: "input#pre-overlap-sec" }), {
      target: { value: "0.35" },
    });
    fireEvent.click(screen.getByRole("button", { name: /calibrer bruit/i }));

    fireEvent.click(screen.getByText("Afficher le tableau des segments").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("VTT").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("SRT").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("JSON segments").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("Telemetry").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.memoryMode).toBe("progressive");
      expect(state.progressiveSegmentDurationSec).toBe(1200);
      expect(state.chunkStrategy).toBe("silence");
      expect(state.dedupeMode).toBe("fuzzy");
      expect(state.cleanIntraChunk).toBe(true);
      expect(state.preprocessingMode).toBe("full");
      expect(state.showSegments).toBe(true);
      expect(state.showExportVtt).toBe(false);
      expect(state.showExportSrt).toBe(false);
      expect(state.showExportJson).toBe(false);
      expect(state.showExportTelemetry).toBe(false);
    });
  }, 45000);

  it("updates mic controls, preprocessing and export toggles", async () => {
    useAsrStore.setState({
      micActivePreset: "fast",
      micPreprocessingMode: "quick",
      micShowExportVtt: true,
      micShowExportSrt: true,
      micShowExportJson: true,
      micShowExportTelemetry: true,
      micForceSingleThread: false,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="mic" />
      </ThemeProvider>
    );

    const resetButtons = await screen.findAllByRole("button", { name: "Réinitialiser ce preset" });
    fireEvent.click(resetButtons[0] as HTMLElement);

    const micPresetRow = screen.getByText("Preset").closest("div");
    fireEvent.click(micPresetRow?.querySelector("button") as HTMLElement);
    fireEvent.click(await screen.findByText("Custom"));
    fireEvent.change(screen.getByLabelText("ModelId Hugging Face", { selector: "input#mic-custom-model" }), {
      target: { value: "org/custom-mic-model" },
    });

    fireEvent.click(screen.getByText("Timestamps par mot").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByRole("switch", { name: "Afficher l'indice de confiance (micro)" }));

    fireEvent.click(screen.getByText("Micro segment").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.change(screen.getByLabelText("Seuil silence (dB)", { selector: "input#mic-silence-threshold" }), {
      target: { value: "-36" },
    });
    fireEvent.change(screen.getByLabelText("Silence min (ms)", { selector: "input#mic-min-silence" }), {
      target: { value: "850" },
    });
    fireEvent.change(screen.getByLabelText("Chunk min (ms)", { selector: "input#mic-min-chunk" }), {
      target: { value: "1400" },
    });
    fireEvent.change(screen.getByLabelText("Chunk max (ms)", { selector: "input#mic-max-chunk" }), {
      target: { value: "26000" },
    });

    const micPreprocessModeRow = screen.getAllByText("Mode de pré-traitement")[0]?.closest("div")?.parentElement;
    fireEvent.click(micPreprocessModeRow?.querySelector("button") as HTMLElement);
    fireEvent.click(await screen.findByText("Complet"));

    fireEvent.change(screen.getByLabelText("Noise floor (dB)", { selector: "input#mic-noise-floor" }), {
      target: { value: "-23" },
    });
    fireEvent.change(screen.getByLabelText("Réduction (dB)", { selector: "input#mic-reduction-db" }), {
      target: { value: "9" },
    });
    fireEvent.change(screen.getByLabelText("Lissage", { selector: "input#mic-smoothing" }), {
      target: { value: "0.55" },
    });
    fireEvent.change(screen.getByLabelText("Durée calibration (s)", { selector: "input#mic-calibration-seconds" }), {
      target: { value: "2.5" },
    });

    const findSwitch = (label: string) =>
      screen.getByText(label).closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement | null;
    fireEvent.click(findSwitch("Filtres passe-haut / passe-bas") as HTMLElement);
    fireEvent.click(findSwitch("Normalisation loudness (LUFS)") as HTMLElement);
    fireEvent.click(findSwitch("Limiteur doux") as HTMLElement);
    fireEvent.click(findSwitch("Calibration VAD (silence)") as HTMLElement);
    fireEvent.click(findSwitch("Lissage overlap-add") as HTMLElement);
    fireEvent.click(findSwitch("Autotune prétraitement (micro)") as HTMLElement);

    fireEvent.change(screen.getByLabelText("Passe-haut (Hz)", { selector: "input#mic-pre-highpass" }), {
      target: { value: "95" },
    });
    fireEvent.change(screen.getByLabelText("Passe-bas (Hz)", { selector: "input#mic-pre-lowpass" }), {
      target: { value: "7200" },
    });
    fireEvent.change(screen.getByLabelText("Cible loudness (LUFS)", { selector: "input#mic-pre-lufs-target" }), {
      target: { value: "-20" },
    });
    fireEvent.change(screen.getByLabelText("Seuil limiteur (dBFS)", { selector: "input#mic-pre-limiter-threshold" }), {
      target: { value: "-1.4" },
    });
    fireEvent.change(screen.getByLabelText("Douceur limiteur", { selector: "input#mic-pre-limiter-softness" }), {
      target: { value: "0.7" },
    });
    fireEvent.change(screen.getByLabelText("Seuil VAD (dB)", { selector: "input#mic-pre-vad-threshold" }), {
      target: { value: "-39" },
    });
    fireEvent.change(screen.getByLabelText("Silence min (ms)", { selector: "input#mic-pre-vad-min-silence" }), {
      target: { value: "280" },
    });
    fireEvent.change(screen.getByLabelText("Fenêtre overlap (s)", { selector: "input#mic-pre-overlap-block" }), {
      target: { value: "1.2" },
    });
    fireEvent.change(screen.getByLabelText("Recouvrement (s)", { selector: "input#mic-pre-overlap-sec" }), {
      target: { value: "0.25" },
    });

    fireEvent.click(screen.getByText("Forcer single-thread").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("VTT").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("SRT").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("JSON segments").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("Telemetry").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.micPreprocessingMode).toBe("full");
      expect(state.micForceSingleThread).toBe(true);
      expect(state.micShowExportVtt).toBe(false);
      expect(state.micShowExportSrt).toBe(false);
      expect(state.micShowExportJson).toBe(false);
      expect(state.micShowExportTelemetry).toBe(false);
      expect(state.micCustomModelId).toBe("org/custom-mic-model");
    });
  }, 20000);

  it("updates cloud provider fields and cloud preprocessing mode selector", async () => {
    useAsrStore.setState({
      cloudMaxTokens: 1024,
      cloudTemperature: 0.2,
      cloudTopP: 0.9,
      cloudDoSample: false,
      cloudPreprocessingMode: "quick",
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="cloud" />
      </ThemeProvider>
    );

    await userEvent.click(screen.getByRole("tab", { name: "Whisper" }));
    fireEvent.change(screen.getByLabelText("Max tokens", { selector: "input#cloud-whisper-max-tokens" }), {
      target: { value: "3072" },
    });
    fireEvent.change(screen.getByLabelText("Temperature", { selector: "input#cloud-whisper-temperature" }), {
      target: { value: "0.3" },
    });
    fireEvent.change(screen.getByLabelText("Top-p", { selector: "input#cloud-whisper-top-p" }), {
      target: { value: "0.55" },
    });
    fireEvent.click(screen.getAllByText("Sampling")[0]?.closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);

    const preprocessModeRow = screen.getByText("Mode de pré-traitement").closest("div")?.parentElement;
    fireEvent.click(preprocessModeRow?.querySelector("button") as HTMLElement);
    fireEvent.click(await screen.findByText("Complet"));

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.cloudMaxTokens).toBe(3072);
      expect(state.cloudTemperature).toBe(0.3);
      expect(state.cloudTopP).toBe(0.55);
      expect(state.cloudDoSample).toBe(true);
      expect(state.cloudPreprocessingMode).toBe("full");
    });
  }, 20000);

  it("shows dedicated demeter cloud settings only in backend mode", async () => {
    useAsrStore.setState({
      cloudDemeterModel: "voxtral-mini-latest",
      cloudDemeterDiarizationEnabled: true,
    } as any);

    const { rerender } = render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel initialTab="cloud" /></ThemeProvider>
    );

    expect(screen.queryByRole("tab", { name: "Demeter Santé" })).toBeNull();

    isBackendModeMock.mockReturnValue(true);

    rerender(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel initialTab="cloud" /></ThemeProvider>
    );

    await userEvent.click(screen.getByRole("tab", { name: "Demeter Santé" }));
    fireEvent.change(screen.getByLabelText("Model ID (Demeter Santé)"), {
      target: { value: "voxtral-demeter-custom" },
    });
    fireEvent.click(screen.getByRole("switch", { name: "Diarization Demeter Santé" }));

    await waitFor(() => {
      expect(useAsrStore.getState().cloudDemeterModel).toBe("voxtral-demeter-custom");
      expect(useAsrStore.getState().cloudDemeterDiarizationEnabled).toBe(false);
    });
    expect(screen.getByText(/backend demeter santé/i)).toBeInTheDocument();
  }, 20000);

  it("tests wasm multithread success, fallback and error branches", async () => {
    const toastSpy = vi.spyOn(toastMod, "toast");
    const logEvent = vi.fn();
    const recordAlert = vi.fn();
    useAsrStore.setState({
      telemetryCollector: { logEvent, recordAlert } as any,
      forceSingleThread: true,
      wasmThreads: 1,
    } as any);

    let resolvePending: ((value: { ok: boolean; reason?: string }) => void) | null = null;
    testWasmMultithreadSupportMock.mockImplementationOnce(
      () =>
        new Promise<{ ok: boolean; reason?: string }>((resolve) => {
          resolvePending = resolve;
        })
    );
    testWasmMultithreadSupportMock.mockResolvedValueOnce({ ok: false, reason: "not_supported" });
    testWasmMultithreadSupportMock.mockRejectedValueOnce(new Error("boom"));

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="local" />
      </ThemeProvider>
    );

    const testButton = screen.getByRole("button", { name: "Tester" });
    fireEvent.click(testButton);
    fireEvent.click(testButton);

    resolvePending?.({ ok: true, reason: "ok" });
    await waitFor(() => {
      expect(useAsrStore.getState().forceSingleThread).toBe(false);
      expect(useAsrStore.getState().wasmThreads).toBeGreaterThanOrEqual(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Tester" }));
    await waitFor(() => {
      expect(useAsrStore.getState().forceSingleThread).toBe(true);
      expect(useAsrStore.getState().wasmThreads).toBe(1);
    });
    expect(recordAlert).toHaveBeenCalledWith("WASM_MULTITHREAD_UNAVAILABLE", expect.any(Object));

    fireEvent.click(screen.getByRole("button", { name: "Tester" }));
    await waitFor(() => {
      expect(useAsrStore.getState().forceSingleThread).toBe(true);
      expect(useAsrStore.getState().wasmThreads).toBe(1);
    });

    expect(logEvent).toHaveBeenCalledWith("WASM_MULTITHREAD_TEST", expect.any(Object));
    expect(toastSpy).toHaveBeenCalled();
  }, 20000);

  it("clears cache with indexeddb fallback path and handles cancel action", async () => {
    const toastSpy = vi.spyOn(toastMod, "toast");
    const deleteCacheSpy = vi.fn(async (name: string) => name === "ok-cache");
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: vi.fn(async () => ["ok-cache", "ko-cache"]),
        delete: deleteCacheSpy,
      },
    });

    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        deleteDatabase: vi.fn((name: string) => {
          const req: Record<string, any> = { error: new Error("delete failed") };
          queueMicrotask(() => {
            if (name === "transformers_cache") {
              req.onsuccess?.();
            } else {
              req.onerror?.();
            }
          });
          return req;
        }),
      },
    });

    clearSecureTokensMock.mockRejectedValueOnce(new Error("secure clear failed"));

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const clearBtn = screen.getAllByText("Vider le cache").find((node) => node.tagName === "BUTTON");
    fireEvent.click(clearBtn as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    fireEvent.click(clearBtn as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => {
      expect(resetWebGpuSupportCacheMock).toHaveBeenCalledTimes(1);
      expect(initializeBackendSupportMock).toHaveBeenCalledTimes(1);
    });
    expect(deleteCacheSpy).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("Cache vidé"));
  });

  it("shows error toast when cache clear throws at top-level", async () => {
    const toastSpy = vi.spyOn(toastMod, "toast");
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: vi.fn(async () => ["one"]),
        delete: vi.fn(async () => true),
      },
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        databases: vi.fn(async () => []),
      },
    });
    resetWebGpuSupportCacheMock.mockImplementationOnce(() => {
      throw new Error("reset failed");
    });

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const clearBtn = screen.getAllByText("Vider le cache").find((node) => node.tagName === "BUTTON");
    fireEvent.click(clearBtn as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining("Échec lors du vidage du cache"));
    });
  });

  it("normalizes unavailable initial tabs and updates active tab when initialTab changes", async () => {
    const { rerender } = render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel showMicSettings={false} initialTab="mic" />
      </ThemeProvider>
    );

    expect(screen.getByRole("tab", { name: "Local" })).toHaveAttribute("aria-selected", "true");

    rerender(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel showMicSettings={false} initialTab="cloud" />
      </ThemeProvider>
    );

    expect(screen.getByRole("tab", { name: "Cloud" })).toHaveAttribute("aria-selected", "true");
  });

  it("updates local/mic quantization selectors and local theme/backend/custom model", async () => {
    const clickSelectItem = async (label: string) => {
      const matches = await screen.findAllByText(label);
      const selectItemText = matches.find((node) => node.closest("[data-radix-collection-item]"));
      fireEvent.click((selectItemText ?? matches.at(-1)) as HTMLElement);
    };

    useAsrStore.setState({
      activePreset: "fast",
      micActivePreset: "fast",
      wasmAvailable: false,
      backendPreference: "webgpu",
      micBackendPreference: "wasm",
      modelQuantizationOverrides: {},
    } as any);

    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialModelOpen initialTab="local" />
      </ThemeProvider>
    );

    const themeRow = screen.getByText("Thème").closest("div")?.parentElement;
    const themeTrigger = themeRow?.querySelector("button");
    fireEvent.click(themeTrigger as HTMLElement);
    await clickSelectItem("Système");

    const backendRows = screen.getAllByText("Backend");
    const localBackendTrigger = backendRows[0]?.closest("div")?.querySelector("button");
    fireEvent.click(localBackendTrigger as HTMLElement);
    expect(await screen.findByText("WASM (non disponible)")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    fireEvent.click(screen.getByLabelText("WebGPU", { selector: "button#local-quantization-webgpu" }));
    await clickSelectItem("FP32");
    fireEvent.click(screen.getByLabelText("WASM", { selector: "button#local-quantization-wasm" }));
    await clickSelectItem("UINT8");
    fireEvent.click(screen.getByText("Timestamps par mot").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);

    const localPresetRow = screen.getByText("Preset").closest("div");
    fireEvent.click(localPresetRow?.querySelector("button") as HTMLElement);
    await clickSelectItem("Custom");
    fireEvent.change(screen.getByLabelText("ModelId Hugging Face", { selector: "input#custom-model" }), {
      target: { value: "org/custom-local-model" },
    });

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("tab", { name: "Enregistrement" }));

    fireEvent.click(screen.getByLabelText("WebGPU", { selector: "button#mic-quantization-webgpu" }));
    await clickSelectItem("Q4 F16");
    fireEvent.click(screen.getByLabelText("WASM", { selector: "button#mic-quantization-wasm" }));
    await clickSelectItem("FP16");

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.customModelId).toBe("org/custom-local-model");
      expect(state.enableWordTimestamps).toBe(true);
      expect(state.backendPreference).toBe("webgpu");
      expect(state.micBackendPreference).toBe("wasm");
    });

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  }, 20000);

  it("updates local and cloud full preprocessing switches/inputs that remained uncovered", async () => {
    useAsrStore.setState({
      preprocessingMode: "full",
      autoTunePreprocess: false,
      preprocessEnableFilters: true,
      preprocessEnableLufs: true,
      preprocessLimiterEnabled: true,
      preprocessVadEnabled: true,
      preprocessOverlapAdd: true,
      cloudPreprocessingMode: "full",
      cloudAutoTunePreprocess: false,
      cloudPreprocessLimiterEnabled: true,
      cloudPreprocessOverlapAdd: true,
      micPreprocessingMode: "full",
      micAutoTunePreprocess: false,
      micPreprocessEnableLufs: true,
    } as any);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel initialTab="local" initialChunkingOpen />
      </ThemeProvider>
    );

    const findSwitch = (label: string) =>
      screen.getByText(label).closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement | null;
    fireEvent.click(findSwitch("Segmentation fichier") as HTMLElement);
    fireEvent.click(findSwitch("Filtres passe-haut / passe-bas") as HTMLElement);
    fireEvent.click(findSwitch("Normalisation loudness (LUFS)") as HTMLElement);
    fireEvent.click(findSwitch("Limiteur doux") as HTMLElement);
    fireEvent.click(findSwitch("Calibration VAD (silence)") as HTMLElement);
    fireEvent.click(findSwitch("Lissage overlap-add") as HTMLElement);
    fireEvent.click(screen.getByText("Forcer single-thread").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);
    fireEvent.click(screen.getByText("Forcer single-thread").closest("div")?.parentElement?.querySelector('[role="switch"]') as HTMLElement);

    await userEvent.click(screen.getByRole("tab", { name: "Enregistrement" }));
    fireEvent.change(screen.getByLabelText("Cible loudness (LUFS)", { selector: "input#mic-pre-lufs-target" }), {
      target: { value: "-18.5" },
    });

    await userEvent.click(screen.getByRole("tab", { name: "Cloud" }));
    fireEvent.change(screen.getByLabelText("Douceur limiteur", { selector: "input#cloud-pre-limiter-softness" }), {
      target: { value: "0.65" },
    });
    fireEvent.change(screen.getByLabelText("Fenêtre overlap (s)", { selector: "input#cloud-pre-overlap-block" }), {
      target: { value: "1.4" },
    });
    fireEvent.change(screen.getByLabelText("Recouvrement (s)", { selector: "input#cloud-pre-overlap-sec" }), {
      target: { value: "0.3" },
    });

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.preprocessEnableFilters).toBe(false);
      expect(state.preprocessEnableLufs).toBe(false);
      expect(state.preprocessLimiterEnabled).toBe(false);
      expect(state.preprocessVadEnabled).toBe(false);
      expect(state.preprocessOverlapAdd).toBe(false);
      expect(state.micPreprocessTargetLufs).toBe(-18.5);
      expect(state.cloudPreprocessLimiterSoftness).toBe(0.65);
      expect(state.cloudPreprocessOverlapBlockSec).toBe(1.4);
      expect(state.cloudPreprocessOverlapSec).toBe(0.3);
    });
  }, 20000);

  it("exercises clear-cache indexeddb enumeration and compute-stats indexeddb sampling branches", async () => {
    const originalCaches = (globalThis as any).caches;
    const originalIndexedDb = (globalThis as any).indexedDB;
    const originalNavigatorStorage = (navigator as any).storage;

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: {
        keys: vi.fn(async () => ["ok-cache", "throw-cache"]),
        delete: vi.fn(async (name: string) => {
          if (name === "throw-cache") {
            throw new Error("cache delete error");
          }
          return false;
        }),
        open: vi.fn(async () => ({
          keys: vi.fn(async () => [new Request("https://cache.test/a"), new Request("https://cache.test/b")]),
          match: vi.fn(async () => new Response("cached-without-length")),
        })),
      },
    });

    const makeDeleteRequest = (name: string) => {
      const req: Record<string, any> = { error: new Error(`delete failed: ${name}`) };
      queueMicrotask(() => {
        req.onblocked?.();
        if (name === "db-ok") {
          req.onsuccess?.();
        } else {
          req.onerror?.();
        }
      });
      return req;
    };

    const makeCountRequest = () => {
      const req: Record<string, any> = { result: 2, error: null };
      queueMicrotask(() => req.onsuccess?.());
      return req;
    };

    const makeCursorRequest = () => {
      const req: Record<string, any> = {};
      let index = 0;
      const values = [{ a: 1 }, { b: 2 }];
      const emit = () => {
        if (index < values.length) {
          const value = values[index++];
          req.onsuccess?.({
            target: {
              result: {
                value,
                continue: () => queueMicrotask(emit),
              },
            },
          });
          return;
        }
        req.onsuccess?.({ target: { result: null } });
      };
      queueMicrotask(emit);
      return req;
    };

    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        databases: vi.fn(async () => [{ name: "db-ok" }, { name: "db-ko" }, { name: undefined }]),
        deleteDatabase: vi.fn((name: string) => makeDeleteRequest(name)),
        open: vi.fn((name: string) => {
          const req: Record<string, any> = {
            result: {
              objectStoreNames: { length: 1, 0: "samples" },
              transaction: vi.fn(() => ({
                objectStore: vi.fn(() => ({
                  count: makeCountRequest,
                  openCursor: makeCursorRequest,
                })),
              })),
              close: vi.fn(),
            },
            error: new Error(`open failed: ${name}`),
          };
          queueMicrotask(() => req.onsuccess?.());
          return req;
        }),
      },
    });

    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: {
        estimate: vi.fn(async () => {
          throw new Error("estimate failed");
        }),
      },
    });

    localStorage.setItem("local-key", "local-value");
    sessionStorage.setItem("session-key", "session-value");

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const clearBtn = screen.getAllByText("Vider le cache").find((node) => node.tagName === "BUTTON");
    fireEvent.click(clearBtn as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Confirmer" }));
    await waitFor(() => {
      expect(initializeBackendSupportMock).toHaveBeenCalled();
    });

    await userEvent.click(screen.getByRole("button", { name: "Rafraîchir" }));
    await waitFor(() => {
      expect(screen.getByText("db-ok")).toBeInTheDocument();
    });

    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: originalCaches,
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: originalIndexedDb,
    });
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: originalNavigatorStorage,
    });
    localStorage.clear();
    sessionStorage.clear();
  }, 25000);
});
