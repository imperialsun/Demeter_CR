/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen, fireEvent } from '@testing-library/dom';
import { SettingsPanel } from './SettingsPanel';
import { useAsrStore } from '@/store/asr-store';
import * as toastMod from '@/components/ui/use-toast';
import { ThemeProvider } from '@/components/theme-provider';
import { waitFor } from '@testing-library/react';
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
    const labelQuery = () => screen.queryByText((_, node) => !!node?.textContent?.includes("Afficher l'indice de confiance"));
    if (!labelQuery()) {
      expect(showBtn).toBeTruthy();
      fireEvent.click(showBtn!);
    }

    // Try to find the switch directly by its accessible name; open the model section if needed
    let segSwitch = screen.queryByRole('switch', { name: "Afficher l'indice de confiance" });
    if (!segSwitch) {
      expect(showBtn).toBeTruthy();
      fireEvent.click(showBtn!);
      segSwitch = await screen.findByRole('switch', { name: "Afficher l'indice de confiance" });
    }
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
});
