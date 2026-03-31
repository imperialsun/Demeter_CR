import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BACKEND_NETWORK_ERROR_MESSAGE,
  BACKEND_TIMEOUT_ERROR_MESSAGE,
  BackendHttpError,
  backendFetch,
  formatBackendErrorMessage,
  isBackendAudioValidationError,
  parseBackendHttpError,
  shouldRetryRawAudioUpload,
} from "@/lib/backend-api";

describe("backend-api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("parses backend audio validation payload and exposes trace metadata", async () => {
    const response = new Response(
      JSON.stringify({
        error: "fichier audio vide",
        message: "Fichier audio vide",
        code: "empty_audio_file",
        path: "/providers/demeter-sante/audio/transcriptions",
        traceId: "trace-123",
        fileName: "segment_0.wav",
        fileSizeBytes: 0,
        mimeType: "audio/wav",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );

    const error = await parseBackendHttpError(response, "/providers/demeter-sante/audio/transcriptions", "POST");

    expect(error).toBeInstanceOf(BackendHttpError);
    expect(error.status).toBe(400);
    expect(error.code).toBe("empty_audio_file");
    expect(error.message).toBe("Fichier audio vide");
    expect(error.traceId).toBe("trace-123");
    expect(error.fileName).toBe("segment_0.wav");
    expect(error.fileSizeBytes).toBe(0);
    expect(error.mimeType).toBe("audio/wav");
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

  it("retries safe requests after a transient 404", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await backendFetch("/auth/me", {
      retryAttempts: 1,
      retryInitialBackoffMs: 1,
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast when the configured timeout expires", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const abortHandler = () => {
          const abortError = new Error("The operation was aborted.");
          abortError.name = "AbortError";
          reject(abortError);
        };

        if (init?.signal?.aborted) {
          abortHandler();
          return;
        }

        init?.signal?.addEventListener("abort", abortHandler, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      backendFetch("/auth/me", {
        timeoutMs: 5,
        retryAttempts: 0,
      })
    ).rejects.toMatchObject({
      name: "BackendTimeoutError",
      message: expect.stringContaining(BACKEND_TIMEOUT_ERROR_MESSAGE),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rewords network fetch failures into an actionable backend message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      })
    );

    await expect(backendFetch("/providers/demeter-sante/audio/transcriptions", { method: "POST" })).rejects.toThrow(
      BACKEND_NETWORK_ERROR_MESSAGE
    );
  });

  it("recognizes audio validation errors as retryable raw uploads", () => {
    const backendError = new BackendHttpError({
      status: 400,
      code: "invalid_audio_file",
      message: "Fichier audio invalide.",
      path: "/providers/demeter-sante/audio/transcriptions",
      method: "POST",
      traceId: "trace-1",
    });

    expect(isBackendAudioValidationError(backendError)).toBe(true);
    expect(shouldRetryRawAudioUpload(backendError)).toBe(true);
    expect(shouldRetryRawAudioUpload(new Error("Mistral API (400): Audio input could not be decoded."))).toBe(true);
    expect(shouldRetryRawAudioUpload(new Error("Mistral API (422): validation failed"))).toBe(false);
  });
});
