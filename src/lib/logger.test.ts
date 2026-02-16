/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";

const originalConsole = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  debug: console.debug,
  error: console.error,
};

const LOG_CACHE_KEY = "demeter-log-cache";

describe("logger", () => {
  beforeEach(() => {
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.debug = originalConsole.debug;
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

  it("suppresses console output when debug is disabled but always logs errors", async () => {
    const { installConsoleGuard, setDebugProvider } = await import("./logger");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setDebugProvider(() => false);
    installConsoleGuard();

    console.info("info");
    console.warn("warn");
    console.debug("debug");
    console.error("error");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(debugSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("allows console output when debug is enabled", async () => {
    const { installConsoleGuard, setDebugProvider } = await import("./logger");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    setDebugProvider(() => true);
    installConsoleGuard();

    console.info("visible");
    expect(infoSpy).toHaveBeenCalled();
  });

  it("supports warn-error-only visibility policy", async () => {
    const { installConsoleGuard, setConsoleVisibilityPolicy, setDebugProvider } = await import("./logger");
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    setDebugProvider(() => false);
    setConsoleVisibilityPolicy("warn-error-only");
    installConsoleGuard();

    console.info("hidden-info");
    console.warn("visible-warn");
    console.error("visible-error");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("mirrors logger entries into telemetry events", async () => {
    const {
      info,
      debug,
      warn,
      error,
      setDebugProvider,
      setTelemetryProvider,
      setConsoleVisibilityPolicy,
    } = await import("./logger");
    const telemetry = { logEvent: vi.fn() };

    setDebugProvider(() => false);
    setConsoleVisibilityPolicy("warn-error-only");
    setTelemetryProvider(() => telemetry as unknown as import("./telemetry").TelemetryCollector);

    info("[test] info");
    debug("[test] debug");
    warn("[test] warn");
    error("[test] error");

    expect(telemetry.logEvent).toHaveBeenCalledTimes(4);
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(1, "LOG_INFO", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(2, "LOG_DEBUG", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(3, "LOG_WARN", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenNthCalledWith(4, "LOG_ERROR", expect.any(Object));
  });

  it("truncates long telemetry payload with head/tail preview", async () => {
    const { info, setTelemetryProvider, setDebugProvider } = await import("./logger");
    const telemetry = { logEvent: vi.fn() };
    const longText = "x".repeat(2000);

    setDebugProvider(() => false);
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
    const { info, exportLogEntries, setDebugProvider } = await import("./logger");
    setDebugProvider(() => false);
    for (let i = 0; i < 2005; i += 1) {
      info(`log ${i}`);
    }

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2005);
    expect(entries[0]?.message[0]).toBe("log 0");
    expect(entries[entries.length - 1]?.message[0]).toBe("log 2004");

    const cached = JSON.parse(localStorage.getItem(LOG_CACHE_KEY) ?? "[]") as Array<{ message?: string[] }>;
    expect(cached).toHaveLength(5);
    expect(cached[0]?.message?.[0]).toBe("log 0");
    expect(cached[4]?.message?.[0]).toBe("log 4");
  });

  it("exports cached logs before in-memory logs", async () => {
    localStorage.setItem(
      LOG_CACHE_KEY,
      JSON.stringify([{ timestamp: "t0", level: "info", message: ["cached"] }])
    );

    const { info, exportLogEntries, setDebugProvider, setTelemetryProvider } = await import("./logger");
    setDebugProvider(() => false);
    setTelemetryProvider(null);
    info("live");

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.message[0]).toBe("cached");
    expect(entries[1]?.message[0]).toBe("live");
  });
});
