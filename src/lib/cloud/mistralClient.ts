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
  signal?: AbortSignal;
};

const DEFAULT_MISTRAL_API_URL = "https://api.mistral.ai";

function normalizeApiUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_MISTRAL_API_URL;
  return trimmed.replace(/\/+$/, "");
}

function parseApiError(raw: string): string {
  const text = raw.trim();
  if (!text) return "Réponse API vide";
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } };
    return parsed?.message ?? parsed?.error?.message ?? text;
  } catch {
    return text;
  }
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
  const endpoint = `${baseUrl}/v1/audio/transcriptions`;
  const formData = new FormData();
  formData.set("model", model);
  formData.set("file", request.file, request.file.name);

  logger.info("[cloud][mistral] request", {
    endpoint,
    model,
    fileName: request.file.name,
    sizeBytes: request.file.size,
    mimeType: request.file.type,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: request.signal,
  });

  if (!response.ok) {
    const raw = await response.text();
    const message = parseApiError(raw);
    logger.error("[cloud][mistral] request failed", { status: response.status, message });
    telemetry?.recordAlert("CLOUD_MISTRAL_REQUEST_FAILED", {
      status: response.status,
      message,
    });
    throw new Error(`Mistral API (${response.status}): ${message}`);
  }

  const json = (await response.json()) as MistralTranscriptionResponse;
  logger.info("[cloud][mistral] request done", {
    hasText: typeof json?.text === "string" && json.text.trim().length > 0,
    hasSegments: Array.isArray(json?.segments),
  });
  return json;
}

