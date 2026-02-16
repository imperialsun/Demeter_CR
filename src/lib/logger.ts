// Lightweight logger that defers the "debugEnabled" decision to a runtime provider.
// This avoids importing the Zustand store here and causing circular imports or dynamic-import churn.
import type { TelemetryCollector } from "@/lib/telemetry";

let debugProvider: (() => boolean) | null = null;
const LOG_BUFFER_LIMIT = 2000;
const LOG_CACHE_KEY = "demeter-log-cache";
const TELEMETRY_PREVIEW_HEAD = 256;
const TELEMETRY_PREVIEW_TAIL = 256;
const TELEMETRY_MAX_ARGS = 6;
let telemetryProvider: (() => TelemetryCollector | null) | null = null;

export type ConsoleVisibilityPolicy = "always" | "debug-gated" | "warn-error-only";
let consoleVisibilityPolicy: ConsoleVisibilityPolicy = "debug-gated";

type LogEntry = {
  timestamp: string;
  level: "info" | "debug" | "warn" | "error";
  message: string[];
};
type LogLevel = LogEntry["level"];

const logBuffer: LogEntry[] = [];
let cachedLogsMemo: LogEntry[] | null = null;
let cachePending: LogEntry[] = [];
let cacheFlushScheduled = false;

export function setDebugProvider(provider: () => boolean) {
  debugProvider = provider;
}

export function setTelemetryProvider(provider: (() => TelemetryCollector | null) | null) {
  telemetryProvider = provider;
}

export function setConsoleVisibilityPolicy(policy: ConsoleVisibilityPolicy) {
  consoleVisibilityPolicy = policy;
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
    (method: keyof typeof baseConsole, level: LogLevel) =>
    (...args: unknown[]) => {
      if (shouldEmitConsole(level)) {
        baseConsole[method](...args);
      }
    };

  console.log = guarded("log", "info");
  console.info = guarded("info", "info");
  console.debug = guarded("debug", "debug");
  console.warn = guarded("warn", "warn");
  console.error = guarded("error", "error");
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

function shouldEmitConsole(level: LogLevel): boolean {
  if (consoleVisibilityPolicy === "always") return true;
  if (consoleVisibilityPolicy === "warn-error-only") {
    if (level === "warn" || level === "error") return true;
    return enabled();
  }
  if (level === "error") return true;
  return enabled();
}

function truncateForTelemetry(value: string): { preview: string; totalLength: number; truncated: boolean } {
  if (value.length <= TELEMETRY_PREVIEW_HEAD + TELEMETRY_PREVIEW_TAIL) {
    return {
      preview: value,
      totalLength: value.length,
      truncated: false,
    };
  }

  const omittedChars = value.length - TELEMETRY_PREVIEW_HEAD - TELEMETRY_PREVIEW_TAIL;
  return {
    preview: `${value.slice(0, TELEMETRY_PREVIEW_HEAD)}...[${omittedChars} chars omitted]...${value.slice(
      -TELEMETRY_PREVIEW_TAIL
    )}`,
    totalLength: value.length,
    truncated: true,
  };
}

function emitTelemetry(level: LogLevel, args: unknown[]) {
  if (!telemetryProvider) return;
  let telemetry: TelemetryCollector | null = null;
  try {
    telemetry = telemetryProvider();
  } catch {
    telemetry = null;
  }
  if (!telemetry) return;

  try {
    const eventType =
      level === "error"
        ? "LOG_ERROR"
        : level === "warn"
          ? "LOG_WARN"
          : level === "debug"
            ? "LOG_DEBUG"
            : "LOG_INFO";

    const formattedArgs = args.map(formatArg);
    const previews = formattedArgs.slice(0, TELEMETRY_MAX_ARGS).map(truncateForTelemetry);
    const first = previews[0];

    telemetry.logEvent(eventType, {
      level,
      argCount: args.length,
      truncatedArgs: previews.filter((item) => item.truncated).length,
      omittedArgs: Math.max(0, args.length - TELEMETRY_MAX_ARGS),
      messagePreview: first?.preview,
      messageTotalLength: first?.totalLength ?? 0,
      argsPreview: previews.map((item) => item.preview),
      argsTotalLength: previews.map((item) => item.totalLength),
      hasTelemetryPreview: true,
    });
  } catch {
    // avoid logging loops on telemetry failures
  }
}

export function exportLogEntries() {
  // Ensure any scheduled cache spill is persisted before exporting.
  flushCachedLogs();
  return [...ensureCachedMemoLoaded(), ...logBuffer];
}

export function info(...args: unknown[]) {
  pushLog("info", args);
  emitTelemetry("info", args);
  if (shouldEmitConsole("info")) console.info(...args);
}

export function debug(...args: unknown[]) {
  pushLog("debug", args);
  emitTelemetry("debug", args);
  if (shouldEmitConsole("debug")) console.debug(...args);
}

export function warn(...args: unknown[]) {
  pushLog("warn", args);
  emitTelemetry("warn", args);
  if (shouldEmitConsole("warn")) console.warn(...args);
}

export function error(...args: unknown[]) {
  pushLog("error", args);
  emitTelemetry("error", args);
  if (shouldEmitConsole("error")) console.error(...args);
}

export default {
  info,
  debug,
  warn,
  error,
  setConsoleVisibilityPolicy,
  setTelemetryProvider,
};
