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
const DEMETER_TRANSCRIPTIONS_OPERATIONS_PATH = "/providers/demeter-sante/audio/transcriptions/operations";
const DEMETER_UPLOAD_SLICE_SIZE_BYTES = 5 * 1024 * 1024;
const DEMETER_TRANSCRIPTION_REQUEST_TIMEOUT_MS = 300_000;
const DEMETER_BACKEND_DIRECT_REQUEST_TIMEOUT_MS = 60_000;
const DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS = 15_000;
const DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS = 10_000;

export type DemeterTranscriptionChunkSegment = {
  index?: unknown;
  start?: unknown;
  end?: unknown;
  text?: unknown;
  speaker?: unknown;
  speaker_id?: unknown;
  confidence?: unknown;
  words?: unknown;
  chunkId?: unknown;
  chunk_id?: unknown;
};

export type DemeterTranscriptionChunk = {
  chunkId?: unknown;
  chunk_id?: unknown;
  index?: unknown;
  startSec?: unknown;
  start_sec?: unknown;
  endSec?: unknown;
  end_sec?: unknown;
  durationSec?: unknown;
  duration_sec?: unknown;
  segmentCount?: unknown;
  segment_count?: unknown;
  text?: unknown;
  fileName?: unknown;
  file_name?: unknown;
  mimeType?: unknown;
  mime_type?: unknown;
  sourceFormat?: unknown;
  source_format?: unknown;
  normalizedFormat?: unknown;
  normalized_format?: unknown;
  segments?: DemeterTranscriptionChunkSegment[];
};

export type DemeterTranscriptionResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  chunks?: DemeterTranscriptionChunk[];
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

function buildDemeterBackendOperationStatusPath(operationId: string): string {
  return `${DEMETER_TRANSCRIPTIONS_OPERATIONS_PATH}/${encodeURIComponent(operationId)}`;
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

function createDemeterUploadId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `demeter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildDemeterSliceHeaders(params: {
  uploadId: string;
  sliceIndex: number;
  sliceCount: number;
  final: boolean;
  audioDurationSec?: number;
}): HeadersInit {
  const headers: Record<string, string> = {
    "X-Demeter-Transport": "slice-v1",
    "X-Demeter-Upload-Id": params.uploadId,
    "X-Demeter-Upload-Index": String(params.sliceIndex),
    "X-Demeter-Upload-Count": String(params.sliceCount),
    "X-Demeter-Upload-Final": params.final ? "true" : "false",
  };
  if (typeof params.audioDurationSec === "number" && Number.isFinite(params.audioDurationSec)) {
    headers["X-Cloud-Audio-Duration-Sec"] = String(Math.max(0, params.audioDurationSec));
  }
  return headers;
}

function buildDemeterSliceFormData(request: DemeterTranscriptionRequest, slice: Blob): FormData {
  const formData = new FormData();
  const diarize = request.diarize ?? true;
  formData.set("diarize", diarize ? "true" : "false");
  if (diarize) {
    formData.append("timestamp_granularities", "segment");
  }
  if (typeof request.model === "string" && request.model.trim().length > 0) {
    formData.set("model", request.model.trim());
  }
  formData.set("file", slice, request.file.name);
  return formData;
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
  const uploadTimeoutMs = DEMETER_BACKEND_DIRECT_REQUEST_TIMEOUT_MS;
  const statusTimeoutMs = DEMETER_BACKEND_DIRECT_STATUS_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = DEMETER_BACKEND_DIRECT_STATUS_POLL_INTERVAL_MS;

  const { backendBaseUrl } = getRuntimeConfig();
  const endpoint = `${backendBaseUrl.replace(/\/+$/, "")}${endpointPath}`;
  const audioDurationSec =
    typeof request.durationSec === "number" && Number.isFinite(request.durationSec)
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
    transport: "slice-v1",
    sliceCount: Math.max(1, Math.ceil(request.file.size / DEMETER_UPLOAD_SLICE_SIZE_BYTES)),
    phase: "backend_request_start",
  });

  const uploadId = createDemeterUploadId();
  const sliceCount = Math.max(1, Math.ceil(request.file.size / DEMETER_UPLOAD_SLICE_SIZE_BYTES));
  const retryAttempts = 1;
  let operationId = uploadId;
  let operationStarted = false;

  const cancelBackendOperation = async () => {
    if (!operationStarted) {
      return;
    }
    try {
      await sendDemeterBackendOperationRequest(buildDemeterBackendOperationStatusPath(operationId), {
        method: "DELETE",
        timeoutMs: statusTimeoutMs,
      });
    } catch (cancelError) {
      logger.warn("[cloud][demeter] backend operation cancel request failed", {
        operationId,
        message: cancelError instanceof Error ? cancelError.message : String(cancelError),
      });
    }
  };

  try {
    for (let sliceIndex = 0; sliceIndex < sliceCount; sliceIndex += 1) {
      if (request.signal?.aborted) {
        await cancelBackendOperation();
        throw createAbortError();
      }

      const start = sliceIndex * DEMETER_UPLOAD_SLICE_SIZE_BYTES;
      const end = Math.min(request.file.size, start + DEMETER_UPLOAD_SLICE_SIZE_BYTES);
      const sliceBlob = request.file.slice(start, end, request.file.type || "application/octet-stream");
      const formData = buildDemeterSliceFormData(request, sliceBlob);
      const headers = buildDemeterSliceHeaders({
        uploadId,
        sliceIndex,
        sliceCount,
        final: sliceIndex === sliceCount - 1,
        audioDurationSec,
      });

      const sliceResponse = await sendDemeterTranscriptionRequest(
        formData,
        request.signal,
        endpointPath,
        uploadTimeoutMs,
        headers,
        retryAttempts
      );

      if (!sliceResponse.ok) {
        const error = await parseBackendHttpError(sliceResponse, endpointPath, "POST");
        const message = formatBackendErrorMessage(error);
        logger.error("[cloud][demeter] slice request failed", {
          status: sliceResponse.status,
          message,
          endpoint,
          uploadId,
          sliceIndex,
          sliceCount,
        });
        telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
          ...telemetryContext,
          transport: "slice-v1",
          phase: "backend_response",
          operationId,
          sliceIndex,
          sliceCount,
          status: sliceResponse.status,
          message,
        });
        telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
          ...telemetryContext,
          transport: "slice-v1",
          phase: "backend_response",
          operationId,
          sliceIndex,
          sliceCount,
          status: sliceResponse.status,
          message,
        });
        throw error;
      }

      telemetry?.logEvent("CLOUD_UPLOAD_PROGRESS", {
        ...telemetryContext,
        transport: "slice-v1",
        phase: "slice_uploaded",
        operationId,
        sliceIndex: sliceIndex + 1,
        sliceCount,
      });

      if (sliceIndex < sliceCount - 1) {
        continue;
      }

      operationStarted = true;
      let startPayload: DemeterBackendTranscriptionOperationResponse | null = null;
      try {
        startPayload = await parseBackendJson<DemeterBackendTranscriptionOperationResponse>(sliceResponse);
      } catch (parseError) {
        if (sliceResponse.status !== 204) {
          logger.warn("[cloud][demeter] backend operation start response parse failed, continuing with upload id", {
            uploadId,
            status: sliceResponse.status,
            message: parseError instanceof Error ? parseError.message : String(parseError),
          });
        }
      }

      if (startPayload) {
        const returnedOperationId = startPayload.operationId.trim();
        if (!returnedOperationId) {
          throw new Error("Réponse backend Demeter invalide: operationId manquant");
        }
        if (returnedOperationId !== uploadId) {
          throw new Error("Réponse backend Demeter incohérente: operationId différent");
        }
        operationId = returnedOperationId;
        request.onBackendOperationProgress?.(startPayload);
        telemetry?.logEvent("CLOUD_UPLOAD_PROGRESS", {
          ...telemetryContext,
          transport: "slice-v1",
          phase: "backend_operation_started",
          operationId,
          status: startPayload.status,
          stage: startPayload.stage,
          chunkIndex: startPayload.chunkIndex,
          chunkCount: startPayload.chunkCount,
          progress: startPayload.progress,
        });
      }
    }

    const operationStatusPath = buildDemeterBackendOperationStatusPath(operationId);
    await sleep(pollIntervalMs);
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
          timeoutMs: statusTimeoutMs,
        });
      } catch (pollError) {
        if (request.signal?.aborted) {
          await cancelBackendOperation();
          throw createAbortError();
        }
        if (isDemeterBackendOperationRetryableError(pollError)) {
          logger.warn("[cloud][demeter] status poll retry", {
            operationId,
            message: formatBackendErrorMessage(pollError),
          });
          await sleep(pollIntervalMs);
          continue;
        }
        throw pollError;
      }

      if (!pollResponse.ok) {
        const error = await parseBackendHttpError(pollResponse, operationStatusPath, "GET");
        if (isDemeterBackendOperationRetryableError(error)) {
          logger.warn("[cloud][demeter] status retryable response", {
            operationId,
            status: error.status,
            message: error.message,
          });
          await sleep(pollIntervalMs);
          continue;
        }
        throw error;
      }

      const snapshot = await parseBackendJson<DemeterBackendTranscriptionOperationResponse>(pollResponse);
      const returnedOperationId = snapshot.operationId?.trim();
      if (!returnedOperationId) {
        throw new Error("Réponse backend Demeter invalide: operationId manquant dans le statut");
      }
      if (returnedOperationId !== operationId) {
        throw new Error("Réponse backend Demeter incohérente: operationId différent");
      }

      request.onBackendOperationProgress?.(snapshot);
      telemetry?.logEvent("CLOUD_UPLOAD_PROGRESS", {
        ...telemetryContext,
        transport: "slice-v1",
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
            transport: "slice-v1",
            phase: "backend_operation_done",
            operationId,
            chunkCount: snapshot.chunkCount,
            chunkIndex: snapshot.chunkIndex,
            progress: snapshot.progress,
          });
          return finalResponse;
        }

        const statusCode =
          typeof snapshot.statusCode === "number" && snapshot.statusCode > 0
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

      await sleep(pollIntervalMs);
    }
  } catch (error) {
    if (request.signal?.aborted) {
      await cancelBackendOperation();
      throw createAbortError();
    }

    const message = formatBackendErrorMessage(error);
    logger.error("[cloud][demeter] request failed", {
      endpoint,
      operationId,
      message,
      transport: "slice-v1",
    });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      ...telemetryContext,
      transport: "slice-v1",
      phase: operationStarted ? "backend_operation" : "backend_request",
      operationId,
      message,
    });
    telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
      ...telemetryContext,
      transport: "slice-v1",
      phase: operationStarted ? "backend_operation" : "backend_request",
      operationId,
      message,
    });
    throw error;
  }
}

async function sendDemeterTranscriptionRequest(
  formData: FormData,
  signal?: AbortSignal,
  path = DEMETER_TRANSCRIPTIONS_PATH,
  timeoutMs = DEMETER_TRANSCRIPTION_REQUEST_TIMEOUT_MS,
  headers?: HeadersInit,
  retryAttempts = 0
): Promise<Response> {
  const send = () =>
    backendFetch(path, {
      method: "POST",
      body: formData,
      signal,
      timeoutMs,
      headers,
      retryAttempts,
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
