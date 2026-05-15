/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import '@testing-library/jest-dom';
import { afterEach } from "vitest";

// Global mocks and helpers for Vitest + Testing Library

const testProcess = (globalThis as any).process;
if (typeof testProcess?.emitWarning === 'function') {
  const emitWarning = testProcess.emitWarning.bind(testProcess);
  testProcess.emitWarning = (warning: unknown, ...args: unknown[]) => {
    const message = typeof warning === 'string' ? warning : String((warning as Error | undefined)?.message ?? '');
    if (message.includes('--localstorage-file')) {
      return;
    }
    return emitWarning(warning, ...args);
  };
}

// Mock crypto.randomUUID for test environments if missing
if (typeof (globalThis as any).crypto === 'undefined') {
  (globalThis as any).crypto = { randomUUID: () => 'test-uuid' };
} else if (typeof (globalThis as any).crypto.randomUUID !== 'function') {
  (globalThis as any).crypto.randomUUID = () => 'test-uuid';
}

// Polyfill URL.createObjectURL/revokeObjectURL used by AudioPlayer and other components
if (typeof (URL as any).createObjectURL !== 'function') {
  (URL as any).createObjectURL = (_: any) => 'blob://test';
}
if (typeof (URL as any).revokeObjectURL !== 'function') {
  (URL as any).revokeObjectURL = (_: any) => {};
}

if (typeof HTMLMediaElement !== 'undefined') {
  Object.defineProperty(HTMLMediaElement.prototype, 'load', {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value: () => {},
  });
}

// Radix Select relies on scrollIntoView in jsdom test env.
if (typeof (Element as any) !== 'undefined' && typeof (Element as any).prototype.scrollIntoView !== 'function') {
  (Element as any).prototype.scrollIntoView = () => {};
}

// ThemeProvider reads the system preference through matchMedia.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  (window as any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

// Simple localStorage/sessionStorage polyfill for test envs
function createStorageMock(): Storage {
  const store = new Map<string, string>();

  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store.clear();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

if (typeof window !== 'undefined') {
  if (typeof window.localStorage?.getItem !== 'function') {
    (window as any).localStorage = createStorageMock();
  }
  if (typeof window.sessionStorage?.getItem !== 'function') {
    (window as any).sessionStorage = createStorageMock();
  }
}

afterEach(() => {
  if (typeof window !== "undefined" && typeof window.sessionStorage?.clear === "function") {
    window.sessionStorage.clear();
  }
});
