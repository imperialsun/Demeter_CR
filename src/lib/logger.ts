// Lightweight logger that defers the "debugEnabled" decision to a runtime provider.
// This avoids importing the Zustand store here and causing circular imports or dynamic-import churn.

let debugProvider: (() => boolean) | null = null;
const LOG_BUFFER_LIMIT = 2000;
const LOG_CACHE_KEY = "demeter-log-cache";

type LogEntry = {
  timestamp: string;
  level: "info" | "debug" | "warn" | "error";
  message: string[];
};

const logBuffer: LogEntry[] = [];
let cachedLogsMemo: LogEntry[] | null = null;
let cachePending: LogEntry[] = [];
let cacheFlushScheduled = false;

export function setDebugProvider(provider: () => boolean) {
  debugProvider = provider;
}

function enabled() {
  // Allow the runtime provider to enable debug logging even in production.
  // Behavior:
  // - If a provider is configured, its truthiness determines whether logs are enabled.
  // - If no provider is configured, logs are disabled by default.
  try {
    if (typeof debugProvider === 'function') {
      return Boolean(debugProvider());
    }
    return false;
  } catch {
    return false;
  }
}

let consoleGuardInstalled = false;

export function installConsoleGuard() {
  if (consoleGuardInstalled) return;
  consoleGuardInstalled = true;

  const baseConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  const guarded =
    (method: keyof typeof baseConsole, always = false) =>
    (...args: unknown[]) => {
      if (always || enabled()) {
        baseConsole[method](...args);
      }
    };

  console.log = guarded("log");
  console.info = guarded("info");
  console.debug = guarded("debug");
  console.warn = guarded("warn");
  console.error = guarded("error", true);
}

function safeStringify(value: unknown) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val instanceof Error) {
      return { name: val.name, message: val.message, stack: val.stack };
    }
    if (typeof val === "function") {
      return `[Function ${val.name || "anonymous"}]`;
    }
    if (typeof val === "symbol") {
      return val.toString();
    }
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

function formatArg(arg: unknown) {
  if (typeof arg === "string") return arg;
  const json = safeStringify(arg);
  if (typeof json === "string") return json;
  if (typeof arg === "undefined") return "undefined";
  return String(arg);
}

function getStorage(): Storage | null {
  if (typeof globalThis !== "undefined" && "localStorage" in globalThis && globalThis.localStorage) {
    return globalThis.localStorage;
  }
  if (typeof window !== "undefined" && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== "undefined") {
    return localStorage;
  }
  return null;
}

function loadCachedLogs(): LogEntry[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOG_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LogEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureCachedMemoLoaded() {
  if (cachedLogsMemo) return cachedLogsMemo;
  cachedLogsMemo = loadCachedLogs();
  return cachedLogsMemo;
}

function flushCachedLogs() {
  const storage = getStorage();
  if (!storage) return;
  if (!cachedLogsMemo) return;
  if (!cachePending.length) return;
  try {
    storage.setItem(LOG_CACHE_KEY, JSON.stringify(cachedLogsMemo));
  } catch {
    // ignore cache write failures (e.g. storage quota)
  } finally {
    cachePending = [];
    cacheFlushScheduled = false;
  }
}

function scheduleCacheFlush() {
  if (cacheFlushScheduled) return;
  cacheFlushScheduled = true;
  try {
    if (typeof queueMicrotask === "function") {
      queueMicrotask(() => flushCachedLogs());
      return;
    }
  } catch {
    // ignore
  }
  try {
    if (typeof setTimeout === "function") {
      setTimeout(() => flushCachedLogs(), 0);
    }
  } catch {
    // ignore
  }
}

function appendCachedLogs(entries: LogEntry[]) {
  const storage = getStorage();
  if (!storage) return;
  if (!entries.length) return;
  try {
    const memo = ensureCachedMemoLoaded();
    memo.push(...entries);
    cachePending.push(...entries);
    scheduleCacheFlush();
  } catch {
    // ignore cache write failures (e.g. storage quota)
  }
}

function pushLog(level: LogEntry["level"], args: unknown[]) {
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level,
    message: args.map(formatArg),
  });
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    const overflow = logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
    appendCachedLogs(overflow);
  }
}

export function exportLogEntries() {
  // Ensure any scheduled cache spill is persisted before exporting.
  flushCachedLogs();
  return [...ensureCachedMemoLoaded(), ...logBuffer];
}

export function info(...args: unknown[]) {
  pushLog("info", args);
  if (enabled()) console.info(...args);
}

export function debug(...args: unknown[]) {
  pushLog("debug", args);
  if (enabled()) console.debug(...args);
}

export function warn(...args: unknown[]) {
  pushLog("warn", args);
  if (enabled()) console.warn(...args);
}

export function error(...args: unknown[]) {
  pushLog("error", args);
  console.error(...args);
}

export default {
  info,
  debug,
  warn,
  error,
};
