import { Client } from "@gradio/client";
import logger from "@/lib/logger";

const clientCache = new Map<string, Promise<Client>>();
const infoProbeCache = new Set<string>();
const INFO_SNIPPET_LIMIT = 200;

async function probeGradioInfo(url: string) {
  if (infoProbeCache.has(url)) return;
  infoProbeCache.add(url);
  try {
    const infoUrl = new URL("/gradio_api/info", url).toString();
    logger.info("[cloud] gradio info probe start", { url, infoUrl });
    const response = await fetch(infoUrl);
    const contentType = response.headers.get("content-type") ?? "unknown";
    let bodySnippet = "";
    try {
      const text = await response.text();
      bodySnippet = text.slice(0, INFO_SNIPPET_LIMIT);
    } catch (err) {
      logger.warn("[cloud] gradio info probe read failed", { url, infoUrl, error: err });
    }
    logger.info("[cloud] gradio info probe result", {
      url,
      infoUrl,
      status: response.status,
      ok: response.ok,
      contentType,
      bodySnippet,
    });
  } catch (err) {
    logger.warn("[cloud] gradio info probe failed", { url, error: err });
  }
}

export async function getGradioClient(rawUrl: string): Promise<Client> {
  const trimmed = (rawUrl ?? "").trim();
  if (!trimmed) {
    throw new Error("URL Gradio manquante");
  }
  const url = trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  let cached = clientCache.get(url);
  if (!cached) {
    logger.info("[cloud] init Gradio client", { url });
    void probeGradioInfo(url);
    cached = Client.connect(url);
    clientCache.set(url, cached);
  }
  try {
    return await cached;
  } catch (err) {
    logger.error("[cloud] Gradio client connect failed", err);
    clientCache.delete(url);
    throw err;
  }
}
