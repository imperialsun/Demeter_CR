// Lightweight logger that defers the "debugEnabled" decision to a runtime provider.
// This avoids importing the Zustand store here and causing circular imports or dynamic-import churn.

const IS_PROD = process.env.NODE_ENV === "production";

let debugProvider: (() => boolean) | null = null;

export function setDebugProvider(provider: () => boolean) {
  debugProvider = provider;
}

function enabled() {
  if (IS_PROD) return false;
  try {
    return Boolean(debugProvider ? debugProvider() : false);
  } catch {
    return false;
  }
}

export function info(...args: unknown[]) {
  if (enabled()) console.info(...args);
}

export function debug(...args: unknown[]) {
  if (enabled()) console.debug(...args);
}

export function warn(...args: unknown[]) {
  if (enabled()) console.warn(...args);
}

export function error(...args: unknown[]) {
  if (enabled()) console.error(...args);
}

export default {
  info,
  debug,
  warn,
  error,
};
