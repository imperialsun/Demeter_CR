import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  parseBackendJson: vi.fn(),
  parseBackendHttpError: vi.fn(),
  isBackendUnauthorizedError: vi.fn(),
  isBackendForbiddenError: vi.fn(),
  handleBackendUnauthorized: vi.fn(),
  formatBackendErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => true,
}));

vi.mock("@/lib/backend-session", () => ({
  isBackendAuthenticated: () => true,
}));

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api");
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => apiMocks.backendFetch(...args),
    parseBackendJson: (...args: unknown[]) => apiMocks.parseBackendJson(...args),
    parseBackendHttpError: (...args: unknown[]) => apiMocks.parseBackendHttpError(...args),
    isBackendUnauthorizedError: (...args: unknown[]) => apiMocks.isBackendUnauthorizedError(...args),
    isBackendForbiddenError: (...args: unknown[]) => apiMocks.isBackendForbiddenError(...args),
    handleBackendUnauthorized: (...args: unknown[]) => apiMocks.handleBackendUnauthorized(...args),
    formatBackendErrorMessage: (...args: unknown[]) => apiMocks.formatBackendErrorMessage(...args),
  };
});

import { BackendHttpError } from "@/lib/backend-api";
import { queueBackendSettingsSync } from "@/lib/backend-settings-sync";

describe("backend-settings-sync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.backendFetch.mockReset();
    apiMocks.parseBackendJson.mockReset();
    apiMocks.parseBackendHttpError.mockReset();
    apiMocks.isBackendUnauthorizedError.mockReset();
    apiMocks.isBackendForbiddenError.mockReset();
    apiMocks.handleBackendUnauthorized.mockReset();
    apiMocks.formatBackendErrorMessage.mockReset();
    apiMocks.formatBackendErrorMessage.mockImplementation((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );

    const forbiddenError = new BackendHttpError({
      status: 403,
      code: "forbidden",
      message: "forbidden",
      path: "/settings",
      method: "PUT",
    });

    apiMocks.backendFetch.mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    apiMocks.parseBackendHttpError.mockResolvedValue(forbiddenError);
    apiMocks.isBackendUnauthorizedError.mockReturnValue(false);
    apiMocks.isBackendForbiddenError.mockImplementation((error: unknown) =>
      error instanceof BackendHttpError && error.status === 403
    );
    apiMocks.handleBackendUnauthorized.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not schedule retry after forbidden response", async () => {
    queueBackendSettingsSync({ cloudMaxTokens: 2048 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(apiMocks.backendFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(apiMocks.backendFetch).toHaveBeenCalledTimes(1);
    expect(apiMocks.handleBackendUnauthorized).not.toHaveBeenCalled();
  });
});
