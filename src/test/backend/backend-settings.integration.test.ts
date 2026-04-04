import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendUser, getUserAccess, updateUserEntitlements } from "./adminClient";
import { createAppCookieJar, configureBackendRuntime, resetBrowserState } from "./runtime";

describe("backend settings integration", () => {
  beforeEach(() => {
    resetBrowserState();
  });

  it("syncs settings for a real backend user", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const runtimeModule = await import("@/lib/runtime-config");
      const authModule = await import("@/lib/backend-auth");
      const settingsModule = await import("@/lib/backend-settings-sync");

      expect(runtimeModule.isBackendMode()).toBe(true);
      await authModule.backendLogin(user.email, user.password);

      const initialEnvelope = await settingsModule.pullBackendSettings();
      expect(initialEnvelope?.settings).toEqual({});

      vi.useFakeTimers();
      try {
        settingsModule.queueBackendSettingsSync({
          cloudMaxTokens: 2048,
          showSegments: true,
          activePreset: "balanced",
        });

        await vi.advanceTimersByTimeAsync(1_001);
      } finally {
        vi.useRealTimers();
      }

      const updatedEnvelope = await settingsModule.pullBackendSettings();
      expect(updatedEnvelope?.settings).toMatchObject({
        cloudMaxTokens: 2048,
        showSegments: true,
        activePreset: "balanced",
      });
      expect(updatedEnvelope?.version).toBeGreaterThanOrEqual(1);
    } finally {
      restoreFetch();
    }
  });

  it("backfills a full canonical settings document after mutating an initially empty backend profile", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const authModule = await import("@/lib/backend-auth");
      const settingsModule = await import("@/lib/backend-settings-sync");
      const storageModule = await import("@/lib/storage");
      const storeModule = await import("@/store/asr-store");

      await authModule.backendLogin(user.email, user.password);

      const initialEnvelope = await settingsModule.pullBackendSettings();
      expect(initialEnvelope?.settings).toEqual({});

      storageModule.replaceSettingsCacheFromBackend(initialEnvelope?.settings ?? {});
      storeModule.useAsrStore.getState().hydrateFromStorage();

      expect(storeModule.useAsrStore.getState().memoryMode).toBe(storageModule.DEFAULT_SETTINGS.memoryMode);
      expect(storeModule.useAsrStore.getState().chunkStrategy).toBe(storageModule.DEFAULT_SETTINGS.chunkStrategy);

      vi.useFakeTimers();
      try {
        storeModule.useAsrStore.getState().setShowSegments(false);
        await vi.advanceTimersByTimeAsync(1_001);
      } finally {
        vi.useRealTimers();
      }

      const updatedEnvelope = await settingsModule.pullBackendSettings();
      expect(updatedEnvelope?.settings).toMatchObject({
        showSegments: false,
        memoryMode: storageModule.DEFAULT_SETTINGS.memoryMode,
        chunkStrategy: storageModule.DEFAULT_SETTINGS.chunkStrategy,
        segmentationMode: storageModule.DEFAULT_SETTINGS.segmentationMode,
        autoTunePreprocess: storageModule.DEFAULT_SETTINGS.autoTunePreprocess,
        llmApiProvider: storageModule.DEFAULT_SETTINGS.llmApiProvider,
      });
      expect(Object.keys(updatedEnvelope?.settings ?? {}).length).toBe(storageModule.PERSISTED_SETTINGS_KEYS.length);
      expect(updatedEnvelope?.settings.debugConfidence).toBeUndefined();
      expect(updatedEnvelope?.settings.llmApiModelId).toBeUndefined();
    } finally {
      restoreFetch();
    }
  });

  it("reflects backend permission denies and returns null on forbidden settings pull", async () => {
    const user = await createBackendUser();
    await updateUserEntitlements(user.id, [
      { permissionCode: "feature.settings", effect: "deny" },
    ]);
    const access = await getUserAccess(user.id);
    expect(access.effectivePermissions).not.toContain("feature.settings");

    vi.resetModules();
    await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const runtimeModule = await import("@/lib/runtime-config");
      const authModule = await import("@/lib/backend-auth");
      const settingsModule = await import("@/lib/backend-settings-sync");
      const permissionsModule = await import("@/lib/backend-permissions");

      expect(runtimeModule.isBackendMode()).toBe(true);
      await authModule.backendLogin(user.email, user.password);

      expect(permissionsModule.canAccessFeature("feature.settings")).toBe(false);
      expect(permissionsModule.getFirstAuthorizedRoute()).toBe("/localupload");
      await expect(settingsModule.pullBackendSettings()).resolves.toBeNull();
    } finally {
      restoreFetch();
    }
  });
});
