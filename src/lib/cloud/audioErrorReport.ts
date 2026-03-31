import { backendFetch, formatBackendErrorMessage, isBackendHttpError, parseBackendHttpError } from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import logger, { exportDiagnosticLogBundle } from "@/lib/logger";
import { serializePersistedSettings, useAsrStore } from "@/store/asr-store";
import type { TelemetryCollector, TelemetrySummary } from "@/lib/telemetry";

const FRONTEND_ERROR_REPORT_PATH = "/support/frontend-error-reports";

export type AudioErrorReportFile = {
  name: string;
  sizeBytes: number;
  mimeType: string;
  source: string;
};

export type AudioErrorReportRetry = {
  attempted: boolean;
  succeeded: boolean;
  usedRawFile: boolean;
};

export type AudioErrorReportBackendError = {
  status: number;
  code: string;
  message: string;
  path: string;
  method: string;
  traceId?: string;
};

export type AudioErrorReportInput = {
  provider: "whisper" | "mistral" | "demeter_sante";
  backendError: unknown | AudioErrorReportBackendError;
  originalFile: AudioErrorReportFile;
  processedFile: AudioErrorReportFile;
  rawFile?: AudioErrorReportFile | null;
  retry: AudioErrorReportRetry;
  telemetry?: TelemetryCollector | null;
  traceId?: string;
};

export type FrontendAudioErrorReportPayload = {
  traceId?: string;
  provider: AudioErrorReportInput["provider"];
  backendError: AudioErrorReportBackendError;
  originalFile: AudioErrorReportFile;
  processedFile: AudioErrorReportFile;
  rawFile?: AudioErrorReportFile | null;
  retry: AudioErrorReportRetry;
  diagnosticBundle: ReturnType<typeof exportDiagnosticLogBundle>;
};

function buildDiagnosticLogSessionSnapshot(snapshot: ReturnType<typeof useAsrStore.getState>) {
  return {
    hasHydrated: snapshot.hasHydrated,
    status: snapshot.status,
    statusDetail: snapshot.statusDetail,
    activePreset: snapshot.activePreset,
    customModelId: snapshot.customModelId,
    backendPreference: snapshot.backendPreference,
    activeBackend: snapshot.activeBackend,
    memoryMode: snapshot.memoryMode,
    segmentationMode: snapshot.segmentationMode,
    chunkStrategy: snapshot.chunkStrategy,
    preprocessingMode: snapshot.preprocessingMode,
    isTranscribing: snapshot.isTranscribing,
    progress: snapshot.progress,
    audioSource: snapshot.audioSource,
    audioMetadata: snapshot.audioMetadata,
    logLevel: snapshot.logLevel,
    webGpuSupported: snapshot.webGpuSupported,
    wasmAvailable: snapshot.wasmAvailable,
    blockedPresets: snapshot.blockedPresets,
    cloudStatus: snapshot.cloudStatus,
    cloudStatusDetail: snapshot.cloudStatusDetail,
    llmApiStatus: snapshot.llmApiStatus,
    llmApiStatusDetail: snapshot.llmApiStatusDetail,
    llmApiProvider: snapshot.llmApiProvider,
    llmLocalStatus: snapshot.llmLocalStatus,
    llmLocalStatusDetail: snapshot.llmLocalStatusDetail,
    llmLocalModelProfile: snapshot.llmLocalModelProfile,
    wasmThreads: snapshot.wasmThreads,
    telemetryCollectorActive: Boolean(snapshot.telemetryCollector),
    telemetrySummaryAvailable: Boolean(snapshot.telemetrySummary),
  };
}

function parseMistralValidationError(error: Error): AudioErrorReportBackendError | null {
  const match = error.message.match(/^Mistral API \((\d{3})\):\s*(.*)$/i);
  if (!match) {
    return null;
  }
  const status = Number.parseInt(match[1] ?? "", 10);
  const message = (match[2] ?? "").trim() || error.message;
  if (!Number.isFinite(status)) {
    return null;
  }

  const normalizedMessage = message.toLowerCase();
  const code =
    status === 400 && /audio input could not be decoded|invalid_request_file|fichier audio vide|fichier audio invalide/.test(normalizedMessage)
      ? "invalid_request_file"
      : `http_${status}`;

  return {
    status,
    code,
    message,
    path: "/v1/audio/transcriptions",
    method: "POST",
  };
}

function isAudioErrorReportBackendError(value: unknown): value is AudioErrorReportBackendError {
  return (
    Boolean(value) &&
    value !== null &&
    typeof value === "object" &&
    "status" in value &&
    "code" in value &&
    "message" in value &&
    "path" in value &&
    "method" in value
  );
}

export function describeAudioUploadError(
  error: unknown,
  fallback: { path: string; method: string; traceId?: string }
): AudioErrorReportBackendError {
  if (isBackendHttpError(error)) {
    return {
      status: error.status,
      code: error.code,
      message: formatBackendErrorMessage(error),
      path: error.path || fallback.path,
      method: error.method || fallback.method,
      traceId: error.traceId || fallback.traceId,
    };
  }

  if (error instanceof Error) {
    const mistralError = parseMistralValidationError(error);
    if (mistralError) {
      return {
        ...mistralError,
        traceId: fallback.traceId,
      };
    }
    return {
      status: 0,
      code: "audio_upload_failed",
      message: error.message,
      path: fallback.path,
      method: fallback.method,
      traceId: fallback.traceId,
    };
  }

  return {
    status: 0,
    code: "audio_upload_failed",
    message: String(error),
    path: fallback.path,
    method: fallback.method,
    traceId: fallback.traceId,
  };
}

export { shouldRetryRawAudioUpload } from "@/lib/backend-api";

async function postFrontendErrorReport(payload: FrontendAudioErrorReportPayload): Promise<void> {
  let response = await backendFetch(FRONTEND_ERROR_REPORT_PATH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    retryAttempts: 0,
  });

  if (response.status === 401) {
    logger.warn("[cloud][audio-report] report unauthorized, retrying after refresh", {
      traceId: payload.traceId,
      code: payload.backendError.code,
      status: payload.backendError.status,
    });
    const refreshed = await backendRefresh();
    if (refreshed) {
      response = await backendFetch(FRONTEND_ERROR_REPORT_PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        retryAttempts: 0,
      });
    }
  }

  if (!response.ok) {
    const error = await parseBackendHttpError(response, FRONTEND_ERROR_REPORT_PATH, "POST");
    throw error;
  }
}

export async function sendFrontendAudioErrorReport(input: AudioErrorReportInput): Promise<boolean> {
  const storeState = useAsrStore.getState();
  const telemetrySummary: TelemetrySummary | null = input.telemetry?.exportSummary() ?? null;
  const backendError = isAudioErrorReportBackendError(input.backendError)
    ? {
        ...input.backendError,
        traceId: input.traceId?.trim() || input.backendError.traceId,
      }
    : describeAudioUploadError(input.backendError, {
        path: input.provider === "demeter_sante" ? "/providers/demeter-sante/audio/transcriptions" : "/v1/audio/transcriptions",
        method: "POST",
        traceId: input.traceId,
      });
  const diagnosticBundle = exportDiagnosticLogBundle({
    session: buildDiagnosticLogSessionSnapshot(storeState),
    settings: serializePersistedSettings(storeState),
    telemetry: telemetrySummary,
  });
  const payload: FrontendAudioErrorReportPayload = {
    traceId: input.traceId?.trim() || backendError.traceId,
    provider: input.provider,
    backendError,
    originalFile: input.originalFile,
    processedFile: input.processedFile,
    rawFile: input.rawFile ?? undefined,
    retry: input.retry,
    diagnosticBundle,
  };

  try {
    await postFrontendErrorReport(payload);
    logger.info("[cloud][audio-report] report stored", {
      provider: input.provider,
      traceId: payload.traceId ?? payload.backendError.traceId ?? "-",
      code: payload.backendError.code,
      status: payload.backendError.status,
      retryAttempted: payload.retry.attempted,
      retrySucceeded: payload.retry.succeeded,
    });
    return true;
  } catch (error) {
    logger.warn("[cloud][audio-report] failed to store report", {
      provider: input.provider,
      traceId: payload.traceId ?? payload.backendError.traceId ?? "-",
      code: payload.backendError.code,
      status: payload.backendError.status,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
