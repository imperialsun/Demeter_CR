import { describe, it, expect } from "vitest";
import { renderWithStore } from "@/test/utils";
import CloudUploadPage from "./CloudUploadPage";

describe("CloudUploadPage", () => {
  it("renders the cloud upload placeholder", () => {
    renderWithStore(<CloudUploadPage />);
    expect(document.body.textContent).toContain("Transcription cloud");
    expect(document.body.textContent).toContain("Contenu a venir");
  });
});
