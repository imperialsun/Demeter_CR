// Lightweight logger that defers the "debugEnabled" decision to a runtime provider.
// This avoids importing the Zustand store here and causing circular imports or dynamic-import churn.

const IS_PROD = process.env.NODE_ENV === "production";

let debugProvider: (() => boolean) | null = null;

export function setDebugProvider(provider: () => boolean) {
  debugProvider = provider;
}

function enabled() {
  // Allow the runtime provider to enable debug logging even in production.
  // Behavior:
  // - If a provider is configured, its truthiness determines whether logs are enabled.
  // - If no provider is configured, logs are enabled in non-prod environments only.
  try {
    if (typeof debugProvider === 'function') {
      return Boolean(debugProvider());
    }
    return !IS_PROD;
  } catch {
    return !IS_PROD;
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
