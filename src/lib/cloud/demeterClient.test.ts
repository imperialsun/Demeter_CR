import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const DEMETER_UPLOAD_SLICE_SIZE_BYTES = 5 * 1024 * 1024;
const DEMETER_TEST_OPERATION_ID = "demeter-audio-test-operation";

function createAudioFile(sizeBytes: number, name = "audio.wav", mimeType = "audio/wav") {
  return new File([new Uint8Array(sizeBytes)], name, { type: mimeType });
}

function createJsonResponse(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function headersFromInit(init?: RequestInit) {
  return new Headers((init?.headers ?? {}) as HeadersInit);
}

function formDataFromInit(init?: RequestInit) {
  return init?.body as FormData;
}

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
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails when the first slice upload cannot reach the backend", async () => {
    const telemetry = new TelemetryCollector("demeter-network-failure");
    const file = createAudioFile(1024);
    const networkError = new Error("Impossible de joindre le backend. Vérifiez l'accès réseau à l'API puis réessayez.");
    backendApiMocks.backendFetch.mockRejectedValueOnce(networkError);

    await expect(
      transcribeWithDemeterSante(
        {
          file,
        },
        telemetry
      )
    ).rejects.toThrow("Impossible de joindre le backend");

    expect(backendApiMocks.backendFetch).toHaveBeenCalledTimes(1);
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
        transport: "slice-v1",
      })
    );

    expect(summary.alerts.CLOUD_DEMETER_REQUEST_FAILED?.lastData).toEqual(
      expect.objectContaining({
        phase: "backend_request",
        endpoint: "https://trapi.demeter-sante.fr/api/v1/providers/demeter-sante/audio/transcriptions",
        sizeBytes: file.size,
        transport: "slice-v1",
      })
    );
  });

  it("refreshes backend auth and retries the sliced relay upload before polling", async () => {
    vi.useFakeTimers();
    const telemetry = new TelemetryCollector("demeter-refresh-retry");
    const file = createAudioFile(1024);
    const progressSnapshots: Array<{ status?: string; chunkIndex?: number; chunkCount?: number }> = [];
    let postAttempts = 0;
    let pollAttempts = 0;
    let operationId = "";

    backendAuthMocks.backendRefresh.mockResolvedValue(true);
    backendApiMocks.backendFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = headersFromInit(init);
      if (path === "/providers/demeter-sante/audio/transcriptions" && method === "POST") {
        postAttempts += 1;
        if (postAttempts === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        operationId = headers.get("X-Demeter-Upload-Id") ?? DEMETER_TEST_OPERATION_ID;
        return createJsonResponse({
          operationId,
          status: "running",
          statusCode: 202,
          stage: "queued",
          chunkIndex: 0,
          chunkCount: 1,
          progress: 0,
          updatedAt: new Date().toISOString(),
        }, 202);
      }

      if (path === `/providers/demeter-sante/audio/transcriptions/operations/${operationId}` && method === "GET") {
        pollAttempts += 1;
        if (pollAttempts === 1) {
          return createJsonResponse({
            operationId,
            status: "running",
            statusCode: 202,
            stage: "running",
            chunkIndex: 0,
            chunkCount: 1,
            progress: 0.5,
            updatedAt: new Date().toISOString(),
          });
        }
        return createJsonResponse({
          operationId,
          status: "completed",
          statusCode: 200,
          stage: "completed",
          chunkIndex: 1,
          chunkCount: 1,
          progress: 1,
          updatedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          response: {
            text: "bonjour",
            chunks: [
              {
                text: "bonjour",
                chunkId: "demeter-relay-001",
                index: 0,
                startSec: 0,
                endSec: 1,
                durationSec: 1,
                segmentCount: 1,
                segments: [
                  {
                    index: 0,
                    start: 0,
                    end: 1,
                    text: "bonjour",
                    speaker: "SPEAKER_00",
                    chunkId: "demeter-relay-001",
                  },
                ],
              },
            ],
          },
        });
      }

      throw new Error(`unexpected backend fetch request: ${method} ${path}`);
    });
    backendApiMocks.parseBackendHttpError.mockResolvedValue(
      new BackendHttpError({
        status: 401,
        code: "unauthorized",
        message: "Session expirée. Veuillez vous reconnecter.",
        path: "/providers/demeter-sante/audio/transcriptions",
        method: "POST",
      })
    );

    const resultPromise = transcribeWithDemeterSante(
      {
        file,
        diarize: false,
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

    await Promise.resolve();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.text).toBe("bonjour");
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks?.[0].segments).toHaveLength(1);
    expect(result.chunks?.[0].segments?.[0].chunkId).toBe("demeter-relay-001");
    expect(backendAuthMocks.backendRefresh).toHaveBeenCalledTimes(1);
    expect(backendApiMocks.handleBackendUnauthorized).not.toHaveBeenCalled();
    expect(backendApiMocks.backendFetch).toHaveBeenCalledWith(
      "/providers/demeter-sante/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Demeter-Transport": "slice-v1",
          "X-Demeter-Upload-Final": "true",
        }),
      })
    );
    expect(progressSnapshots[0]).toEqual(
      expect.objectContaining({
        status: "running",
        chunkIndex: 0,
        chunkCount: 1,
      })
    );
  });

  it("uses backend direct slice transport and polls until completion", async () => {
    vi.useFakeTimers();
    const telemetry = new TelemetryCollector("demeter-backend-direct");
    const file = createAudioFile(DEMETER_UPLOAD_SLICE_SIZE_BYTES + 128);
    const progressSnapshots: Array<{ chunkIndex?: number; chunkCount?: number; status?: string }> = [];
    let postAttempts = 0;
    let pollAttempts = 0;
    let operationId = "";

    backendApiMocks.backendFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = headersFromInit(init);
      if (path === "/providers/demeter-sante/audio/transcriptions/backend" && method === "POST") {
        postAttempts += 1;
        const formData = formDataFromInit(init);
        const filePart = formData?.get("file");
        expect(filePart).toBeTruthy();
        expect(filePart).toBeInstanceOf(File);
        expect((filePart as File).size).toBeLessThanOrEqual(DEMETER_UPLOAD_SLICE_SIZE_BYTES);
        expect(headers.get("X-Demeter-Transport")).toBe("slice-v1");
        expect(headers.get("X-Demeter-Upload-Index")).toBe(String(postAttempts - 1));
        expect(headers.get("X-Demeter-Upload-Count")).toBe("2");
        expect(headers.get("X-Demeter-Upload-Final")).toBe(postAttempts === 2 ? "true" : "false");

        if (postAttempts === 1) {
          return new Response(null, { status: 204 });
        }

        operationId = headers.get("X-Demeter-Upload-Id") ?? DEMETER_TEST_OPERATION_ID;
        return createJsonResponse({
          operationId,
          status: "running",
          statusCode: 202,
          stage: "queued",
          chunkIndex: 0,
          chunkCount: 0,
          progress: 0,
          updatedAt: new Date().toISOString(),
        }, 202);
      }

      if (path === `/providers/demeter-sante/audio/transcriptions/operations/${operationId}` && method === "GET") {
        pollAttempts += 1;
        if (pollAttempts === 1) {
          return createJsonResponse({
            operationId,
            status: "running",
            statusCode: 202,
            stage: "reconstructing",
            chunkIndex: 0,
            chunkCount: 2,
            progress: 0.5,
            updatedAt: new Date().toISOString(),
          });
        }

        return createJsonResponse({
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
            chunks: [
              {
                text: "bonjour",
                chunkId: "demeter-backend-001",
                index: 0,
                startSec: 0,
                endSec: 5,
                durationSec: 5,
                segmentCount: 1,
                segments: [
                  {
                    index: 0,
                    start: 0,
                    end: 1,
                    speaker: "SPEAKER_00",
                    text: "bonjour",
                    chunkId: "demeter-backend-001",
                  },
                ],
              },
              {
                text: "monde",
                chunkId: "demeter-backend-002",
                index: 1,
                startSec: 5,
                endSec: 10,
                durationSec: 5,
                segmentCount: 1,
                segments: [
                  {
                    index: 1,
                    start: 5,
                    end: 6,
                    speaker: "SPEAKER_01",
                    text: "monde",
                    chunkId: "demeter-backend-002",
                  },
                ],
              },
            ],
          },
        });
      }

      throw new Error(`unexpected backend fetch request: ${method} ${path}`);
    });

    const resultPromise = transcribeWithDemeterSante(
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

    await Promise.resolve();
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.text).toBe("bonjour\nmonde");
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks?.[0].segments).toHaveLength(1);
    expect(result.chunks?.[1].segments).toHaveLength(1);
    expect(backendApiMocks.backendFetch).toHaveBeenCalledWith(
      "/providers/demeter-sante/audio/transcriptions/backend",
      expect.objectContaining({
        method: "POST",
        timeoutMs: 60_000,
        headers: expect.objectContaining({
          "X-Demeter-Transport": "slice-v1",
          "X-Cloud-Audio-Duration-Sec": "7201",
        }),
      })
    );
    expect(operationId).not.toBe("");
    expect(
      backendApiMocks.backendFetch.mock.calls.some(
        ([path, init]) => path === `/providers/demeter-sante/audio/transcriptions/operations/${operationId}` && (init as RequestInit | undefined)?.method === "GET"
      )
    ).toBe(true);
    expect(progressSnapshots[0]).toEqual(
      expect.objectContaining({
        status: "running",
        chunkIndex: 0,
        chunkCount: 0,
      })
    );
    expect(progressSnapshots.some((snapshot) => snapshot.chunkIndex === 2)).toBe(true);
    const summary = telemetry.exportSummary();
    expect(summary.events.some((event) => event.type === "CLOUD_UPLOAD_DONE")).toBe(true);
  });
});
