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
  signal?: AbortSignal;
};

const DEFAULT_MISTRAL_API_URL = "https://api.mistral.ai";

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

  logger.info("[cloud][mistral] request", {
    endpoint,
    model,
    diarize,
    fileName: request.file.name,
    sizeBytes: request.file.size,
    mimeType: request.file.type,
  });

  const send = async (diarizeValue: boolean) => {
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
    logger.error("[cloud][mistral] request failed", { status: response.status, message: failedMessage });
    telemetry?.recordAlert("CLOUD_MISTRAL_REQUEST_FAILED", {
      status: response.status,
      message: failedMessage,
    });
    throw new Error(`Mistral API (${response.status}): ${failedMessage}`);
  }

  const json = (await response.json()) as MistralTranscriptionResponse;
  logger.info("[cloud][mistral] request done", {
    hasText: typeof json?.text === "string" && json.text.trim().length > 0,
    hasSegments: Array.isArray(json?.segments),
    diarize,
  });
  return json;
}
