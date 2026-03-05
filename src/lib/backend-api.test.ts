import { describe, expect, it } from "vitest";

import { BackendHttpError, formatBackendErrorMessage, parseBackendHttpError } from "@/lib/backend-api";

describe("backend-api", () => {
  it("parses backend 403 payload into typed error", async () => {
    const response = new Response(
      JSON.stringify({
        error: "forbidden",
        message: "Forbidden by policy",
        path: "/api/v1/settings",
      }),
      {
        status: 403,
        headers: { "Content-Type": "application/json" },
      }
    );

    const error = await parseBackendHttpError(response, "/settings", "GET");

    expect(error).toBeInstanceOf(BackendHttpError);
    expect(error.status).toBe(403);
    expect(error.code).toBe("forbidden");
    expect(error.message).toBe("Forbidden by policy");
    expect(error.path).toBe("/api/v1/settings");
    expect(error.method).toBe("GET");
  });

  it("returns standard user messages for 401/403", () => {
    const forbidden = new BackendHttpError({
      status: 403,
      code: "forbidden",
      message: "raw forbidden",
      path: "/settings",
      method: "GET",
    });
    const unauthorized = new BackendHttpError({
      status: 401,
      code: "unauthorized",
      message: "raw unauthorized",
      path: "/auth/me",
      method: "GET",
    });

    expect(formatBackendErrorMessage(forbidden)).toBe("Accès refusé par vos permissions backend.");
    expect(formatBackendErrorMessage(unauthorized)).toBe("Session expirée. Veuillez vous reconnecter.");
  });
});
