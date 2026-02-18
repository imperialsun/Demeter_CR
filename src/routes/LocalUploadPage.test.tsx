/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen, fireEvent, waitFor } from '@testing-library/react';
import { renderWithStore } from '@/test/utils';
import { useAsrStore } from '@/store/asr-store';
import LocalUploadPage from './LocalUploadPage';
import * as audioLib from '@/lib/audio';

// Render helper sets store state directly for tests

describe('LocalUploadPage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows local transcription privacy notice', () => {
    renderWithStore(<LocalUploadPage />);
    expect(screen.getByText('Transcription locale')).toBeInTheDocument();
    expect(
      screen.getByText(/aucun fichier audio ni transcription n'est transmis au cloud/i)
    ).toBeInTheDocument();
  });

  it('expands the privacy note when clicked', () => {
    renderWithStore(<LocalUploadPage />);
    const toggle = screen.getByText('Note de confidentialité');
    expect(screen.queryByText(/fichiers audio/i)).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByText(/fichiers audio/i)).toBeInTheDocument();
  });

  it("shows overall confidence badge and '(estimée)' when source is estimated", () => {
    const storeOverrides = {
      segments: [{ index: 0, text: 'hello', confidence: 0.7, confidenceSource: 'estimated' }],
      showSegments: true,
      transcriptionConfidence: 0.7,
      transcriptionConfidenceSource: 'estimated',
    } as any;

    renderWithStore(<LocalUploadPage />, storeOverrides);

    expect(screen.getByText(/Indice de confiance globale/i)).toBeInTheDocument();
    // transcriptionConfidence 0.7 should render as '70%'
    expect(screen.getByText('70%')).toBeInTheDocument();
    expect(screen.getByText('(estimée)')).toBeInTheDocument();
  });

  it('hides segments section when there are no segments', () => {
    const storeOverrides = {
      segments: [],
      showSegments: true,
      transcriptionConfidence: null,
    } as any;
    renderWithStore(<LocalUploadPage />, storeOverrides);
    expect(screen.getByText(/Les segments apparaîtront ici/)).toBeInTheDocument();
  });

  it('shows reset session button and clears local upload session state', async () => {
    renderWithStore(<LocalUploadPage />, {
      uploadedFile: new File(['audio'], 'test.mp3', { type: 'audio/mpeg' }),
      previewUrl: 'blob:local-preview',
      segments: [{ index: 0, text: 'bonjour' }],
      showSegments: true,
      status: 'ready',
      statusDetail: 'Prêt',
    } as any);

    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: /Réinitialiser la session/i }));

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.uploadedFile).toBeNull();
      expect(state.previewUrl).toBeNull();
      expect(state.segments).toHaveLength(0);
      expect(state.status).toBe('idle');
      expect(state.statusDetail).toBe('Session réinitialisée');
    });

    revokeSpy.mockRestore();
  });

  it("shows a blocking model-size alert dialog when local upload alert is present", () => {
    renderWithStore(<LocalUploadPage />, {
      localUploadModelSizeAlert: {
        title: "Modele trop gros",
        description: "Memoire insuffisante.",
        severity: "error",
        signature: "localupload:test:error",
      },
    } as any);

    expect(screen.getByRole("dialog", { name: "Modele trop gros" })).toBeInTheDocument();
    expect(screen.getByText("Memoire insuffisante.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /compris/i })).toBeInTheDocument();
  });

  it("clears local upload model-size alert when acknowledged", async () => {
    renderWithStore(<LocalUploadPage />, {
      localUploadModelSizeAlert: {
        title: "Modele trop gros",
        description: "Memoire insuffisante.",
        severity: "error",
        signature: "localupload:test:error",
      },
    } as any);

    fireEvent.click(screen.getByRole("button", { name: /compris/i }));

    await waitFor(() => {
      expect(useAsrStore.getState().localUploadModelSizeAlert).toBeNull();
    });
  });

  it("stores selected file and generates preview url when selecting an upload", async () => {
    vi.spyOn(audioLib, "probeAudioMetadata").mockResolvedValue({
      durationSec: 42,
      sampleRate: 16000,
      channels: 1,
      sizeBytes: 5,
      mimeType: "audio/wav",
      name: "picked.wav",
    } as any);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:picked-file");

    renderWithStore(<LocalUploadPage />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["audio"], "picked.wav", { type: "audio/wav" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.uploadedFile?.name).toBe("picked.wav");
      expect(state.previewUrl).toBe("blob:picked-file");
      expect(state.status).toBe("idle");
    });
  });

  it("sets error status when audio metadata probing fails", async () => {
    vi.spyOn(audioLib, "probeAudioMetadata").mockRejectedValue(new Error("metadata failed"));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:broken-file");

    renderWithStore(<LocalUploadPage />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["audio"], "broken.wav", { type: "audio/wav" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await waitFor(() => {
      const state = useAsrStore.getState();
      expect(state.status).toBe("error");
      expect(state.statusDetail).toMatch(/impossible d'analyser le fichier audio/i);
    });
  });
});
