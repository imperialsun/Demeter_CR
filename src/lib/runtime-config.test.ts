import { beforeEach, describe, expect, it, vi } from "vitest";

describe("runtime config", () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.__APP_RUNTIME_CONFIG__;
  });

  it.each([
    ["/api/v2", "/api/v2"],
    ["https://api.example.com/v1/", "https://api.example.com/v1"],
    ["http://localhost:8080/api/v1", "http://localhost:8080/api/v1"],
    ["http://127.0.0.1:8080/api/v1", "http://127.0.0.1:8080/api/v1"],
  ])("accepts a safe backend URL", async (backendBaseUrl, expected) => {
    window.__APP_RUNTIME_CONFIG__ = { mode: "backend", backendBaseUrl };

    const { getRuntimeConfig } = await import("./runtime-config");

    expect(getRuntimeConfig()).toEqual({ mode: "backend", backendBaseUrl: expected });
  });

  it.each([
    "http://api.example.com/v1",
    "//api.example.com/v1",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects an unsafe backend URL", async (backendBaseUrl) => {
    window.__APP_RUNTIME_CONFIG__ = { mode: "backend", backendBaseUrl };

    const { getRuntimeConfig } = await import("./runtime-config");

    expect(getRuntimeConfig().backendBaseUrl).toBe("/api/v1");
  });
});
