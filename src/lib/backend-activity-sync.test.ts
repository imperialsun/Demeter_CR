import { beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";

const backendApiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  parseBackendJson: vi.fn(),
  readBackendError: vi.fn(),
}));

const backendAuthMocks = vi.hoisted(() => ({
  backendRefresh: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => true,
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => true,
}));

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api");
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => backendApiMocks.backendFetch(...args),
    parseBackendJson: (...args: unknown[]) => backendApiMocks.parseBackendJson(...args),
    readBackendError: (...args: unknown[]) => backendApiMocks.readBackendError(...args),
  };
});

vi.mock("@/lib/backend-auth", () => ({
  backendRefresh: (...args: unknown[]) => backendAuthMocks.backendRefresh(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { trackBackendActivityEvent } from "@/lib/backend-activity-sync";

describe("backend-activity-sync", () => {
  beforeEach(() => {
    backendApiMocks.backendFetch.mockReset();
    backendApiMocks.parseBackendJson.mockReset();
    backendApiMocks.readBackendError.mockReset();
    backendAuthMocks.backendRefresh.mockReset();
    window.localStorage.clear();
  });

  it("refreshes the backend session and retries an activity batch after unauthorized", async () => {
    backendAuthMocks.backendRefresh.mockResolvedValue(true);
    backendApiMocks.backendFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ accepted: 1, duplicates: 0, rejected: [] }), { status: 200 }));
    backendApiMocks.parseBackendJson.mockResolvedValue({
      accepted: 1,
      duplicates: 0,
      rejected: [],
    });

    trackBackendActivityEvent({
      eventKind: "transcription",
      sourceMode: "local",
      provider: "mic",
      status: "success",
    });

    await waitFor(() => expect(backendApiMocks.backendFetch).toHaveBeenCalledTimes(2));
    expect(backendAuthMocks.backendRefresh).toHaveBeenCalledTimes(1);
    expect(backendApiMocks.parseBackendJson).toHaveBeenCalledTimes(1);
  });
});
