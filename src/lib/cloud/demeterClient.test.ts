import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeConfigMock = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({
    mode: "backend" as const,
    backendBaseUrl: "https://trapi.demeter-sante.fr/api/v1",
  })),
}));

const backendApiMocks = vi.hoisted(() => ({
  backendFetch: vi.fn(),
  formatBackendErrorMessage: vi.fn((error: unknown) => (error instanceof Error ? error.message : String(error))),
  handleBackendUnauthorized: vi.fn(),
  parseBackendHttpError: vi.fn(),
}));

const backendAuthMocks = vi.hoisted(() => ({
  backendRefresh: vi.fn(),
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  getRuntimeConfig: (...args: unknown[]) => runtimeConfigMock.getRuntimeConfig(...args),
}));

vi.mock("@/lib/backend-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-api")>("@/lib/backend-api");
  return {
    ...actual,
    backendFetch: (...args: unknown[]) => backendApiMocks.backendFetch(...args),
    formatBackendErrorMessage: (...args: unknown[]) => backendApiMocks.formatBackendErrorMessage(...args),
    handleBackendUnauthorized: (...args: unknown[]) => backendApiMocks.handleBackendUnauthorized(...args),
    parseBackendHttpError: (...args: unknown[]) => backendApiMocks.parseBackendHttpError(...args),
  };
});

vi.mock("@/lib/backend-auth", () => ({
  backendRefresh: (...args: unknown[]) => backendAuthMocks.backendRefresh(...args),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: (...args: unknown[]) => loggerMock.debug(...args),
    info: (...args: unknown[]) => loggerMock.info(...args),
    warn: (...args: unknown[]) => loggerMock.warn(...args),
    error: (...args: unknown[]) => loggerMock.error(...args),
  },
}));

import { transcribeWithDemeterSante } from "@/lib/cloud/demeterClient";
import { BackendHttpError } from "@/lib/backend-api";
import { TelemetryCollector } from "@/lib/telemetry";

describe("demeterClient", () => {
  beforeEach(() => {
    backendApiMocks.backendFetch.mockReset();
    backendApiMocks.formatBackendErrorMessage.mockReset();
    backendApiMocks.formatBackendErrorMessage.mockImplementation((error: unknown) =>
      error instanceof Error ? error.message : String(error)
    );
    backendApiMocks.handleBackendUnauthorized.mockReset();
    backendApiMocks.parseBackendHttpError.mockReset();
    backendAuthMocks.backendRefresh.mockReset();
    runtimeConfigMock.getRuntimeConfig.mockReset();
    runtimeConfigMock.getRuntimeConfig.mockReturnValue({
      mode: "backend",
      backendBaseUrl: "https://trapi.demeter-sante.fr/api/v1",
    });
    loggerMock.error.mockReset();
  });

  it("records backend endpoint, file size, and request phase on network failure", async () => {
    const telemetry = new TelemetryCollector("demeter-network-failure");
    const file = new File(["audio"], "audio.wav", { type: "audio/wav" });
    const networkError = new Error(
      "Impossible de joindre le backend. Vérifiez l'accès réseau à l'API puis réessayez."
    );
    backendApiMocks.backendFetch
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError)
      .mockRejectedValueOnce(networkError);

    await expect(
      transcribeWithDemeterSante(
        {
          file,
        },
        telemetry
      )
    ).rejects.toThrow("Impossible de joindre le backend");

    const summary = telemetry.exportSummary();
    const failedEvent = summary.events.find(
      (event) => event.type === "CLOUD_UPLOAD_FAILED" && event.data?.phase === "backend_request"
    );
    expect(failedEvent?.data).toEqual(
      expect.objectContaining({
        provider: "demeter_sante",
        fileName: "audio.wav",
        sizeBytes: file.size,
        endpointPath: "/providers/demeter-sante/audio/transcriptions",
        endpoint: "https://trapi.demeter-sante.fr/api/v1/providers/demeter-sante/audio/transcriptions",
      })
    );

    expect(summary.alerts.CLOUD_DEMETER_NETWORK_FAILED?.lastData).toEqual(
      expect.objectContaining({
        phase: "backend_request",
        endpoint: "https://trapi.demeter-sante.fr/api/v1/providers/demeter-sante/audio/transcriptions",
        sizeBytes: file.size,
      })
    );
  });

  it("surfaces an upload-specific diagnostic when backend probe remains reachable", async () => {
    const telemetry = new TelemetryCollector("demeter-upload-diagnostic");
    const file = new File(["audio"], "audio.wav", { type: "audio/wav" });
    backendApiMocks.backendFetch
      .mockRejectedValueOnce(new Error("Impossible de joindre le backend"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid file" }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "missing access token" }), { status: 401 }));
    backendApiMocks.parseBackendHttpError.mockResolvedValueOnce(
      new BackendHttpError({
        status: 400,
        code: "http_400",
        message: "invalid file",
        path: "/providers/demeter-sante/audio/transcriptions",
        method: "POST",
      })
    );
    backendApiMocks.parseBackendHttpError.mockResolvedValueOnce(
      new BackendHttpError({
        status: 401,
        code: "unauthorized",
        message: "Session expirée. Veuillez vous reconnecter.",
        path: "/providers/demeter-sante/models",
        method: "GET",
      })
    );

    await expect(
      transcribeWithDemeterSante(
        {
          file,
        },
        telemetry
      )
    ).rejects.toThrow("La route Demeter Santé accepte un POST multipart léger, mais l'envoi du fichier préparé échoue avant réponse");

    const summary = telemetry.exportSummary();
    expect(summary.alerts.CLOUD_DEMETER_NETWORK_FAILED?.lastData).toEqual(
      expect.objectContaining({
        multipartProbeReachable: true,
        multipartProbeDetail: expect.stringContaining("multipart probe status 400"),
        probeReachable: true,
        probeDetail: expect.stringContaining("probe status 401"),
      })
    );
  });

  it("refreshes backend auth and retries the transcription request when access has expired", async () => {
    const telemetry = new TelemetryCollector("demeter-refresh-retry");
    const file = new File(["audio"], "audio.wav", { type: "audio/wav" });

    backendAuthMocks.backendRefresh.mockResolvedValue(true);
    backendApiMocks.backendFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "bonjour" }), { status: 200 }));
    backendApiMocks.parseBackendHttpError.mockResolvedValue(
      new BackendHttpError({
        status: 401,
        code: "unauthorized",
        message: "Session expirée. Veuillez vous reconnecter.",
        path: "/providers/demeter-sante/audio/transcriptions",
        method: "POST",
      })
    );

    const result = await transcribeWithDemeterSante(
      {
        file,
      },
      telemetry
    );

    expect(result.text).toBe("bonjour");
    expect(backendAuthMocks.backendRefresh).toHaveBeenCalledTimes(1);
    expect(backendApiMocks.handleBackendUnauthorized).not.toHaveBeenCalled();
  });
});
