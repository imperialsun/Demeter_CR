import { describe, it, expect } from "vitest";
import { renderWithStore } from "@/test/utils";
import { fireEvent, screen } from "@testing-library/react";
import CloudUploadPage from "./CloudUploadPage";

describe("CloudUploadPage", () => {
  it("renders the cloud upload UI with all providers", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudMaxTokens: 2048,
      cloudTemperature: 0.4,
      cloudTopP: 0.8,
      cloudDoSample: true,
    });
    expect(screen.getByText("Transcription cloud")).toBeTruthy();
    expect(screen.getByText("Provider")).toBeTruthy();
    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    expect(providerSelect.textContent).toContain("Gradio");
    expect(screen.getByText(/Afficher le contexte/i)).toBeTruthy();
    expect(screen.getByText("Importer un fichier audio")).toBeTruthy();
    expect(screen.getByText("Lancer la transcription")).toBeTruthy();

    fireEvent.click(providerSelect);
    expect(screen.getByText("Whisper")).toBeTruthy();
    expect(screen.getByText("Mistral")).toBeTruthy();
  });

  it("shows inline alert when whisper token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudHfToken: "",
      cloudMistralApiKey: "mistral_secret",
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Whisper"));

    expect(screen.getByText(/ne peut pas fonctionner sans cle api hugging face/i)).toBeInTheDocument();
  });

  it("shows inline alert when mistral token is missing", () => {
    renderWithStore(<CloudUploadPage />, {
      cloudApiUrl: "https://cloud.example",
      cloudHfToken: "hf_token",
      cloudMistralApiKey: "",
    });

    const providerSelect = screen.getByRole("combobox", { name: /provider/i });
    fireEvent.click(providerSelect);
    fireEvent.click(screen.getByText("Mistral"));

    expect(screen.getByText(/ne peut pas fonctionner sans cle api mistral/i)).toBeInTheDocument();
  });
});
