import { FileData, type Client } from "@gradio/client";
import type { TelemetryCollector } from "@/lib/telemetry";
import logger from "@/lib/logger";

export function makeSafeFilename(value: string) {
  const ascii = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const cleaned = ascii.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.length ? cleaned : "audio";
}

export async function uploadCloudFile({
  client,
  file,
  rootUrl,
  telemetry,
}: {
  client: Client;
  file: File;
  rootUrl: string;
  telemetry?: TelemetryCollector | null;
}) {
  const normalizedRoot = rootUrl.replace(/\/$/, "");
  telemetry?.logEvent("CLOUD_UPLOAD_START", { sizeBytes: file.size, name: file.name, type: file.type });
  telemetry?.startTimer("cloud_upload");
  try {
    const prepared = new FileData({
      path: file.name,
      orig_name: file.name,
      blob: file,
      size: file.size,
      mime_type: file.type,
    });
    const response = await client.upload([prepared], normalizedRoot);
    const uploaded = response?.[0] ?? null;
    if (!uploaded) {
      throw new Error("Upload response missing file data");
    }
    if (!uploaded.orig_name) {
      uploaded.orig_name = file.name;
    }
    if (!uploaded.mime_type) {
      uploaded.mime_type = file.type;
    }
    if (!uploaded.size) {
      uploaded.size = file.size;
    }
    telemetry?.logEvent("CLOUD_UPLOAD_DONE", { sizeBytes: file.size, name: file.name });
    logger.info("[cloud] upload complete", {
      path: uploaded.path,
      name: uploaded.orig_name ?? file.name,
      sizeBytes: uploaded.size ?? file.size,
    });
    return uploaded;
  } catch (err) {
    telemetry?.logEvent("CLOUD_UPLOAD_FAILED", { message: (err as Error)?.message });
    logger.error("[cloud] upload failed", err);
    throw err;
  } finally {
    telemetry?.stopTimer("cloud_upload");
  }
}
