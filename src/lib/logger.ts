import { getTransformersVersion, type TelemetryCollector, type TelemetryEvent, type TelemetrySummary } from "@/lib/telemetry";

const LOG_BUFFER_LIMIT = 2000;
const LOG_CACHE_KEY = "demeter-log-cache";
const TELEMETRY_PREVIEW_HEAD = 256;
const TELEMETRY_PREVIEW_TAIL = 256;
const TELEMETRY_MAX_ARGS = 6;

export type LogLevel = "error" | "warn" | "info" | "debug";

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  scopes: string[];
  message: string;
  context?: unknown;
  rawArgs: unknown[];
};

type LegacyLogEntry = {
  timestamp?: unknown;
  level?: unknown;
  message?: unknown;
  scopes?: unknown;
  context?: unknown;
  rawArgs?: unknown;
};

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const nativeConsole = {
  debug: console.debug.bind(console),
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

let logLevelProvider: (() => LogLevel) | null = null;
let telemetryProvider: (() => TelemetryCollector | null) | null = null;

const logBuffer: LogEntry[] = [];
let cachedLogsMemo: LogEntry[] | null = null;
let cachePending: LogEntry[] = [];
let cacheFlushScheduled = false;

export function setLogLevelProvider(provider: () => LogLevel) {
  logLevelProvider = provider;
}

export function setTelemetryProvider(provider: (() => TelemetryCollector | null) | null) {
  telemetryProvider = provider;
}

export function getCurrentLogLevel(): LogLevel {
  try {
    const value = logLevelProvider?.();
    if (value && value in LOG_LEVEL_ORDER) {
      return value;
    }
  } catch {
    // ignore provider failures and fall back to info
  }
  return "info";
}

export function isLevelEnabled(level: LogLevel) {
  return LOG_LEVEL_ORDER[level] <= LOG_LEVEL_ORDER[getCurrentLogLevel()];
}

function safeStringify(value: unknown) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") return val.toString();
    if (val instanceof Error) {
      return {
        name: val.name,
        message: val.message,
        stack: val.stack,
      };
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

function normalizeForStorage(value: unknown): unknown {
  if (typeof value === "undefined") return "undefined";
  const json = safeStringify(value);
  if (typeof json !== "string") {
    return String(value);
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return json;
  }
}

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  const json = safeStringify(value);
  if (typeof json === "string") return json;
  if (typeof value === "undefined") return "undefined";
  return String(value);
}

function isLogLevel(value: unknown): value is LogLevel {
  return value === "error" || value === "warn" || value === "info" || value === "debug";
}

function parseScopesAndMessage(input: string): { scopes: string[]; message: string } {
  const scopes: string[] = [];
  let remaining = input.trim();

  while (remaining.startsWith("[")) {
    const closingIndex = remaining.indexOf("]");
    if (closingIndex <= 1) break;
    const scope = remaining.slice(1, closingIndex).trim();
    if (!scope) break;
    scopes.push(scope);
    remaining = remaining.slice(closingIndex + 1).trimStart();
  }

  return {
    scopes,
    message: remaining || input.trim(),
  };
}

function buildLogEntry(level: LogLevel, args: unknown[]): LogEntry {
  const normalizedArgs = args.map(normalizeForStorage);
  const first = args[0];
  const firstString = typeof first === "string" ? first : formatArg(first);
  const parsed = parseScopesAndMessage(firstString);
  const contextSource =
    args.length <= 1
      ? undefined
      : args.length === 2
        ? normalizeForStorage(args[1])
        : args.slice(1).map(normalizeForStorage);

  return {
    timestamp: new Date().toISOString(),
    level,
    scopes: parsed.scopes,
    message: parsed.message || firstString,
    context: contextSource,
    rawArgs: normalizedArgs,
  };
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

function normalizeLegacyLogEntry(value: LegacyLogEntry): LogEntry | null {
  const level = isLogLevel(value.level) ? value.level : "info";
  const timestamp = typeof value.timestamp === "string" ? value.timestamp : new Date().toISOString();
  const rawArgs = Array.isArray(value.rawArgs)
    ? value.rawArgs.map(normalizeForStorage)
    : Array.isArray(value.message)
      ? value.message.map(normalizeForStorage)
      : typeof value.message === "string"
        ? [value.message]
        : [];
  const firstArg = rawArgs[0];
  const parsed =
    typeof firstArg === "string"
      ? parseScopesAndMessage(firstArg)
      : { scopes: Array.isArray(value.scopes) ? value.scopes.filter((item): item is string => typeof item === "string") : [], message: formatArg(firstArg) };
  const context =
    value.context !== undefined
      ? normalizeForStorage(value.context)
      : rawArgs.length > 1
        ? rawArgs.slice(1)
        : undefined;

  if (!parsed.message && !rawArgs.length) {
    return null;
  }

  return {
    timestamp,
    level,
    scopes: parsed.scopes,
    message: parsed.message || String(firstArg ?? ""),
    context,
    rawArgs,
  };
}

function loadCachedLogs(): LogEntry[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LOG_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => normalizeLegacyLogEntry((entry ?? {}) as LegacyLogEntry))
      .filter((entry): entry is LogEntry => Boolean(entry));
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
    // ignore cache write failures
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
  if (!storage || !entries.length) return;
  try {
    const memo = ensureCachedMemoLoaded();
    memo.push(...entries);
    cachePending.push(...entries);
    scheduleCacheFlush();
  } catch {
    // ignore cache write failures
  }
}

function pushLogEntry(entry: LogEntry) {
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    const overflow = logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
    appendCachedLogs(overflow);
  }
}

function formatConsoleTimestamp(timestamp: string) {
  return timestamp.slice(11, 23);
}

function formatConsoleLine(entry: LogEntry) {
  const scopeSuffix = entry.scopes.length > 0 ? ` ${entry.scopes.join("/")}` : "";
  return `${formatConsoleTimestamp(entry.timestamp)} ${entry.level.toUpperCase()}${scopeSuffix} ${entry.message}`.trim();
}

function emitConsole(entry: LogEntry) {
  if (!isLevelEnabled(entry.level)) return;
  const line = formatConsoleLine(entry);

  if (entry.level === "error") {
    if (typeof entry.context !== "undefined") {
      nativeConsole.error(line, entry.context);
      return;
    }
    nativeConsole.error(line);
    return;
  }

  if (entry.level === "warn") {
    if (typeof entry.context !== "undefined") {
      nativeConsole.warn(line, entry.context);
      return;
    }
    nativeConsole.warn(line);
    return;
  }

  if (entry.level === "debug") {
    if (typeof entry.context !== "undefined") {
      nativeConsole.debug(line, entry.context);
      return;
    }
    nativeConsole.debug(line);
    return;
  }

  if (typeof entry.context !== "undefined") {
    nativeConsole.log(line, entry.context);
    return;
  }
  nativeConsole.log(line);
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

function shouldEmitTelemetry(level: LogLevel) {
  if (level === "warn" || level === "error") return true;
  return isLevelEnabled(level);
}

function emitTelemetry(entry: LogEntry) {
  if (!shouldEmitTelemetry(entry.level) || !telemetryProvider) return;

  let telemetry: TelemetryCollector | null;
  try {
    telemetry = telemetryProvider();
  } catch {
    return;
  }
  if (!telemetry) return;

  try {
    const eventType =
      entry.level === "error"
        ? "LOG_ERROR"
        : entry.level === "warn"
          ? "LOG_WARN"
          : entry.level === "debug"
            ? "LOG_DEBUG"
            : "LOG_INFO";
    const previews = entry.rawArgs.slice(0, TELEMETRY_MAX_ARGS).map((arg) => truncateForTelemetry(formatArg(arg)));
    const first = previews[0];

    telemetry.logEvent(eventType, {
      level: entry.level,
      scopes: entry.scopes,
      message: entry.message,
      argCount: entry.rawArgs.length,
      truncatedArgs: previews.filter((item) => item.truncated).length,
      omittedArgs: Math.max(0, entry.rawArgs.length - TELEMETRY_MAX_ARGS),
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

function log(level: LogLevel, args: unknown[]) {
  const entry = buildLogEntry(level, args);
  pushLogEntry(entry);
  emitTelemetry(entry);
  emitConsole(entry);
}

export function exportLogEntries() {
  flushCachedLogs();
  return [...ensureCachedMemoLoaded(), ...logBuffer];
}

function resolveTelemetryEventType(level: LogLevel): TelemetryEvent["type"] {
  if (level === "error") return "LOG_ERROR";
  if (level === "warn") return "LOG_WARN";
  if (level === "debug") return "LOG_DEBUG";
  return "LOG_INFO";
}

function parseLogTimestampMs(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

export function exportLogsAsTelemetrySummary(): TelemetrySummary | null {
  const entries = exportLogEntries();
  if (!entries.length) return null;

  const parsedTimes = entries.map((entry) => parseLogTimestampMs(entry.timestamp)).filter((value): value is number => value !== null);
  const baselineMs = parsedTimes[0] ?? Date.now();
  const createdAt = new Date(baselineMs).toISOString();
  const events: TelemetryEvent[] = entries.map((entry, index) => {
    const parsedMs = parseLogTimestampMs(entry.timestamp);
    const relativeTimestamp = parsedMs === null ? index : Math.max(0, parsedMs - baselineMs);
    return {
      type: resolveTelemetryEventType(entry.level),
      timestamp: relativeTimestamp,
      data: {
        source: "logger",
        level: entry.level,
        scopes: entry.scopes,
        message: entry.message,
        context: entry.context,
        loggedAt: entry.timestamp,
      },
    };
  });

  return {
    sessionId: `logger-buffer-${baselineMs}`,
    createdAt,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
    transformersVersion: getTransformersVersion(),
    backend: "logger",
    modelId: "front-logger",
    timings: {},
    chunks: [],
    events,
    memorySnapshots: [],
    alerts: {},
    droppedEvents: 0,
  };
}

export function info(...args: unknown[]) {
  log("info", args);
}

export function debug(...args: unknown[]) {
  log("debug", args);
}

export function warn(...args: unknown[]) {
  log("warn", args);
}

export function error(...args: unknown[]) {
  log("error", args);
}

export default {
  info,
  debug,
  warn,
  error,
  isLevelEnabled,
  setTelemetryProvider,
};
