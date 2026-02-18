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

vi.mock('@/lib/backend-support', () => ({
  initializeBackendSupport: vi.fn(async () => true),
  resetWebGpuSupportCache: vi.fn(),
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

describe('SettingsPanel', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useAsrStore.setState({
      showSegmentConfidence: false,
      enableWordTimestamps: false,
      cloudMistralApiKey: "",
      cloudMistralApiUrl: "https://api.mistral.ai",
      llmApiProvider: "huggingface",
      llmApiHfToken: "",
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

  it("updates cloud api url from settings", async () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const cloudTab = screen.getByText("Cloud");
    await userEvent.click(cloudTab);

    const input = screen.getByLabelText("URL Gradio", { selector: "input#cloud-api-url" });
    fireEvent.change(input, { target: { value: "https://example.com/" } });

    expect(useAsrStore.getState().cloudApiUrl).toBe("https://example.com/");
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

    expect(useAsrStore.getState().cloudHfToken).toBe("hf_test_token");
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

    expect(useAsrStore.getState().cloudMistralApiKey).toBe("mistral_secret");
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
      cloudMistralApiKey: "mistral_key",
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
});
