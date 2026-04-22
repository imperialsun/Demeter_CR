import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
  isBackendMode: vi.fn(() => true),
}));

const backendSessionMocks = vi.hoisted(() => ({
  isBackendAuthenticated: vi.fn(() => true),
  hasBackendPermission: vi.fn(() => true),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => runtimeMocks.isBackendMode(),
}));

vi.mock("@/lib/backend-session", () => ({
  isBackendAuthenticated: () => backendSessionMocks.isBackendAuthenticated(),
  hasBackendPermission: (...args: unknown[]) => backendSessionMocks.hasBackendPermission(...args),
}));

import { getFirstAuthorizedRoute } from "@/lib/backend-permissions";

describe("backend-permissions route priority", () => {
  beforeEach(() => {
    runtimeMocks.isBackendMode.mockReset();
    runtimeMocks.isBackendMode.mockReturnValue(true);
    backendSessionMocks.isBackendAuthenticated.mockReset();
    backendSessionMocks.isBackendAuthenticated.mockReturnValue(true);
    backendSessionMocks.hasBackendPermission.mockReset();
    backendSessionMocks.hasBackendPermission.mockReturnValue(true);
  });

  it("prefers /assistant when backend access is available", () => {
    expect(getFirstAuthorizedRoute()).toBe("/assistant");
    expect(backendSessionMocks.hasBackendPermission).toHaveBeenCalledWith("provider.cloud.demeter_sante");
    expect(backendSessionMocks.hasBackendPermission).not.toHaveBeenCalledWith("feature.localupload");
  });

  it("falls back to /localupload when assistant access is denied", () => {
    backendSessionMocks.hasBackendPermission.mockImplementation((permission: string) => permission !== "provider.cloud.demeter_sante");

    expect(getFirstAuthorizedRoute()).toBe("/localupload");
    expect(backendSessionMocks.hasBackendPermission.mock.calls.map(([permission]) => permission)).toEqual([
      "provider.cloud.demeter_sante",
      "feature.localupload",
    ]);
  });

  it("keeps /localupload as the standalone default", () => {
    runtimeMocks.isBackendMode.mockReturnValue(false);

    expect(getFirstAuthorizedRoute()).toBe("/localupload");
    expect(backendSessionMocks.hasBackendPermission).not.toHaveBeenCalled();
  });
});
