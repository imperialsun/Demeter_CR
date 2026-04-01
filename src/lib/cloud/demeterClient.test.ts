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

  it("uses the backend direct route and extended timeout for long audio", async () => {
    const telemetry = new TelemetryCollector("demeter-backend-direct");
    const file = new File(["audio"], "audio.wav", { type: "audio/wav" });
    const progressSnapshots: Array<{ chunkIndex?: number; chunkCount?: number; status?: string }> = [];
    const operationId = "demeter-audio-test-operation";
    let pollCount = 0;

    backendApiMocks.backendFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/providers/demeter-sante/audio/transcriptions/backend" && method === "POST") {
        return new Response(
          JSON.stringify({
            operationId,
            status: "running",
            statusCode: 202,
            stage: "queued",
            chunkIndex: 0,
            chunkCount: 2,
            progress: 0,
            updatedAt: new Date().toISOString(),
          }),
          { status: 202, headers: { "Content-Type": "application/json" } }
        );
      }

      if (path === `/providers/demeter-sante/audio/transcriptions/backend/operations/${operationId}` && method === "GET") {
        pollCount += 1;
        if (pollCount === 1) {
          return new Response(
            JSON.stringify({
              operationId,
              status: "running",
              statusCode: 202,
              stage: "chunk_completed",
              chunkIndex: 1,
              chunkCount: 2,
              progress: 0.5,
              updatedAt: new Date().toISOString(),
              response: {
                text: "bonjour",
                segments: [
                  {
                    text: "bonjour",
                    start: 0,
                    end: 1,
                    speaker: "SPEAKER_00",
                    chunkId: "demeter-backend-001",
                  },
                ],
                chunks: [
                  {
                    text: "bonjour",
                    chunkId: "demeter-backend-001",
                    index: 0,
                    startSec: 0,
                    endSec: 5,
                    durationSec: 5,
                    segmentCount: 1,
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }

        return new Response(
          JSON.stringify({
            operationId,
            status: "completed",
            statusCode: 200,
            stage: "completed",
            chunkIndex: 2,
            chunkCount: 2,
            progress: 1,
            updatedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            response: {
              text: "bonjour\nmonde",
              segments: [
                {
                  text: "bonjour",
                  start: 0,
                  end: 1,
                  speaker: "SPEAKER_00",
                  chunkId: "demeter-backend-001",
                },
                {
                  text: "monde",
                  start: 5,
                  end: 6,
                  speaker: "SPEAKER_01",
                  chunkId: "demeter-backend-002",
                },
              ],
              chunks: [
                {
                  text: "bonjour",
                  chunkId: "demeter-backend-001",
                  index: 0,
                  startSec: 0,
                  endSec: 5,
                  durationSec: 5,
                  segmentCount: 1,
                },
                {
                  text: "monde",
                  chunkId: "demeter-backend-002",
                  index: 1,
                  startSec: 5,
                  endSec: 10,
                  durationSec: 5,
                  segmentCount: 1,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      throw new Error(`unexpected backend fetch request: ${method} ${path}`);
    });

    const result = await transcribeWithDemeterSante(
      {
        file,
        backendDirect: true,
        durationSec: 7201,
        model: "voxtral-mini-latest",
        onBackendOperationProgress: (snapshot) => {
          progressSnapshots.push({
            status: snapshot.status,
            chunkIndex: snapshot.chunkIndex,
            chunkCount: snapshot.chunkCount,
          });
        },
      },
      telemetry
    );

    expect(result.text).toBe("bonjour\nmonde");
    expect(progressSnapshots[0]).toEqual(
      expect.objectContaining({
        status: "running",
        chunkIndex: 0,
        chunkCount: 2,
      })
    );
    expect(progressSnapshots.some((snapshot) => snapshot.chunkIndex === 1)).toBe(true);
    expect(progressSnapshots.some((snapshot) => snapshot.chunkIndex === 2)).toBe(true);
    const [path, init] = backendApiMocks.backendFetch.mock.calls[0] ?? [];
    expect(path).toBe("/providers/demeter-sante/audio/transcriptions/backend");
    expect(init).toEqual(
      expect.objectContaining({
        method: "POST",
        timeoutMs: 25 * 60 * 1000,
        headers: expect.objectContaining({
          "X-Cloud-Audio-Duration-Sec": "7201",
        }),
      })
    );
  }, 20_000);
});
