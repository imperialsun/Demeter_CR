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

const { fetchMistralModelsSafeMock } = vi.hoisted(() => ({
  fetchMistralModelsSafeMock: vi.fn(async () => []),
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

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    const micTab = screen.getByText('Enregistrement');
    await userEvent.click(micTab);

    const micSwitch = await screen.findByRole('switch', { name: "Afficher l'indice de confiance (micro)" });
    fireEvent.click(micSwitch);

    expect(useAsrStore.getState().micShowSegmentConfidence).toBe(true);
    expect(useAsrStore.getState().micEnableWordTimestamps).toBe(true);
  });

  it("forces mic backend to wasm when WebGPU is unavailable", async () => {
    useAsrStore.setState({ webGpuSupported: false, micBackendPreference: "webgpu" } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    await waitFor(() => {
      expect(useAsrStore.getState().micBackendPreference).toBe("wasm");
    });
  });

  it("toggles mic autotune and enables mic controls", async () => {
    useAsrStore.setState({ micAutoTunePreprocess: true, micPreprocessingMode: "full" } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    const micTab = screen.getByText('Enregistrement');
    await userEvent.click(micTab);

    const slider = screen.getByLabelText("Noise floor (dB)", { selector: "input#mic-noise-floor" });
    expect(slider).toBeDisabled();

    const autoTuneSwitch = await screen.findByRole('switch', { name: "Autotune prétraitement (micro)" });
    await userEvent.click(autoTuneSwitch);

    await waitFor(() => {
      expect(useAsrStore.getState().micAutoTunePreprocess).toBe(false);
      expect(slider).not.toBeDisabled();
    });
  });

  it("updates mic noise calibration margin", async () => {
    useAsrStore.setState({ micNoiseCalibrationMarginDb: 6 } as any);

    render(<ThemeProvider defaultTheme="dark" storageKey="demeter-theme"><SettingsPanel /></ThemeProvider>);

    const micTab = screen.getByText('Enregistrement');
    await userEvent.click(micTab);

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
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    const cloudTab = screen.getByText("Cloud");
    await userEvent.click(cloudTab);

    await userEvent.click(screen.getByRole("tab", { name: "Whisper" }));
    fireEvent.change(
      screen.getByLabelText("Durée chunk (s)", { selector: "input#cloud-whisper-chunk-duration" }),
      { target: { value: "45" } }
    );
    fireEvent.change(
      screen.getByLabelText("Recouvrement (s)", { selector: "input#cloud-whisper-overlap" }),
      { target: { value: "2" } }
    );

    await userEvent.click(screen.getByRole("tab", { name: "Mistral" }));
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
  });

  it("shows llm cloud tab by default", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <SettingsPanel />
      </ThemeProvider>
    );

    expect(screen.getByRole("tab", { name: "LLM Cloud" })).toBeInTheDocument();
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
});
