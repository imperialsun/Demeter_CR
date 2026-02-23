import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";

export type MistralTranscriptionResponse = {
  text?: unknown;
  language?: unknown;
  duration?: unknown;
  segments?: unknown;
  chunks?: unknown;
  words?: unknown;
};

type MistralTranscriptionRequest = {
  apiUrl: string;
  apiKey: string;
  model: string;
  file: File;
  diarize?: boolean;
  onDiarizationResolved?: (info: {
    requestedDiarize: boolean;
    effectiveDiarize: boolean;
    fallbackApplied: boolean;
  }) => void;
  signal?: AbortSignal;
};

const DEFAULT_MISTRAL_API_URL = "https://api.mistral.ai";
export const MISTRAL_MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

type MistralFileSizeAnalysis = {
  sizeBytes: number;
  sizeMiB: number;
  maxBytes: number;
  maxMiB: number;
  usagePercent: number;
  isOverLimit: boolean;
};

function roundTo(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function buildFileSizeAnalysis(file: File): MistralFileSizeAnalysis {
  const sizeBytes = file.size;
  const maxBytes = MISTRAL_MAX_UPLOAD_BYTES;
  const sizeMiB = roundTo(sizeBytes / (1024 * 1024), 3);
  const maxMiB = roundTo(maxBytes / (1024 * 1024), 3);
  const usagePercent = maxBytes > 0 ? roundTo((sizeBytes / maxBytes) * 100, 2) : 0;
  return {
    sizeBytes,
    sizeMiB,
    maxBytes,
    maxMiB,
    usagePercent,
    isOverLimit: sizeBytes > maxBytes,
  };
}

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_MISTRAL_API_URL;
  return trimmed.replace(/\/+$/, "");
}

function formatValidationDetail(detail: unknown): string | null {
  if (typeof detail === "string") {
    const trimmed = detail.trim();
    return trimmed || null;
  }
  if (!detail || typeof detail !== "object") return null;

  const record = detail as Record<string, unknown>;
  const msg = typeof record.msg === "string" ? record.msg.trim() : "";
  const locValue = record.loc;
  const loc =
    Array.isArray(locValue) && locValue.length > 0
      ? locValue.map((part) => String(part)).join(".")
      : typeof locValue === "string" && locValue.trim()
        ? locValue.trim()
        : "";

  if (loc && msg) return `${loc}: ${msg}`;
  if (msg) return msg;

  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

function extractApiMessage(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (value == null) return null;

  if (Array.isArray(value)) {
    const chunks = value
      .map((entry) => formatValidationDetail(entry) ?? extractApiMessage(entry))
      .filter((chunk): chunk is string => Boolean(chunk && chunk.trim()));
    if (!chunks.length) return null;
    return chunks.join(" | ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const nested =
      extractApiMessage(record.message) ??
      extractApiMessage(record.error) ??
      extractApiMessage(record.detail) ??
      extractApiMessage(record.msg);
    if (nested) return nested;
    try {
      return JSON.stringify(record);
    } catch {
      return String(value);
    }
  }

  return String(value);
}

function parseApiError(raw: string): string {
  const text = raw.trim();
  if (!text) return "Réponse API vide";
  try {
    const parsed = JSON.parse(text) as unknown;
    return extractApiMessage(parsed) ?? text;
  } catch {
    return text;
  }
}

function buildFormData(request: MistralTranscriptionRequest, diarize: boolean): FormData {
  const formData = new FormData();
  formData.set("model", request.model.trim());
  formData.set("diarize", diarize ? "true" : "false");
  if (diarize) {
    // Mistral requires segment timestamps when diarization is enabled.
    formData.append("timestamp_granularities", "segment");
  }
  formData.set("file", request.file, request.file.name);
  return formData;
}

export async function transcribeWithMistral(
  request: MistralTranscriptionRequest,
  telemetry?: TelemetryCollector
): Promise<MistralTranscriptionResponse> {
  const apiKey = request.apiKey.trim();
  if (!apiKey) {
    throw new Error("Token API Mistral manquant");
  }
  const model = request.model.trim();
  if (!model) {
    throw new Error("Modèle Mistral manquant");
  }

  const baseUrl = normalizeApiUrl(request.apiUrl);
  const diarize = request.diarize ?? true;
  const endpoint = `${baseUrl}/v1/audio/transcriptions`;
  const sizeAnalysis = buildFileSizeAnalysis(request.file);

  logger.info("[cloud][mistral] upload size analysis", {
    endpoint,
    model,
    fileName: request.file.name,
    mimeType: request.file.type,
    ...sizeAnalysis,
  });
  telemetry?.logEvent("LOG_INFO", {
    context: "cloud_mistral_upload_analysis",
    endpoint,
    model,
    fileName: request.file.name,
    mimeType: request.file.type,
    ...sizeAnalysis,
  });

  if (sizeAnalysis.isOverLimit) {
    const message = `Chunk audio trop volumineux pour Mistral: ${sizeAnalysis.sizeMiB} MiB (max ${sizeAnalysis.maxMiB} MiB).`;
    logger.error("[cloud][mistral] upload rejected (size limit)", {
      endpoint,
      model,
      fileName: request.file.name,
      ...sizeAnalysis,
      message,
    });
    telemetry?.recordAlert("CLOUD_MISTRAL_FILE_TOO_LARGE", {
      endpoint,
      model,
      fileName: request.file.name,
      ...sizeAnalysis,
      message,
    });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      provider: "mistral",
      endpoint,
      model,
      fileName: request.file.name,
      ...sizeAnalysis,
      message,
    });
    throw new Error(message);
  }

  logger.info("[cloud][mistral] request", {
    endpoint,
    model,
    diarize,
    fileName: request.file.name,
    ...sizeAnalysis,
    mimeType: request.file.type,
  });

  const send = async (diarizeValue: boolean) => {
    telemetry?.logEvent("CLOUD_UPLOAD_START", {
      provider: "mistral",
      endpoint,
      model,
      diarize: diarizeValue,
      fileName: request.file.name,
      ...sizeAnalysis,
    });
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: buildFormData(request, diarizeValue),
      signal: request.signal,
    });
    return response;
  };

  let response = await send(diarize);
  let failedMessage = "";

  if (!response.ok) {
    const raw = await response.text();
    failedMessage = parseApiError(raw);

    if (response.status === 422 && diarize) {
      logger.warn("[cloud][mistral] retrying without diarization after validation error", {
        status: response.status,
        message: failedMessage,
      });
      response = await send(false);
      if (response.ok) {
        const json = (await response.json()) as MistralTranscriptionResponse;
        request.onDiarizationResolved?.({
          requestedDiarize: diarize,
          effectiveDiarize: false,
          fallbackApplied: true,
        });
        telemetry?.logEvent("CLOUD_UPLOAD_DONE", {
          provider: "mistral",
          endpoint,
          model,
          diarize: false,
          fileName: request.file.name,
          ...sizeAnalysis,
        });
        logger.info("[cloud][mistral] request done", {
          hasText: typeof json?.text === "string" && json.text.trim().length > 0,
          hasSegments: Array.isArray(json?.segments),
          diarize: false,
        });
        return json;
      }

      const retryRaw = await response.text();
      failedMessage = parseApiError(retryRaw);
    }
  }

  if (!response.ok) {
    logger.error("[cloud][mistral] request failed", {
      status: response.status,
      message: failedMessage,
      model,
      fileName: request.file.name,
      ...sizeAnalysis,
    });
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", {
      provider: "mistral",
      endpoint,
      model,
      status: response.status,
      message: failedMessage,
      fileName: request.file.name,
      ...sizeAnalysis,
    });
    telemetry?.recordAlert("CLOUD_MISTRAL_REQUEST_FAILED", {
      status: response.status,
      message: failedMessage,
    });
    throw new Error(`Mistral API (${response.status}): ${failedMessage}`);
  }

  const json = (await response.json()) as MistralTranscriptionResponse;
  request.onDiarizationResolved?.({
    requestedDiarize: diarize,
    effectiveDiarize: diarize,
    fallbackApplied: false,
  });
  telemetry?.logEvent("CLOUD_UPLOAD_DONE", {
    provider: "mistral",
    endpoint,
    model,
    diarize,
    fileName: request.file.name,
    ...sizeAnalysis,
  });
  logger.info("[cloud][mistral] request done", {
    hasText: typeof json?.text === "string" && json.text.trim().length > 0,
    hasSegments: Array.isArray(json?.segments),
    diarize,
  });
  return json;
}
