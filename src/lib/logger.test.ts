/* @vitest-environment jsdom */
import { describe, it, expect, beforeEach, vi } from "vitest";

const LOG_CACHE_KEY = "demeter-log-cache";

describe("logger", () => {
  beforeEach(() => {
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

    const { info, exportLogEntries, setDebugProvider } = await import("./logger");
    setDebugProvider(() => false);
    info("live");

    const entries = exportLogEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.message[0]).toBe("cached");
    expect(entries[1]?.message[0]).toBe("live");
  });
});
