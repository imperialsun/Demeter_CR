import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";

let cachedToken: string | null = null;
let clientPromise: Promise<import("@huggingface/inference").InferenceClient> | null = null;
let modulePromise: Promise<typeof import("@huggingface/inference")> | null = null;

async function loadInferenceModule() {
  if (!modulePromise) {
    modulePromise = import("@huggingface/inference");
  }
  return modulePromise;
}

export async function getWhisperClient(token: string, telemetry?: TelemetryCollector) {
  const trimmed = token.trim();
  if (!trimmed) {
    const message = "Token Hugging Face manquant";
    logger.error("[cloud][whisper] missing token");
    telemetry?.recordAlert("CLOUD_WHISPER_TOKEN_MISSING", { message });
    throw new Error(message);
  }

  if (!clientPromise || cachedToken !== trimmed) {
    cachedToken = trimmed;
    clientPromise = (async () => {
      const { InferenceClient } = await loadInferenceModule();
      logger.info("[cloud][whisper] init client", { tokenLength: trimmed.length });
      telemetry?.logEvent("CLOUD_WHISPER_CLIENT_INIT", { tokenLength: trimmed.length });
      return new InferenceClient(trimmed);
    })();
  }

  const client = await clientPromise;
  telemetry?.logEvent("CLOUD_WHISPER_CLIENT_READY", { tokenLength: trimmed.length });
  return client;
}
