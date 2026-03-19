/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const originalConsole = {
  debug: console.debug,
  log: console.log,
  warn: console.warn,
  error: console.error,
};

const LOG_CACHE_KEY = "demeter-log-cache";

describe("logger", () => {
  beforeEach(() => {
    console.log = originalConsole.log;
    console.debug = originalConsole.debug;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    const store = new Map<string, string>();
    const mockStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    };
    vi.stubGlobal("localStorage", mockStorage);
    localStorage.clear();
    vi.resetModules();
  });

  it("filters console output by the configured log level", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { info, debug, warn, error, setLogLevelProvider } = await import("./logger");

    setLogLevelProvider(() => "warn");

    info("[test] hidden info");
    debug("[test] hidden debug");
    warn("[test] visible warn");
    error("[test] visible error");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the same structured console rendering regardless of environment", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { info, setLogLevelProvider } = await import("./logger");

    setLogLevelProvider(() => "info");
    info("[cloud][demeter] request done", { status: 200 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/INFO cloud\/demeter request done$/);
    expect(logSpy.mock.calls[0]?.[1]).toEqual({ status: 200 });
  });

  it("emits debug entries through console.log", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debug, setLogLevelProvider } = await import("./logger");

    setLogLevelProvider(() => "debug");
    debug("[test] visible debug", { enabled: true });

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/DEBUG test visible debug$/);
    expect(logSpy.mock.calls[0]?.[1]).toEqual({ enabled: true });
  });

  it("exports structured entries with scopes, message, context and raw args", async () => {
    const { info, exportLogEntries, setLogLevelProvider } = await import("./logger");
    setLogLevelProvider(() => "info");

    info("[cloud][demeter] request", { endpoint: "/demo" });

    const entries = exportLogEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      origin: "logger",
      level: "info",
      scopes: ["cloud", "demeter"],
      message: "request",
      context: { endpoint: "/demo" },
      rawArgs: ["[cloud][demeter] request", { endpoint: "/demo" }],
    });
  });

  it("resolves persisted debug level before hydration", async () => {
    localStorage.setItem("demeter-asr-settings", JSON.stringify({ debugConfidence: true }));

    const { resolveBootstrapLogLevel } = await import("./logger");

    expect(resolveBootstrapLogLevel({ hasHydrated: false, logLevel: "info" })).toBe("debug");

    localStorage.setItem("demeter-asr-settings", JSON.stringify({ logLevel: "warn" }));
    expect(resolveBootstrapLogLevel({ hasHydrated: false, logLevel: "info" })).toBe("warn");
    expect(resolveBootstrapLogLevel({ hasHydrated: true, logLevel: "error" })).toBe("error");
  });

  it("captures browser diagnostics and exports them in the bundle", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { debug, exportDiagnosticLogBundle, initializeLogCapture, setLogLevelProvider } = await import("./logger");

    setLogLevelProvider(() => "debug");
    initializeLogCapture();

    debug("[test] visible debug", { enabled: true });

    const errorEvent = new Event("error") as Event & {
      message?: string;
      error?: Error;
      filename?: string;
      lineno?: number;
      colno?: number;
    };
    Object.assign(errorEvent, {
      message: "window boom",
      error: new Error("window boom"),
      filename: "/runtime.js",
      lineno: 12,
      colno: 34,
    });
    window.dispatchEvent(errorEvent);

    const rejectionEvent = new Event("unhandledrejection");
    Object.defineProperty(rejectionEvent, "reason", {
      configurable: true,
      value: new Error("promise boom"),
    });
    window.dispatchEvent(rejectionEvent);

    const bundle = exportDiagnosticLogBundle({
      session: { status: "idle" },
      settings: { logLevel: "debug" },
      telemetry: null,
    });

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.logs.some((entry) => entry.origin === "logger" && entry.level === "debug")).toBe(true);
    expect(bundle.logs.some((entry) => entry.origin === "browser-error")).toBe(true);
    expect(bundle.logs.some((entry) => entry.origin === "unhandledrejection")).toBe(true);
    expect(bundle.diagnostics.sourceCounts).toMatchObject({
      logger: expect.any(Number),
      "browser-error": expect.any(Number),
      unhandledrejection: expect.any(Number),
    });
    expect(bundle.diagnostics.persistenceStatus).toBe("complete");
    expect(logSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("mirrors warn and error always, and info/debug only when enabled, into telemetry", async () => {
    const { info, debug, warn, error, setLogLevelProvider, setTelemetryProvider } = await import("./logger");
    const telemetry = { logEvent: vi.fn() };

    setLogLevelProvider(() => "info");
    setTelemetryProvider(() => telemetry as unknown as import("./telemetry").TelemetryCollector);

    info("[test] info");
    debug("[test] debug");
    warn("[test] warn");
    error("[test] error");

    expect(telemetry.logEvent).toHaveBeenCalledTimes(3);
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(1, "LOG_INFO", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(2, "LOG_WARN", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(3, "LOG_ERROR", expect.any(Object));
  });

  it("truncates long telemetry payload with head/tail preview", async () => {
    const { info, setTelemetryProvider, setLogLevelProvider } = await import("./logger");
    const telemetry = { logEvent: vi.fn() };
    const longText = "x".repeat(2000);

    setLogLevelProvider(() => "info");
    setTelemetryProvider(() => telemetry as unknown as import("./telemetry").TelemetryCollector);
    info(longText);

    const payload = telemetry.logEvent.mock.calls[0]?.[1] as {
      messagePreview?: string;
      messageTotalLength?: number;
      truncatedArgs?: number;
    };
    expect(payload.messageTotalLength).toBe(2000);
    expect(payload.truncatedArgs).toBe(1);
    expect(payload.messagePreview).toContain("[1488 chars omitted]");
    expect(payload.messagePreview?.startsWith("x".repeat(256))).toBe(true);
    expect(payload.messagePreview?.endsWith("x".repeat(256))).toBe(true);
  });

  it("keeps last 2000 entries in memory and spills older logs to cache", async () => {
    const { info, exportLogEntries, setLogLevelProvider } = await import("./logger");
    setLogLevelProvider(() => "error");

    for (let i = 0; i < 2005; i += 1) {
      info(`log ${i}`);
    }

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2005);
    expect(entries[0]?.message).toBe("log 0");
    expect(entries[entries.length - 1]?.message).toBe("log 2004");

    const cached = JSON.parse(localStorage.getItem(LOG_CACHE_KEY) ?? "[]") as Array<{ message?: string }>;
    expect(cached).toHaveLength(5);
    expect(cached[0]?.message).toBe("log 0");
    expect(cached[4]?.message).toBe("log 4");
  });

  it("keeps spilled logs in memory even when localStorage is unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);

    const { info, exportLogEntries, getLogCaptureDiagnostics, setLogLevelProvider } = await import("./logger");
    setLogLevelProvider(() => "error");

    for (let i = 0; i < 2005; i += 1) {
      info(`log ${i}`);
    }

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2005);
    expect(entries[0]?.message).toBe("log 0");
    expect(entries[entries.length - 1]?.message).toBe("log 2004");

    const diagnostics = getLogCaptureDiagnostics(entries);
    expect(diagnostics.persistenceStatus).toBe("memory-only");
    expect(diagnostics.totalEntries).toBe(2005);
  });

  it("exports cached legacy logs before in-memory logs and normalizes their shape", async () => {
    localStorage.setItem(
      LOG_CACHE_KEY,
      JSON.stringify([{ timestamp: "t0", level: "info", message: ["[legacy] cached", "{\"x\":1}"] }])
    );

    const { info, exportLogEntries, setLogLevelProvider } = await import("./logger");
    setLogLevelProvider(() => "info");
    info("[live] ready");

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      timestamp: "t0",
      level: "info",
      origin: "logger",
      scopes: ["legacy"],
      message: "cached",
      rawArgs: ["[legacy] cached", "{\"x\":1}"],
    });
    expect(entries[1]).toMatchObject({
      origin: "logger",
      scopes: ["live"],
      message: "ready",
    });
  });

  it("builds a telemetry summary from buffered logs", async () => {
    const { debug, exportLogsAsTelemetrySummary, setLogLevelProvider } = await import("./logger");
    setLogLevelProvider(() => "debug");

    debug("[cloud][demeter] prepared upload failed", { sizeBytes: 21313456 });

    const summary = exportLogsAsTelemetrySummary();
    expect(summary).not.toBeNull();
    expect(summary?.events).toHaveLength(1);
    expect(summary?.events[0]).toMatchObject({
      type: "LOG_DEBUG",
      data: expect.objectContaining({
        source: "logger",
        origin: "logger",
        scopes: ["cloud", "demeter"],
        message: "prepared upload failed",
      }),
    });
  });
});
