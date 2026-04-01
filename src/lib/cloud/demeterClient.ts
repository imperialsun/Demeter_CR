import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { getRuntimeConfig } from "@/lib/runtime-config";
import {
  BackendHttpError,
  backendFetch,
  formatBackendErrorMessage,
  isBackendUnauthorizedError,
  handleBackendUnauthorized,
  isBackendRetryableTransportError,
  parseBackendJson,
  parseBackendHttpError,
} from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";

const DEMETER_TRANSCRIPTIONS_PATH = "/providers/demeter-sante/audio/transcriptions";
const DEMETER_TRANSCRIPTIONS_BACKEND_PATH = "/providers/demeter-sante/audio/transcriptions/backend";
const DEMETER_TRANSCRIPTIONS_BACKEND_OPERATIONS_PATH = "/providers/demeter-sante/audio/transcriptions/backend/operations";
const DEMETER_MODELS_PATH = "/providers/demeter-sante/models";
const DEMETER_TRANSCRIPTION_REQUEST_TIMEOUT_MS = 300_000;
const DEMETER_BACKEND_DIRECT_REQUEST_TIMEOUT_MS = 25 * 60 * 1000;
const DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS = 15_000;
const DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS = 10_000;
const DEMETER_PROBE_REQUEST_TIMEOUT_MS = 10_000;
const DEMETER_UPLOAD_NETWORK_DIAGNOSTIC_MESSAGE =
  "Le backend Demeter Santé répond, mais l'envoi du fichier échoue avant réponse. Vérifiez le proxy, la taille du fichier et la stabilité réseau puis réessayez.";
const DEMETER_MULTIPART_PROBE_DIAGNOSTIC_MESSAGE =
  "La route Demeter Santé accepte un POST multipart léger, mais l'envoi du fichier préparé échoue avant réponse. Le problème concerne probablement la taille du fichier, une limite proxy intermédiaire ou une coupure pendant l'upload.";

export type DemeterTranscriptionResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  chunks?: unknown;
  words?: unknown;
};

export type DemeterBackendTranscriptionOperationResponse = {
  operationId: string;
  status: string;
  statusCode?: number;
  stage?: string;
  chunkIndex?: number;
  chunkCount?: number;
  progress?: number;
  partialText?: string;
  lastError?: string;
  updatedAt?: string;
  finishedAt?: string;
  response?: DemeterTranscriptionResponse;
};

type DemeterTranscriptionRequest = {
  file: File;
  diarize?: boolean;
  model?: string;
  durationSec?: number;
  backendDirect?: boolean;
  signal?: AbortSignal;
  onBackendOperationProgress?: (snapshot: DemeterBackendTranscriptionOperationResponse) => void;
  onDiarizationResolved?: (info: {
    requestedDiarize: boolean;
    effectiveDiarize: boolean;
    fallbackApplied: boolean;
  }) => void;
};

async function probeDemeterBackendReachability(
  telemetryContext: Record<string, unknown>,
  telemetry?: TelemetryCollector
): Promise<{ reachable: boolean; detail: string }> {
  try {
    const response = await backendFetch(DEMETER_MODELS_PATH, {
      method: "GET",
      timeoutMs: DEMETER_PROBE_REQUEST_TIMEOUT_MS,
      retryAttempts: 0,
    });
    if (response.ok) {
      telemetry?.logEvent("LOG_INFO", {
        ...telemetryContext,
        phase: "backend_probe",
        probePath: DEMETER_MODELS_PATH,
        probeStatus: response.status,
        probeReachable: true,
      });
      return { reachable: true, detail: `probe status ${response.status}` };
    }

    const error = await parseBackendHttpError(response, DEMETER_MODELS_PATH, "GET");
    const detail = formatBackendErrorMessage(error);
    telemetry?.logEvent("LOG_INFO", {
      ...telemetryContext,
      phase: "backend_probe",
      probePath: DEMETER_MODELS_PATH,
      probeStatus: response.status,
      probeReachable: true,
      probeDetail: detail,
    });
    return { reachable: true, detail: `probe status ${response.status}: ${detail}` };
  } catch (probeError) {
    const detail = formatBackendErrorMessage(probeError);
    telemetry?.logEvent("LOG_WARN", {
      ...telemetryContext,
      phase: "backend_probe",
      probePath: DEMETER_MODELS_PATH,
      probeReachable: false,
      probeDetail: detail,
    });
    return { reachable: false, detail };
  }
}

async function probeDemeterMultipartReachability(
  telemetryContext: Record<string, unknown>,
  telemetry?: TelemetryCollector
): Promise<{ reachable: boolean; detail: string }> {
  const probeFormData = new FormData();
  probeFormData.set("diarize", "false");
  probeFormData.set("file", new File([new Uint8Array([0])], "demeter-probe.wav", { type: "audio/wav" }));

  try {
    const response = await backendFetch(DEMETER_TRANSCRIPTIONS_PATH, {
      method: "POST",
      body: probeFormData,
      timeoutMs: DEMETER_PROBE_REQUEST_TIMEOUT_MS,
      retryAttempts: 0,
    });
    if (response.ok) {
      telemetry?.logEvent("LOG_INFO", {
        ...telemetryContext,
        phase: "multipart_probe",
        probePath: DEMETER_TRANSCRIPTIONS_PATH,
        probeStatus: response.status,
        probeReachable: true,
      });
      return { reachable: true, detail: `multipart probe status ${response.status}` };
    }

    const error = await parseBackendHttpError(response, DEMETER_TRANSCRIPTIONS_PATH, "POST");
    const detail = formatBackendErrorMessage(error);
    telemetry?.logEvent("LOG_INFO", {
      ...telemetryContext,
      phase: "multipart_probe",
      probePath: DEMETER_TRANSCRIPTIONS_PATH,
      probeStatus: response.status,
      probeReachable: true,
      probeDetail: detail,
    });
    return { reachable: true, detail: `multipart probe status ${response.status}: ${detail}` };
  } catch (probeError) {
    const detail = formatBackendErrorMessage(probeError);
    telemetry?.logEvent("LOG_WARN", {
      ...telemetryContext,
      phase: "multipart_probe",
      probePath: DEMETER_TRANSCRIPTIONS_PATH,
      probeReachable: false,
      probeDetail: detail,
    });
    return { reachable: false, detail };
  }
}

function buildDemeterBackendOperationStatusPath(operationId: string): string {
  return `${DEMETER_TRANSCRIPTIONS_BACKEND_OPERATIONS_PATH}/${encodeURIComponent(operationId)}`;
}

function isDemeterBackendOperationTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isDemeterBackendOperationRetryableError(error: unknown): boolean {
  if (isBackendRetryableTransportError(error)) {
    return true;
  }
  if (!(error instanceof BackendHttpError)) {
    return false;
  }
  return error.status === 408 || error.status === 429 || error.status === 500 || error.status === 502 || error.status === 503 || error.status === 504;
}

function createAbortError(message = "La requête a été interrompue") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

async function sendDemeterBackendOperationRequest(
  path: string,
  init: RequestInit & { timeoutMs?: number; retryAttempts?: number }
): Promise<Response> {
  const send = () =>
    backendFetch(path, {
      ...init,
      retryAttempts: 0,
    });

  let response = await send();
  if (response.ok || response.status !== 401) {
    return response;
  }

  const unauthorizedError = await parseBackendHttpError(response, path, (init.method ?? "GET").toUpperCase());
  if (!isBackendUnauthorizedError(unauthorizedError)) {
    return response;
  }

  logger.warn("[cloud][demeter] unauthorized during backend operation request, attempting refresh before retry", {
    path,
    method: (init.method ?? "GET").toUpperCase(),
  });
  try {
    const refreshed = await backendRefresh();
    if (!refreshed) {
      handleBackendUnauthorized(unauthorizedError);
      return response;
    }
  } catch (refreshError) {
    logger.warn("[cloud][demeter] refresh request failed during backend operation", {
      path,
      message: refreshError instanceof Error ? refreshError.message : String(refreshError),
    });
    throw new Error(`Impossible de renouveler la session backend Demeter Santé. ${formatBackendErrorMessage(refreshError)}`, {
      cause: refreshError,
    });
  }

  response = await send();
  if (!response.ok && response.status === 401) {
    const retryError = await parseBackendHttpError(response, path, (init.method ?? "GET").toUpperCase());
    handleBackendUnauthorized(retryError);
  }
  return response;
}

export async function transcribeWithDemeterSante(
  request: DemeterTranscriptionRequest,
  telemetry?: TelemetryCollector
): Promise<DemeterTranscriptionResponse> {
  const diarize = request.diarize ?? true;
  const backendDirect = request.backendDirect ?? false;
  const endpointPath = backendDirect ? DEMETER_TRANSCRIPTIONS_BACKEND_PATH : DEMETER_TRANSCRIPTIONS_PATH;
  const timeoutMs = backendDirect ? DEMETER_BACKEND_DIRECT_REQUEST_TIMEOUT_MS : DEMETER_TRANSCRIPTION_REQUEST_TIMEOUT_MS;
  const formData = new FormData();
  formData.set("diarize", diarize ? "true" : "false");
  if (diarize) {
    formData.append("timestamp_granularities", "segment");
  }
  if (typeof request.model === "string" && request.model.trim().length > 0) {
    formData.set("model", request.model.trim());
  }
  formData.set("file", request.file, request.file.name);

  const { backendBaseUrl } = getRuntimeConfig();
  const endpoint = `${backendBaseUrl.replace(/\/+$/, "")}${endpointPath}`;
  const audioDurationSec = typeof request.durationSec === "number" && Number.isFinite(request.durationSec)
    ? Math.max(0, request.durationSec)
    : undefined;
  const telemetryContext = {
    provider: "demeter_sante",
    diarize,
    routeMode: backendDirect ? "backend_direct" : "relay",
    fileName: request.file.name,
    sizeBytes: request.file.size,
    audioDurationSec,
    backendBaseUrl,
    endpointPath,
    endpoint,
  };

  telemetry?.logEvent("CLOUD_UPLOAD_START", {
    ...telemetryContext,
    phase: "backend_request_start",
  });

  const headers: HeadersInit | undefined =
    audioDurationSec !== undefined ? { "X-Cloud-Audio-Duration-Sec": String(audioDurationSec) } : undefined;

  if (backendDirect) {
    let operationId = "";
    try {
      const startResponse = await sendDemeterTranscriptionRequest(formData, request.signal, endpointPath, timeoutMs, headers);
      if (!startResponse.ok) {
        const error = await parseBackendHttpError(startResponse, endpointPath, "POST");
        const message = formatBackendErrorMessage(error);
        logger.error("[cloud][demeter] backend direct start failed", { status: startResponse.status, message, endpoint });
        telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
          ...telemetryContext,
          phase: "backend_operation_start",
          status: startResponse.status,
          message,
        });
        telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
          ...telemetryContext,
          phase: "backend_operation_start",
          status: startResponse.status,
          message,
        });
        throw error;
      }

      const startPayload = await parseBackendJson<DemeterBackendTranscriptionOperationResponse>(startResponse);
      operationId = startPayload.operationId.trim();
      if (!operationId) {
        throw new Error("Réponse backend Demeter invalide: operationId manquant");
      }

      request.onBackendOperationProgress?.(startPayload);
      telemetry?.logEvent("CLOUD_UPLOAD_PROGRESS", {
        ...telemetryContext,
        phase: "backend_operation_started",
        operationId,
        status: startPayload.status,
        stage: startPayload.stage,
        chunkIndex: startPayload.chunkIndex,
        chunkCount: startPayload.chunkCount,
        progress: startPayload.progress,
      });

      const operationStatusPath = buildDemeterBackendOperationStatusPath(operationId);
      const cancelBackendOperation = async () => {
        try {
          await sendDemeterBackendOperationRequest(operationStatusPath, {
            method: "DELETE",
            timeoutMs: DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS,
          });
        } catch (cancelError) {
          logger.warn("[cloud][demeter] backend direct cancel request failed", {
            operationId,
            message: cancelError instanceof Error ? cancelError.message : String(cancelError),
          });
        }
      };
      while (true) {
        if (request.signal?.aborted) {
          await cancelBackendOperation();
          throw createAbortError();
        }

        let pollResponse: Response;
        try {
          pollResponse = await sendDemeterBackendOperationRequest(operationStatusPath, {
            method: "GET",
            signal: request.signal,
            timeoutMs: DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS,
          });
        } catch (pollError) {
          if (request.signal?.aborted) {
            await cancelBackendOperation();
            throw createAbortError();
          }
          if (isDemeterBackendOperationRetryableError(pollError)) {
            logger.warn("[cloud][demeter] backend direct status poll retry", {
              operationId,
              message: formatBackendErrorMessage(pollError),
            });
            await sleep(DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS);
            continue;
          }
          throw pollError;
        }

        if (!pollResponse.ok) {
          const error = await parseBackendHttpError(pollResponse, operationStatusPath, "GET");
          if (isDemeterBackendOperationRetryableError(error)) {
            logger.warn("[cloud][demeter] backend direct status retryable response", {
              operationId,
              status: error.status,
              message: error.message,
            });
            await sleep(DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS);
            continue;
          }
          throw error;
        }

        const snapshot = await parseBackendJson<DemeterBackendTranscriptionOperationResponse>(pollResponse);
        if (!snapshot.operationId) {
          throw new Error("Réponse backend Demeter invalide: operationId manquant dans le statut");
        }
        if (snapshot.operationId !== operationId) {
          throw new Error("Réponse backend Demeter incohérente: operationId différent");
        }

        request.onBackendOperationProgress?.(snapshot);
        telemetry?.logEvent("CLOUD_UPLOAD_PROGRESS", {
          ...telemetryContext,
          phase: "backend_operation_progress",
          operationId,
          status: snapshot.status,
          stage: snapshot.stage,
          chunkIndex: snapshot.chunkIndex,
          chunkCount: snapshot.chunkCount,
          progress: snapshot.progress,
        });

        if (isDemeterBackendOperationTerminalStatus(snapshot.status)) {
          if (snapshot.status === "completed") {
            const finalResponse = snapshot.response;
            if (!finalResponse) {
              throw new Error("Backend transcription completed without response payload");
            }
            request.onDiarizationResolved?.({
              requestedDiarize: diarize,
              effectiveDiarize: diarize,
              fallbackApplied: false,
            });
            telemetry?.logEvent("CLOUD_UPLOAD_DONE", {
              ...telemetryContext,
              phase: "backend_operation_done",
              operationId,
              chunkCount: snapshot.chunkCount,
              chunkIndex: snapshot.chunkIndex,
              progress: snapshot.progress,
            });
            return finalResponse;
          }

          const statusCode = typeof snapshot.statusCode === "number" && snapshot.statusCode > 0
            ? snapshot.statusCode
            : snapshot.status === "cancelled"
              ? 408
              : 500;
          const message = snapshot.lastError?.trim() || `Backend transcription operation ${snapshot.status}`;
          throw new BackendHttpError({
            status: statusCode,
            code: snapshot.status === "cancelled" ? "cancelled" : "backend_transcription_failed",
            message,
            path: operationStatusPath,
            method: "GET",
          });
        }

        await sleep(DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS);
      }
    } catch (error) {
      if (request.signal?.aborted) {
        if (operationId) {
          try {
            await sendDemeterBackendOperationRequest(buildDemeterBackendOperationStatusPath(operationId), {
              method: "DELETE",
              timeoutMs: DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS,
            });
          } catch (cancelError) {
            logger.warn("[cloud][demeter] backend direct cancel request failed during abort", {
              operationId,
              message: cancelError instanceof Error ? cancelError.message : String(cancelError),
            });
          }
        }
        throw createAbortError();
      }

      const message = formatBackendErrorMessage(error);
      logger.error("[cloud][demeter] backend direct operation failed", {
        endpoint,
        operationId,
        message,
      });
      telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
        ...telemetryContext,
        phase: "backend_operation",
        operationId,
        message,
      });
      telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
        ...telemetryContext,
        phase: "backend_operation",
        operationId,
        message,
      });
      throw error;
    }
  }

  let response: Response;
  try {
    response = await sendDemeterTranscriptionRequest(formData, request.signal, endpointPath, timeoutMs, headers);
  } catch (error) {
    if (request.signal?.aborted) {
      throw error;
    }
    const message = formatBackendErrorMessage(error);
    const multipartProbe = await probeDemeterMultipartReachability(telemetryContext, telemetry);
    const probe = await probeDemeterBackendReachability(telemetryContext, telemetry);
    const surfacedMessage = multipartProbe.reachable
      ? `${DEMETER_MULTIPART_PROBE_DIAGNOSTIC_MESSAGE} (taille fichier: ${request.file.size} octets; ${multipartProbe.detail})`
      : probe.reachable
        ? `${DEMETER_UPLOAD_NETWORK_DIAGNOSTIC_MESSAGE} (${probe.detail})`
        : message;
    logger.error("[cloud][demeter] request failed before response", {
      endpoint,
      message,
      surfacedMessage,
      multipartProbeReachable: multipartProbe.reachable,
      multipartProbeDetail: multipartProbe.detail,
      probeReachable: probe.reachable,
      probeDetail: probe.detail,
      sizeBytes: request.file.size,
    });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      ...telemetryContext,
      phase: "backend_request",
      message: surfacedMessage,
      multipartProbeReachable: multipartProbe.reachable,
      multipartProbeDetail: multipartProbe.detail,
      probeReachable: probe.reachable,
      probeDetail: probe.detail,
    });
    telemetry?.recordAlert("CLOUD_DEMETER_NETWORK_FAILED", {
      ...telemetryContext,
      phase: "backend_request",
      message: surfacedMessage,
      multipartProbeReachable: multipartProbe.reachable,
      multipartProbeDetail: multipartProbe.detail,
      probeReachable: probe.reachable,
      probeDetail: probe.detail,
    });
    throw new Error(surfacedMessage, { cause: error });
  }

  if (!response.ok) {
    const error = await parseBackendHttpError(response, endpointPath, "POST");
    const message = formatBackendErrorMessage(error);
    logger.error("[cloud][demeter] request failed", { status: response.status, message, endpoint });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      ...telemetryContext,
      phase: "backend_response",
      status: response.status,
      message,
    });
    telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
      ...telemetryContext,
      phase: "backend_response",
      status: response.status,
      message,
    });
    throw error;
  }

  let payload: DemeterTranscriptionResponse;
  try {
    payload = (await response.json()) as DemeterTranscriptionResponse;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[cloud][demeter] response parse failed", {
      status: response.status,
      endpoint,
      message,
    });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      ...telemetryContext,
      phase: "response_parse",
      status: response.status,
      message,
    });
    telemetry?.recordAlert("CLOUD_DEMETER_RESPONSE_PARSE_FAILED", {
      ...telemetryContext,
      phase: "response_parse",
      status: response.status,
      message,
    });
    throw error;
  }
  request.onDiarizationResolved?.({
    requestedDiarize: diarize,
    effectiveDiarize: diarize,
    fallbackApplied: false,
  });

  telemetry?.logEvent("CLOUD_UPLOAD_DONE", {
    ...telemetryContext,
    phase: "done",
  });

  return payload;
}

async function sendDemeterTranscriptionRequest(
  formData: FormData,
  signal?: AbortSignal,
  path = DEMETER_TRANSCRIPTIONS_PATH,
  timeoutMs = DEMETER_TRANSCRIPTION_REQUEST_TIMEOUT_MS,
  headers?: HeadersInit
): Promise<Response> {
  const send = () =>
    backendFetch(path, {
      method: "POST",
      body: formData,
      signal,
      timeoutMs,
      headers,
    });

  let response = await send();
  if (response.ok || response.status !== 401) {
    return response;
  }

  const unauthorizedError = await parseBackendHttpError(response, path, "POST");
  if (!isBackendUnauthorizedError(unauthorizedError)) {
    return response;
  }

  logger.warn("[cloud][demeter] unauthorized, attempting refresh before retry");
  try {
    const refreshed = await backendRefresh();
    if (!refreshed) {
      handleBackendUnauthorized(unauthorizedError);
      return response;
    }
  } catch (refreshError) {
    logger.warn("[cloud][demeter] refresh request failed", {
      message: refreshError instanceof Error ? refreshError.message : String(refreshError),
    });
    throw new Error(`Impossible de renouveler la session backend Demeter Santé. ${formatBackendErrorMessage(refreshError)}`, {
      cause: refreshError,
    });
  }

  response = await send();
  if (!response.ok && response.status === 401) {
    const retryError = await parseBackendHttpError(response, path, "POST");
    handleBackendUnauthorized(retryError);
  }
  return response;
}
