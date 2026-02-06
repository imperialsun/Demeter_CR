import { describe, it, expect } from "vitest";
import { normalizeCloudApiUrl } from "./asr-store";

describe("normalizeCloudApiUrl", () => {
  const fallback = "https://transcode.demeter-sante.fr/gradio";

  it("keeps gradio base paths and trims trailing slashes", () => {
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio", fallback)).toBe(
      "https://transcode.demeter-sante.fr/gradio"
    );
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio/", fallback)).toBe(
      "https://transcode.demeter-sante.fr/gradio"
    );
  });

  it("normalizes gradio api paths back to origin", () => {
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio_api", fallback)).toBe(
      "https://transcode.demeter-sante.fr"
    );
    expect(normalizeCloudApiUrl("https://transcode.demeter-sante.fr/gradio_api/info", fallback)).toBe(
      "https://transcode.demeter-sante.fr"
    );
  });

  it("returns fallback on empty inputs", () => {
    expect(normalizeCloudApiUrl("", fallback)).toBe(fallback);
    expect(normalizeCloudApiUrl("   ", fallback)).toBe(fallback);
    expect(normalizeCloudApiUrl(undefined, fallback)).toBe(fallback);
  });
});
