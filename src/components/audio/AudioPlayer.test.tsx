/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { renderWithStore } from '@/test/utils';
import { AudioPlayer } from './AudioPlayer';

// Simple helpers to mock play/pause on HTMLMediaElement
beforeEach(() => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

  // Replace paused getter with a configurable mock and mock play/pause to update internal state
  let _paused = true;
  Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
    get() {
      return _paused;
    },
    configurable: true,
  });

  (HTMLMediaElement.prototype as any).play = async function () {
    _paused = false;
    return Promise.resolve();
  };
  (HTMLMediaElement.prototype as any).pause = function () {
    _paused = true;
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function createTestFile() {
  return new File([new Blob(['test'], { type: 'audio/wav' })], 'foo.wav', { type: 'audio/wav' });
}

describe('AudioPlayer', () => {
  it('renders metadata and formatted duration', () => {
    const file = createTestFile();
    const metadata = { name: 'foo.wav', durationSec: 75, sampleRate: 16000 } as any;
    renderWithStore(<AudioPlayer file={file} metadata={metadata} />);

    expect(screen.getByText(/Pré-écoute/)).toBeInTheDocument();
    expect(screen.getByText('Nom : foo.wav')).toBeInTheDocument();
    expect(screen.getByText(/Durée :/)).toBeInTheDocument();
    expect(screen.getByText(/Sample rate : 16000 Hz/)).toBeInTheDocument();
  });

  it('renders long metadata file names without dropping them', () => {
    const file = createTestFile();
    const metadata = {
      name: 'consultation_audio_nom_extremement_long_2026_03_12_version_finale_avec_suffixe_preparation.wav',
      durationSec: 75,
      sampleRate: 16000,
    } as any;
    renderWithStore(<AudioPlayer file={file} metadata={metadata} />);

    expect(screen.getByText(/consultation_audio_nom_extremement_long_2026_03_12/i)).toBeInTheDocument();
  });

  it('play button triggers play and toggles to Pause', async () => {
    const file = createTestFile();
    renderWithStore(<AudioPlayer file={file} metadata={null} />);

    const playButton = screen.getByRole('button', { name: /Lecture/i });
    expect(playButton).toBeInTheDocument();

    await fireEvent.click(playButton);
    // After click the UI should show Pause label
    expect(screen.getByText(/Pause/i)).toBeInTheDocument();
  });

  it('skip forward/back updates current time', () => {
    const file = createTestFile();
    renderWithStore(<AudioPlayer file={file} metadata={null} />);

    const audio = document.querySelector('audio') as HTMLAudioElement;
    // Ensure duration/currentTime are writable on this instance for tests
    Object.defineProperty(audio, 'duration', { value: 100, configurable: true });
    Object.defineProperty(audio, 'currentTime', { value: 10, writable: true, configurable: true });
    audio.currentTime = 10;

    const back = screen.getByRole('button', { name: /Recule de 5s/i });
    const forward = screen.getByRole('button', { name: /Avance de 5s/i });

    fireEvent.click(forward);
    expect(audio.currentTime).toBeGreaterThanOrEqual(14.99);

    fireEvent.click(back);
    expect(audio.currentTime).toBeGreaterThanOrEqual(9.99);
  });

  it('prev/next segment navigates between segments using store', () => {
    const file = createTestFile();
    const segments = [
      { index: 0, start: 0, text: 'a' },
      { index: 1, start: 5, text: 'b' },
      { index: 2, start: 10, text: 'c' },
    ];
    // set currentTime to 6 so prev should go to 5
    const store = { segments } as any;
    renderWithStore(<AudioPlayer file={file} metadata={null} />, store);

    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'currentTime', { value: 6, writable: true, configurable: true });
    audio.currentTime = 6;
    // dispatch timeupdate so component updates its currentTime state
    fireEvent(audio, new Event('timeupdate'));

    const prev = screen.getByRole('button', { name: /Segment précédent/i });
    fireEvent.click(prev);
    expect(audio.currentTime).toBeCloseTo(5, 2);

    const next = screen.getByRole('button', { name: /Segment suivant/i });
    fireEvent.click(next);
    // should go to next segment > 6 which is 10
    expect(audio.currentTime).toBeCloseTo(10, 2);
  });
});
