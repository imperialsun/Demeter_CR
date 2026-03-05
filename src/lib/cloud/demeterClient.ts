import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import {
  backendFetch,
  formatBackendErrorMessage,
  handleBackendUnauthorized,
  parseBackendHttpError,
} from "@/lib/backend-api";

export type DemeterTranscriptionResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  chunks?: unknown;
  words?: unknown;
};

type DemeterTranscriptionRequest = {
  model: string;
  file: File;
  diarize?: boolean;
  signal?: AbortSignal;
  onDiarizationResolved?: (info: {
    requestedDiarize: boolean;
    effectiveDiarize: boolean;
    fallbackApplied: boolean;
  }) => void;
};

export async function transcribeWithDemeterSante(
  request: DemeterTranscriptionRequest,
  telemetry?: TelemetryCollector
): Promise<DemeterTranscriptionResponse> {
  const model = request.model.trim();
  if (!model) {
    throw new Error("Modèle Demeter Santé manquant");
  }

  const diarize = request.diarize ?? true;
  const formData = new FormData();
  formData.set("model", model);
  formData.set("diarize", diarize ? "true" : "false");
  if (diarize) {
    formData.append("timestamp_granularities", "segment");
  }
  formData.set("file", request.file, request.file.name);

  telemetry?.logEvent("CLOUD_UPLOAD_START", {
    provider: "demeter_sante",
    model,
    diarize,
    fileName: request.file.name,
    sizeBytes: request.file.size,
  });

  const response = await backendFetch("/providers/demeter-sante/audio/transcriptions", {
    method: "POST",
    body: formData,
    signal: request.signal,
  });

  if (!response.ok) {
    const error = await parseBackendHttpError(response, "/providers/demeter-sante/audio/transcriptions", "POST");
    handleBackendUnauthorized(error);
    const message = formatBackendErrorMessage(error);
    logger.error("[cloud][demeter] request failed", { status: response.status, message });
    telemetry?.recordAlert("CLOUD_DEMETER_REQUEST_FAILED", {
      status: response.status,
      message,
    });
    throw error;
  }

  const payload = (await response.json()) as DemeterTranscriptionResponse;
  request.onDiarizationResolved?.({
    requestedDiarize: diarize,
    effectiveDiarize: diarize,
    fallbackApplied: false,
  });

  telemetry?.logEvent("CLOUD_UPLOAD_DONE", {
    provider: "demeter_sante",
    model,
    diarize,
    fileName: request.file.name,
    sizeBytes: request.file.size,
  });

  return payload;
}
