import { describe, it, expect } from "vitest";
import { buildCloudContext } from "./context";

describe("buildCloudContext", () => {
  it("prefers session context when provided", () => {
    expect(buildCloudContext("preset", "session")).toBe("preset\nsession");
    expect(buildCloudContext("", "session")).toBe("session");
  });

  it("falls back to preset when session is empty", () => {
    expect(buildCloudContext("preset", "")).toBe("preset");
    expect(buildCloudContext("preset", "   ")).toBe("preset");
  });
});
