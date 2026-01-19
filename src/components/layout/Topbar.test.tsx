/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Topbar } from './Topbar';
import { useAsrStore } from '@/store/asr-store';
import * as backendSupport from '@/lib/backend-support';
import * as toastMod from '@/components/ui/use-toast';
import * as rr from 'react-router-dom';
import * as logger from '@/lib/logger';

// Mock react-router hooks used by the component
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const mod = await vi.importActual('react-router-dom');
  return {
    ...mod,
    useNavigate: () => mockNavigate,
    useLocation: () => ({ pathname: '/upload' }),
  };
});

vi.mock('@/hooks/useTranscriptionController', () => ({
  useTranscriptionController: () => ({ abortTranscription: vi.fn() }),
}));

vi.mock('@/lib/logger', () => ({
  exportLogEntries: vi.fn(() => [{ timestamp: 't1', level: 'info', message: ['log'] }]),
}));

describe('Topbar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // reset store defaults used by Topbar
    useAsrStore.setState({
      activePreset: 'fast',
      customModelId: undefined,
      backendPreference: 'webgpu',
      activeBackend: undefined,
      status: 'idle',
      statusDetail: undefined,
      wasmThreads: 1,
      preprocessingMode: 'fast',
      debugConfidence: false,
      setDebugConfidence: (v: boolean) => useAsrStore.setState({ debugConfidence: v }),
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('navigates to /settings when settings button clicked and not already on settings', () => {
    render(<Topbar />);
    const btn = screen.getByLabelText('Aller aux paramètres');
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
  });

  it('navigates to /upload when on settings', () => {
    // override useLocation to simulate being on /settings
    vi.spyOn(rr, 'useLocation').mockReturnValue({ pathname: '/settings', search: '', state: null, hash: '', key: '' } as any);
    render(<Topbar />);
    const btn = screen.getByLabelText('Aller aux paramètres');
    fireEvent.click(btn);
    expect(mockNavigate).toHaveBeenCalledWith('/upload');
  });

  it('opens confirm and calls resetApp on confirm', async () => {
    const resetSpy = vi.fn();
    useAsrStore.setState({ resetApp: resetSpy } as any);
    const toastSpy = vi.spyOn(toastMod, 'toast').mockImplementation(() => 't-id' as any);
    vi.spyOn(backendSupport, 'initializeBackendSupport').mockResolvedValue(true);

    render(<Topbar />);

    const resetBtn = screen.getByText('Réinitialiser');
    fireEvent.click(resetBtn);

    // Confirm dialog should show "Confirmer" button
    const confirm = await screen.findByText('Confirmer');
    fireEvent.click(confirm);

    // resetApp should have been called
    expect(resetSpy).toHaveBeenCalled();
    expect(toastSpy).toHaveBeenCalled();
  });

  it('toggles debug confidence via the debug button', () => {
    render(<Topbar />);
    // debug button should be visible in non-production test env
    const debugBtn = screen.getByText(/Debug conf/i);
    expect(debugBtn).toBeTruthy();

    fireEvent.click(debugBtn);
    expect(useAsrStore.getState().debugConfidence).toBe(true);
  });

  it('exports logs to clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    vi.spyOn(toastMod, 'toast').mockImplementation(() => 't-id' as any);

    render(<Topbar />);
    fireEvent.click(screen.getByText('Exporter logs'));

    expect(writeText).toHaveBeenCalled();
    const payload = JSON.parse(writeText.mock.calls[0]![0] as string) as { logs?: unknown[] };
    expect(payload.logs).toEqual(logger.exportLogEntries());
  });
});
