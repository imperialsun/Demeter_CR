import { FFFSType } from "@ffmpeg/ffmpeg";
import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { getFfmpeg } from "@/lib/ffmpeg-loader";

export type AudioSegment = {
  index: number;
  startSec: number;
  endSec: number;
};

function getExtensionFromMime(type: string): string | undefined {
  switch (type) {
    case "audio/mpeg":
      return "mp3";
    case "audio/mp4":
    case "audio/x-m4a":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "audio/ogg":
      return "ogg";
    default:
      return undefined;
  }
}

function getSegmentExtension(file: File): string {
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  const nameExt = dot > -1 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : undefined;
  const mimeExt = getExtensionFromMime(file.type);
  if (mimeExt && nameExt && mimeExt !== nameExt) {
    logger.warn("[cloud][segment] extension mismatch", { nameExt, mimeExt, fileType: file.type });
  }
  return mimeExt ?? nameExt ?? "webm";
}

function getSegmentMimeType(ext: string): string {
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm;codecs=opus";
    case "ogg":
      return "audio/ogg";
    default:
      return "audio/webm;codecs=opus";
  }
}

function getCopyFormat(ext: string): string | null {
  switch (ext) {
    case "mp3":
      return "mp3";
    case "m4a":
    case "mp4":
      return "mp4";
    case "aac":
      return "adts";
    case "wav":
      return "wav";
    case "webm":
      return "webm";
    case "ogg":
      return "ogg";
    default:
      return null;
  }
}

export async function extractSegmentBlob(
  file: File,
  segment: AudioSegment,
  telemetry?: TelemetryCollector
): Promise<{ blob: Blob; mimeType: string; name: string }> {
  const ffmpeg = await getFfmpeg();
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  const inputDir = `/cloud-input-${sessionId}`;
  const outputDir = `/cloud-output-${sessionId}`;
  const inputName = file.name || `input-${sessionId}`;
  const inputPath = `${inputDir}/${inputName}`;
  const outputExt = getSegmentExtension(file);
  const copyFormat = getCopyFormat(outputExt);
  const outputMimeType = getSegmentMimeType(outputExt);
  const outputName = `segment_${segment.index}.${outputExt}`;
  const outputPath = `${outputDir}/${outputName}`;
  const duration = Math.max(0, segment.endSec - segment.startSec);

  telemetry?.logEvent("START_DECODE", { strategy: "cloud_segment", segmentIndex: segment.index });
  logger.info("[cloud][segment] extract start", {
    segmentIndex: segment.index,
    startSec: segment.startSec,
    endSec: segment.endSec,
    outputExt,
  });

  try {
    await ffmpeg.createDir(inputDir);
  } catch (err) {
    logger.warn("[cloud][segment] input dir exists", err);
  }
  try {
    await ffmpeg.createDir(outputDir);
  } catch (err) {
    logger.warn("[cloud][segment] output dir exists", err);
  }

  const workerFsType =
    ((FFFSType as unknown as { WORKERFS?: string } | undefined)?.WORKERFS ??
      "WORKERFS") as unknown as FFFSType;
  await ffmpeg.mount(workerFsType, { files: [file] }, inputDir);

  let blob: Blob;
  try {
    const argsCopy = [
      "-ss", String(segment.startSec),
      "-t", String(duration),
      "-i", inputPath,
      "-vn",
      "-c", "copy",
    ];
    if (copyFormat) {
      argsCopy.push("-f", copyFormat);
    }
    argsCopy.push(outputPath);

    logger.info("[cloud][segment] exec", { mode: "copy", segmentIndex: segment.index });
    let exitCode = await ffmpeg.exec(argsCopy, undefined, { signal: undefined });
    let finalMime = outputMimeType;
    let finalPath = outputPath;
    let finalName = outputName;

    if (exitCode !== 0) {
      logger.warn("[cloud][segment] copy failed, fallback to opus", { segmentIndex: segment.index, exitCode });
      telemetry?.recordAlert("CLOUD_SEGMENT_FALLBACK", {
        segmentIndex: segment.index,
        reason: "copy_failed",
        exitCode,
      });
      try {
        await ffmpeg.deleteFile(outputPath);
      } catch (err) {
        logger.warn("[cloud][segment] delete copy output failed", err);
      }
      const fallbackName = `segment_${segment.index}.webm`;
      const fallbackPath = `${outputDir}/${fallbackName}`;
      const argsFallback = [
        "-ss", String(segment.startSec),
        "-t", String(duration),
        "-i", inputPath,
        "-vn",
        "-c:a", "libopus",
        "-b:a", "64k",
        "-f", "webm",
        fallbackPath,
      ];
      logger.info("[cloud][segment] exec", { mode: "opus", segmentIndex: segment.index });
      exitCode = await ffmpeg.exec(argsFallback, undefined, { signal: undefined });
      if (exitCode !== 0) {
        throw new Error(`ffmpeg failed with code ${exitCode}`);
      }
      finalMime = "audio/webm;codecs=opus";
      finalPath = fallbackPath;
      finalName = fallbackName;
    }

    const data = await ffmpeg.readFile(finalPath);
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
    blob = new Blob([bytes], { type: finalMime });

    try {
      await ffmpeg.deleteFile(finalPath);
    } catch (err) {
      logger.warn("[cloud][segment] delete output failed", err);
    }

    telemetry?.logEvent("END_DECODE", { strategy: "cloud_segment", segmentIndex: segment.index });
    logger.info("[cloud][segment] extract done", {
      segmentIndex: segment.index,
      sizeBytes: blob.size,
      mimeType: finalMime,
    });
    return { blob, mimeType: finalMime, name: finalName };
  } finally {
    try {
      await ffmpeg.unmount(inputDir);
    } catch (err) {
      logger.warn("[cloud][segment] unmount failed", err);
    }
    try {
      await ffmpeg.deleteDir(inputDir);
    } catch (err) {
      logger.warn("[cloud][segment] delete input dir failed", err);
    }
    try {
      await ffmpeg.deleteDir(outputDir);
    } catch (err) {
      logger.warn("[cloud][segment] delete output dir failed", err);
    }
  }
}
