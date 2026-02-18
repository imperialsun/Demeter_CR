import logger from "@/lib/logger";

export function resolveChunkingConfig(chunkDurationSec: number, overlapSec: number) {
  const duration = Math.max(5, Math.round(chunkDurationSec || 0));
  const overlap = Math.min(Math.max(0, overlapSec || 0), Math.max(0, duration - 1));
  return { duration, overlap };
}

export function describeCloudError(err: unknown) {
  if (!err) return "Erreur inconnue";
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const message = (err as { message?: string }).message;
    if (message) return message;
    try {
      return JSON.stringify(err);
    } catch {
      return "Erreur inconnue";
    }
  }
  return String(err);
}

export async function extractSrtText(value: unknown, baseUrl: string): Promise<string | null> {
  if (!value) return null;
  if (typeof value === "string") {
    if (value.includes("-->")) return value;
    if (value.startsWith("http://") || value.startsWith("https://")) {
      logger.debug("[cloud][srt] fetch absolute url", { url: value });
      const resp = await fetch(value);
      return resp.ok ? await resp.text() : null;
    }
  }
  if (typeof value === "object") {
    const maybe = value as { url?: string; path?: string; data?: string };
    const url = maybe.url ?? maybe.path;
    if (typeof url === "string") {
      const resolved = url.startsWith("http")
        ? url
        : `${baseUrl.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
      logger.debug("[cloud][srt] fetch resolved url", { url: resolved });
      const resp = await fetch(resolved);
      return resp.ok ? await resp.text() : null;
    }
    if (maybe.data) {
      if (maybe.data.startsWith("data:")) {
        logger.debug("[cloud][srt] decode data url");
        const resp = await fetch(maybe.data);
        return resp.ok ? await resp.text() : null;
      }
      try {
        const decoded = atob(maybe.data);
        if (decoded.includes("-->")) return decoded;
      } catch (err) {
        void err;
      }
    }
  }
  return null;
}
