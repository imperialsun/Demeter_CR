import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { getRuntimeConfig } from "@/lib/runtime-config";
import {
  backendFetch,
  formatBackendErrorMessage,
  handleBackendUnauthorized,
  parseBackendHttpError,
} from "@/lib/backend-api";

const DEMETER_TRANSCRIPTIONS_PATH = "/providers/demeter-sante/audio/transcriptions";
const DEMETER_MODELS_PATH = "/providers/demeter-sante/models";
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

async function probeDemeterBackendReachability(
  telemetryContext: Record<string, unknown>,
  telemetry?: TelemetryCollector
): Promise<{ reachable: boolean; detail: string }> {
  try {
    const response = await backendFetch(DEMETER_MODELS_PATH, { method: "GET" });
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
  model: string,
  telemetryContext: Record<string, unknown>,
  telemetry?: TelemetryCollector
): Promise<{ reachable: boolean; detail: string }> {
  const probeFormData = new FormData();
  probeFormData.set("model", model);
  probeFormData.set("diarize", "false");
  probeFormData.set("file", new File([new Uint8Array([0])], "demeter-probe.wav", { type: "audio/wav" }));

  try {
    const response = await backendFetch(DEMETER_TRANSCRIPTIONS_PATH, {
      method: "POST",
      body: probeFormData,
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

  const { backendBaseUrl } = getRuntimeConfig();
  const endpoint = `${backendBaseUrl.replace(/\/+$/, "")}${DEMETER_TRANSCRIPTIONS_PATH}`;
  const telemetryContext = {
    provider: "demeter_sante",
    model,
    diarize,
    fileName: request.file.name,
    sizeBytes: request.file.size,
    backendBaseUrl,
    endpointPath: DEMETER_TRANSCRIPTIONS_PATH,
    endpoint,
  };

  telemetry?.logEvent("CLOUD_UPLOAD_START", {
    ...telemetryContext,
    phase: "backend_request_start",
  });

  let response: Response;
  try {
    response = await backendFetch(DEMETER_TRANSCRIPTIONS_PATH, {
      method: "POST",
      body: formData,
      signal: request.signal,
    });
  } catch (error) {
    const message = formatBackendErrorMessage(error);
    const multipartProbe = await probeDemeterMultipartReachability(model, telemetryContext, telemetry);
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
    throw new Error(surfacedMessage);
  }

  if (!response.ok) {
    const error = await parseBackendHttpError(response, DEMETER_TRANSCRIPTIONS_PATH, "POST");
    handleBackendUnauthorized(error);
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
