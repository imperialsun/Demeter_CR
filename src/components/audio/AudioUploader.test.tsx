import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AudioUploader } from "./AudioUploader";

describe("AudioUploader component", () => {
  it("calls onFileSelected when a file is chosen via input", () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["hello"], "hello.wav", { type: "audio/wav" });
    fireEvent.change(fileInput, { target: { files: [file] } });

    expect(onFileSelected).toHaveBeenCalledTimes(1);
    expect(onFileSelected).toHaveBeenCalledWith(file);
  });

  it("handles drag and drop file", () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} />);

    const dropzone = screen.getByRole("button");
    const file = new File(["x"], "x.wav", { type: "audio/wav" });
    const dataTransfer = { files: [file], items: { add: () => {} } } as unknown as DataTransfer;

    fireEvent.drop(dropzone, { dataTransfer });

    expect(onFileSelected).toHaveBeenCalledTimes(1);
    expect(onFileSelected.mock.calls[0][0].name).toBe("x.wav");
  });

  it("does not allow selection when disabled", () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} disabled />);

    fireEvent.click(screen.getByRole("button"));
    expect(onFileSelected).not.toHaveBeenCalled();
  });

  it("updates drag style on drag over and leave", () => {
    render(<AudioUploader onFileSelected={() => undefined} />);

    const dropzone = screen.getByRole("button");
    fireEvent.dragOver(dropzone);
    expect(dropzone.className).toContain("border-primary");

    fireEvent.dragLeave(dropzone);
    expect(dropzone.className).not.toContain("border-primary");
  });

  it("uses main input click path when file input is actionable", () => {
    render(<AudioUploader onFileSelected={() => undefined} />);

    const dropzone = screen.getByRole("button");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    Object.defineProperty(fileInput, "offsetParent", {
      configurable: true,
      get: () => document.body,
    });
    const focusSpy = vi.spyOn(fileInput, "focus").mockImplementation(() => undefined);
    const clickSpy = vi.spyOn(fileInput, "click").mockImplementation(() => undefined);

    fireEvent.click(dropzone);

    expect(focusSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a temporary input when primary input is not actionable", () => {
    const onFileSelected = vi.fn();
    render(<AudioUploader onFileSelected={onFileSelected} />);

    const dropzone = screen.getByRole("button");
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    vi.spyOn(fileInput, "click").mockImplementation(() => {
      throw new Error("native picker blocked");
    });
    let fallbackInput: HTMLInputElement | null = null;
    const appendOriginal = document.body.appendChild.bind(document.body);
    const appendSpy = vi
      .spyOn(document.body, "appendChild")
      .mockImplementation(((node: Node) => {
        if (node instanceof HTMLInputElement && node.type === "file") {
          fallbackInput = node;
        }
        return appendOriginal(node);
      }) as typeof document.body.appendChild);

    fireEvent.click(dropzone);
    expect(fallbackInput).not.toBeNull();

    const fallbackFile = new File(["fallback"], "fallback.mp3", { type: "audio/mpeg" });
    Object.defineProperty(fallbackInput as HTMLInputElement, "files", {
      configurable: true,
      value: [fallbackFile],
    });
    fireEvent.change(fallbackInput as HTMLInputElement);

    expect(onFileSelected).toHaveBeenCalledWith(fallbackFile);
    appendSpy.mockRestore();
  });

  it("renders warning blocks for long files and metadata fields", () => {
    const onFileSelected = vi.fn();
    const { rerender } = render(
      <AudioUploader
        onFileSelected={onFileSelected}
        metadata={{
          name: "long.wav",
          durationSec: 3665,
          mimeType: "audio/wav",
          sizeBytes: 2048,
          sampleRate: 16000,
        }}
      />
    );

    expect(screen.getByText(/Durée > 1 h/i)).toBeInTheDocument();
    expect(screen.getByText("2.0 Ko")).toBeInTheDocument();
    expect(screen.getByText("01:01:05")).toBeInTheDocument();

    rerender(
      <AudioUploader
        onFileSelected={onFileSelected}
        metadata={{
          name: "very-long.wav",
          durationSec: 8000,
          mimeType: "audio/wav",
          sizeBytes: 4096,
          sampleRate: 16000,
        }}
      />
    );
    expect(screen.getByText(/Fichier très long/i)).toBeInTheDocument();
  });

  it("shows fallback duration when duration is not finite", () => {
    render(
      <AudioUploader
        onFileSelected={() => undefined}
        metadata={{
          name: "invalid.wav",
          durationSec: Number.POSITIVE_INFINITY,
          mimeType: "audio/wav",
          sizeBytes: 0,
          sampleRate: 0,
        }}
      />
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders long file names in metadata without dropping them", () => {
    render(
      <AudioUploader
        onFileSelected={() => undefined}
        metadata={{
          name: "consultation_audio_nom_extremement_long_2026_03_12_version_finale_avec_suffixe_preparation_et_revision.wav",
          durationSec: 42,
          mimeType: "audio/wav",
          sizeBytes: 2048,
          sampleRate: 16000,
        }}
      />
    );

    expect(screen.getByText(/consultation_audio_nom_extremement_long_2026_03_12/i)).toBeInTheDocument();
  });
});
