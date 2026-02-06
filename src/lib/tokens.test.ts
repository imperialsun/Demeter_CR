import { describe, it, expect } from "vitest";
import { estimateTokenCount } from "./tokens";

describe("estimateTokenCount", () => {
  it("counts words and numbers", () => {
    expect(estimateTokenCount("Bonjour le monde 123")).toBe(4);
  });

  it("handles apostrophes and dashes", () => {
    expect(estimateTokenCount("L'été d'aujourd'hui est bien-aimé")).toBe(4);
  });

  it("returns 0 for empty input", () => {
    expect(estimateTokenCount("")).toBe(0);
  });
});
