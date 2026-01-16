import { FFmpeg } from "@ffmpeg/ffmpeg";
import logger from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";

let ffmpegPromise: Promise<FFmpeg> | null = null;
const FFMPEG_ASSETS_BASE = "/ffmpeg";

function resolveFfmpegAssetUrls() {
  const base = FFMPEG_ASSETS_BASE;
  if (typeof window === "undefined") {
    logger.warn("[ffmpeg] resolve urls without window");
  }
  return {
    coreURL: `${base}/ffmpeg-core.js`,
    wasmURL: `${base}/ffmpeg-core.wasm`,
    classWorkerURL: `${base}/ffmpeg-worker.js`,
  };
}

export async function getFfmpeg() {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg();
      const telemetry = useAsrStore.getState().telemetryCollector;
      const urls = resolveFfmpegAssetUrls();
      logger.info("[ffmpeg] load start", urls);
      telemetry?.logEvent("FFMPEG_LOAD_START", { ...urls });
      try {
        await ffmpeg.load(urls);
        logger.info("[ffmpeg] load done");
        telemetry?.logEvent("FFMPEG_LOAD_DONE");
        return ffmpeg;
      } catch (err) {
        logger.error("[ffmpeg] load failed", { err });
        telemetry?.logEvent("FFMPEG_LOAD_ERROR", {
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    })();
  }
  return ffmpegPromise;
}

export function resetFfmpeg() {
  ffmpegPromise = null;
}
