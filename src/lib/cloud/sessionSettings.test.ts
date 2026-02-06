import { describe, it, expect } from "vitest";
import { resolveCloudSessionSettings } from "./sessionSettings";

describe("resolveCloudSessionSettings", () => {
  const defaults = {
    apiUrl: "https://default.example",
    maxTokens: 1024,
    temperature: 0.5,
    topP: 0.9,
    doSample: false,
  };

  it("falls back to defaults when session overrides are empty", () => {
    const resolved = resolveCloudSessionSettings(defaults, {});
    expect(resolved.apiUrl).toBe(defaults.apiUrl);
    expect(resolved.maxTokens).toBe(defaults.maxTokens);
    expect(resolved.temperature).toBe(defaults.temperature);
    expect(resolved.topP).toBe(defaults.topP);
    expect(resolved.doSample).toBe(defaults.doSample);
    expect(resolved.sources).toEqual({
      apiUrl: "settings",
      maxTokens: "settings",
      temperature: "settings",
      topP: "settings",
      doSample: "settings",
    });
  });

  it("prefers session overrides when provided", () => {
    const resolved = resolveCloudSessionSettings(defaults, {
      apiUrl: "  https://session.example  ",
      maxTokens: 2048,
      temperature: 0.2,
      topP: 0.6,
      doSample: true,
    });
    expect(resolved.apiUrl).toBe("https://session.example");
    expect(resolved.maxTokens).toBe(2048);
    expect(resolved.temperature).toBe(0.2);
    expect(resolved.topP).toBe(0.6);
    expect(resolved.doSample).toBe(true);
    expect(resolved.sources).toEqual({
      apiUrl: "session",
      maxTokens: "session",
      temperature: "session",
      topP: "session",
      doSample: "session",
    });
  });

  it("ignores invalid numeric overrides", () => {
    const resolved = resolveCloudSessionSettings(defaults, {
      maxTokens: Number.NaN,
      temperature: Number.POSITIVE_INFINITY,
      topP: Number.NEGATIVE_INFINITY,
    });
    expect(resolved.maxTokens).toBe(defaults.maxTokens);
    expect(resolved.temperature).toBe(defaults.temperature);
    expect(resolved.topP).toBe(defaults.topP);
    expect(resolved.sources.maxTokens).toBe("settings");
    expect(resolved.sources.temperature).toBe("settings");
    expect(resolved.sources.topP).toBe("settings");
  });
});
