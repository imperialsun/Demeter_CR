import { randomUUID } from "node:crypto";

declare global {
  var __demeterNativeFetch: typeof fetch | undefined;
}

globalThis.__demeterNativeFetch ??= globalThis.fetch.bind(globalThis);

const makeStorage = () => {
  const store = new Map<string, string>();
  return {
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
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
};

Object.defineProperty(window, "localStorage", {
  value: makeStorage(),
  configurable: true,
});

Object.defineProperty(window, "sessionStorage", {
  value: makeStorage(),
  configurable: true,
});

if (typeof globalThis.crypto !== "undefined") {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: () => randomUUID(),
    configurable: true,
  });
}
