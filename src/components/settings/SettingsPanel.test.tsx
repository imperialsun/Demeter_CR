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

vi.mock('@/lib/backend-support', () => ({
  initializeBackendSupport: vi.fn(async () => true),
  resetWebGpuSupportCache: vi.fn(),
}));
describe('SettingsPanel', () => {
  beforeEach(() => {
    // Reset store to defaults before each test
    useAsrStore.setState({
      showSegmentConfidence: false,
      setShowSegmentConfidence: (v: boolean) => useAsrStore.setState({ showSegmentConfidence: v }),
      setEnableWordTimestamps: (v: boolean) => useAsrStore.setState({ enableWordTimestamps: v }),
    } as any);
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
});
