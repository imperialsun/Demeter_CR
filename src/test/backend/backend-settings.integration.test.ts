import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendUser, getUserAccess, updateUserEntitlements } from "@/test/backend/adminClient";
import { createAppCookieJar, configureBackendRuntime, resetBrowserState } from "@/test/backend/runtime";

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
