import { useAsrStore } from "@/store/asr-store";

const IS_PROD = process.env.NODE_ENV === "production";

function enabled() {
  if (IS_PROD) return false;
  try {
    return Boolean(useAsrStore.getState().debugConfidence);
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
