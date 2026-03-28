import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendUser } from "@/test/backend/adminClient";
import { createAppCookieJar, configureBackendRuntime, resetBrowserState } from "@/test/backend/runtime";

const INTEGRATION_TIMEOUT_MS = 120_000;

describe("backend auth integration", () => {
  beforeEach(() => {
    resetBrowserState();
  });

  it("logs in, restores the session from cookies, and logs out cleanly", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    const harness = await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const runtimeModule = await import("@/lib/runtime-config");
      const authModule = await import("@/lib/backend-auth");
      const sessionModule = await import("@/lib/backend-session");
      const appAuthModule = await import("@/lib/auth");

      expect(runtimeModule.isBackendMode()).toBe(true);

      const loginPayload = await authModule.backendLogin(user.email, user.password);
      expect(loginPayload.user.email).toBe(user.email);
      expect(window.sessionStorage.getItem("demeter-backend-authenticated")).toBe("1");
      expect(window.sessionStorage.getItem("demeter-backend-session")).toBeNull();
      expect(window.localStorage.getItem("demeter-backend-authenticated")).toBeNull();
      expect(sessionModule.isBackendAuthenticated()).toBe(true);
      expect(appAuthModule.isAuthenticated()).toBe(true);

      const mePayload = await authModule.backendMe();
      expect(mePayload?.user.id).toBe(user.id);

      resetBrowserState();
      expect(sessionModule.isBackendAuthenticated()).toBe(false);

      const initialized = await authModule.initializeBackendSession();
      expect(initialized?.user.id).toBe(user.id);
      expect(sessionModule.isBackendAuthenticated()).toBe(true);

      await authModule.backendLogout();
      expect(sessionModule.isBackendAuthenticated()).toBe(false);
      expect(sessionModule.getBackendSession()).toBeNull();

      const afterLogout = await authModule.backendMe();
      expect(afterLogout).toBeNull();
      expect(sessionModule.isBackendAuthenticated()).toBe(false);
    } finally {
      restoreFetch();
    }

    expect(harness.baseUrl).toContain("http://127.0.0.1:");
  }, INTEGRATION_TIMEOUT_MS);

  it("changes the password, revokes refresh sessions, and accepts the new password", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    const harness = await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const authModule = await import("@/lib/backend-auth");
      const sessionModule = await import("@/lib/backend-session");

      await authModule.backendLogin(user.email, user.password);
      expect(sessionModule.isBackendAuthenticated()).toBe(true);

      await authModule.backendChangePassword(user.password, "NewPass123!");

      const refreshOk = await authModule.backendRefresh();
      expect(refreshOk).toBe(false);
      expect(sessionModule.isBackendAuthenticated()).toBe(false);

      await authModule.backendLogout();

      await expect(authModule.backendLogin(user.email, user.password)).rejects.toThrow();

      const relogin = await authModule.backendLogin(user.email, "NewPass123!");
      expect(relogin.user.email).toBe(user.email);
      expect(sessionModule.isBackendAuthenticated()).toBe(true);

      await authModule.backendLogout();
      expect(sessionModule.isBackendAuthenticated()).toBe(false);
    } finally {
      restoreFetch();
    }

    expect(harness.baseUrl).toContain("http://127.0.0.1:");
  }, INTEGRATION_TIMEOUT_MS);
});
