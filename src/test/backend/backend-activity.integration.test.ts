import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import { createBackendUser, getActivitySummary } from "./adminClient";
import { createAppCookieJar, configureBackendRuntime, resetBrowserState } from "./runtime";

describe("backend activity integration", () => {
  beforeEach(() => {
    resetBrowserState();
  });

  it("flushes tracked backend activity into the real admin summary", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();
    const today = new Date().toISOString().slice(0, 10);

    try {
      const authModule = await import("@/lib/backend-auth");
      const activityModule = await import("@/lib/backend-activity-sync");

      await authModule.backendLogin(user.email, user.password);

      const before = await getActivitySummary({ from: today, to: today });

      activityModule.trackBackendActivityEvent({
        eventKind: "report",
        sourceMode: "cloud_backend",
        provider: "demeter_sante",
        status: "success",
        meta: { source: "integration-test" },
      });
      await waitFor(async () => {
        const after = await getActivitySummary({ from: today, to: today });
        expect(after.totals.reports - before.totals.reports).toBe(1);
        expect(
          (after.breakdown.reportsByMode.cloud_backend ?? 0) - (before.breakdown.reportsByMode.cloud_backend ?? 0)
        ).toBe(1);
        expect(
          (after.breakdown.reportsByProvider.demeter_sante ?? 0) -
            (before.breakdown.reportsByProvider.demeter_sante ?? 0)
        ).toBe(1);
      });
    } finally {
      restoreFetch();
    }
  });
});
