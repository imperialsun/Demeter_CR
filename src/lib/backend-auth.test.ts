import { beforeEach, describe, expect, it, vi } from "vitest";

const backendApiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  parseBackendHttpError: vi.fn(),
}));

const backendSessionMocks = vi.hoisted(() => ({
  clearBackendSession: vi.fn(),
  invalidateBackendSession: vi.fn(),
  setBackendSession: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api");
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => backendApiMocks.backendFetch(...args),
    parseBackendHttpError: (...args: unknown[]) => backendApiMocks.parseBackendHttpError(...args),
  };
});

vi.mock("@/lib/backend-session", () => ({
  clearBackendSession: (...args: unknown[]) => backendSessionMocks.clearBackendSession(...args),
  invalidateBackendSession: (...args: unknown[]) => backendSessionMocks.invalidateBackendSession(...args),
  setBackendSession: (...args: unknown[]) => backendSessionMocks.setBackendSession(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: (...args: unknown[]) => loggerMock.info(...args),
    warn: (...args: unknown[]) => loggerMock.warn(...args),
    debug: (...args: unknown[]) => loggerMock.debug(...args),
  },
}));

import { backendRefresh } from "@/lib/backend-auth";

describe("backend-auth refresh", () => {
  beforeEach(() => {
    backendApiMocks.backendFetch.mockReset();
    backendApiMocks.parseBackendHttpError.mockReset();
    backendSessionMocks.clearBackendSession.mockReset();
    backendSessionMocks.invalidateBackendSession.mockReset();
    backendSessionMocks.setBackendSession.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.debug.mockReset();
  });

  it("returns expired for refresh token responses and clears the local session without warnings", async () => {
    backendApiMocks.backendFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: "refresh token expired" }), { status: 403 })
    );

    const result = await backendRefresh();

    expect(result).toBe("expired");
    expect(backendSessionMocks.clearBackendSession).toHaveBeenCalledTimes(1);
    expect(backendSessionMocks.invalidateBackendSession).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
