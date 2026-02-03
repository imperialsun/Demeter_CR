import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { useAsrStore } from "./asr-store";
import { DEFAULT_SETTINGS } from "@/lib/storage";

describe("asr-store persistence", () => {
  const storageKey = "demeter-asr-settings";
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    originalLocalStorage = window.localStorage;
    const store: Record<string, string> = {};
    const localStorageMock = {
      getItem: vi.fn((key: string) => (key in store ? store[key]! : null)),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        Object.keys(store).forEach((key) => delete store[key]);
      }),
      key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
      get length() {
        return Object.keys(store).length;
      },
    };
    Object.defineProperty(window, "localStorage", {
      value: localStorageMock,
      configurable: true,
    });
    useAsrStore.setState({ blockedPresets: [], hasHydrated: false });
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, "localStorage", {
        value: originalLocalStorage,
        configurable: true,
      });
    }
    useAsrStore.setState({ blockedPresets: [] });
  });

  it("hydrates blocked presets from storage", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      blockedPresets: ["fast", "quality", "custom"],
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));

    useAsrStore.getState().hydrateFromStorage();

    expect(useAsrStore.getState().blockedPresets).toEqual(["fast", "quality"]);
  });

  it("persists blocked presets on change", () => {
    useAsrStore.setState({ hasHydrated: true });
    useAsrStore.getState().setBlockedPresets(["medium"]);

    const stored = window.localStorage.getItem(storageKey);
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored as string);
    expect(parsed.blockedPresets).toEqual(["medium"]);
  });

  it("does not persist before hydration", () => {
    const payload = {
      ...DEFAULT_SETTINGS,
      activePreset: "balanced",
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));

    useAsrStore.getState().setBlockedPresets(["medium"]);

    expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify(payload));
  });

  it("adjusts backend preference when stored value is unsupported", () => {
    useAsrStore.setState({ webGpuSupported: false, wasmAvailable: true });
    const payload = {
      ...DEFAULT_SETTINGS,
      backendPreference: "webgpu",
      micBackendPreference: "webgpu",
    };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));

    useAsrStore.getState().hydrateFromStorage();

    expect(useAsrStore.getState().backendPreference).toBe("wasm");
    expect(useAsrStore.getState().micBackendPreference).toBe("wasm");
  });
});
