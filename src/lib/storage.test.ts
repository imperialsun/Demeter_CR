/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './storage';
import logger from '@/lib/logger';

vi.mock('@/lib/logger', () => ({
  default: { warn: vi.fn() },
}));

describe('storage', () => {
  const storageKey = 'demeter-asr-settings';
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
    Object.defineProperty(window, 'localStorage', {
      value: localStorageMock,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalLocalStorage) {
      Object.defineProperty(window, 'localStorage', {
        value: originalLocalStorage,
        configurable: true,
      });
    }
    vi.clearAllMocks();
  });

  it('returns null when no settings are stored', () => {
    expect(loadSettings()).toBeNull();
  });

  it('loads persisted settings when present', () => {
    const payload = { ...DEFAULT_SETTINGS, activePreset: 'balanced', micMinSilenceMs: 123 };
    window.localStorage.setItem(storageKey, JSON.stringify(payload));

    const loaded = loadSettings();
    expect(loaded?.activePreset).toBe('balanced');
    expect(loaded?.micMinSilenceMs).toBe(123);
  });

  it('logs and returns null on invalid JSON', () => {
    window.localStorage.setItem(storageKey, '{bad-json');
    const loaded = loadSettings();
    expect(loaded).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('saves settings to localStorage', () => {
    saveSettings(DEFAULT_SETTINGS);
    expect(window.localStorage.setItem).toHaveBeenCalledTimes(1);
    const [key, value] = (window.localStorage.setItem as any).mock.calls[0];
    expect(key).toBe(storageKey);
    expect(JSON.parse(value)).toMatchObject({
      activePreset: DEFAULT_SETTINGS.activePreset,
      micMinChunkMs: DEFAULT_SETTINGS.micMinChunkMs,
    });
  });

  it('defines provider-specific llm pipeline defaults', () => {
    expect(DEFAULT_SETTINGS.llmApiHfModelId).toBeTruthy();
    expect(DEFAULT_SETTINGS.llmApiHfMaxTokens).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.llmApiMistralModelId).toBeTruthy();
    expect(DEFAULT_SETTINGS.llmApiMistralMaxTokens).toBeGreaterThan(0);
  });

  it("defines llm local defaults", () => {
    expect(DEFAULT_SETTINGS.llmLocalModelProfile).toBe("qwen_1_7b");
    expect(DEFAULT_SETTINGS.llmLocalModelId).toContain("Qwen3-1.7B");
    expect(DEFAULT_SETTINGS.llmLocalMaxTokens).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.llmLocalSettingsByProfile?.qwen_1_7b.modelId).toContain("Qwen3-1.7B");
    expect(DEFAULT_SETTINGS.llmLocalSettingsByProfile?.ministral_3_3b.modelId).toContain("Ministral-3-3B");
  });
});
