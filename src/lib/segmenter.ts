import { FFFSType } from "@ffmpeg/ffmpeg";
import logger from "@/lib/logger";
import type { ChunkDefinition } from "@/lib/chunking";
import type { TelemetryCollector } from "@/lib/telemetry";
import { getFfmpeg, resetFfmpeg } from "@/lib/ffmpeg-loader";
import { putSegment } from "@/lib/segment-cache";

export interface SegmentingOptions {
  sessionId: string;
  segments: ChunkDefinition[];
  telemetry?: TelemetryCollector;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

function getSegmentExtension(file: File): string {
  const name = file.name || "";
  const dot = name.lastIndexOf(".");
  if (dot > -1 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase();
  }
  switch (file.type) {
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
      return "webm";
  }
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

export async function createSegmentCache(file: File, options: SegmentingOptions): Promise<void> {
  const { sessionId, segments, telemetry, signal, onProgress } = options;
  const ffmpeg = await getFfmpeg();
  const inputDir = "/input";
  const outputDir = "/output";
  const inputName = file.name || "input";
  const inputPath = `${inputDir}/${inputName}`;
  const outputExt = getSegmentExtension(file);
  const copyFormat = getCopyFormat(outputExt);
  const outputMimeType = getSegmentMimeType(outputExt);

  logger.info("[segmenter] mount input", { inputName, totalSegments: segments.length });
  telemetry?.logEvent("SEGMENT_CACHE_START", { segments: segments.length });

  try {
    await ffmpeg.createDir(inputDir);
  } catch (err) {
    logger.warn("[segmenter] input dir exists", err);
  }
  try {
    await ffmpeg.createDir(outputDir);
  } catch (err) {
    logger.warn("[segmenter] output dir exists", err);
  }
  await ffmpeg.mount(FFFSType.WORKERFS, { files: [file] }, inputDir);

  try {
    for (let i = 0; i < segments.length; i += 1) {
      if (signal?.aborted) {
        telemetry?.logEvent("STOP_REQUESTED");
        break;
      }
      const segment = segments[i]!;
      const outputName = `segment_${segment.index}.${outputExt}`;
      const outputPath = `${outputDir}/${outputName}`;
      const duration = Math.max(0, segment.end - segment.start);

      const argsCopy = [
        "-ss", String(segment.start),
        "-t", String(duration),
        "-i", inputPath,
        "-vn",
        "-c", "copy",
      ];
      if (copyFormat) {
        argsCopy.push("-f", copyFormat);
      }
      argsCopy.push(outputPath);

      logger.info("[segmenter] exec", { mode: "copy", segmentIndex: segment.index, startSec: segment.start, endSec: segment.end });
      let exitCode = await ffmpeg.exec(argsCopy, undefined, { signal });
      if (exitCode !== 0) {
        logger.warn("[segmenter] copy failed, falling back to opus", { segmentIndex: segment.index, exitCode });
        try {
          await ffmpeg.deleteFile(outputPath);
        } catch (err) {
          logger.warn("[segmenter] delete output before fallback failed", err);
        }
        const fallbackPath = `${outputDir}/segment_${segment.index}.webm`;
        const argsFallback = [
          "-ss", String(segment.start),
          "-t", String(duration),
          "-i", inputPath,
          "-vn",
          "-c:a", "libopus",
          "-b:a", "64k",
          "-f", "webm",
          fallbackPath,
        ];
        logger.info("[segmenter] exec", { mode: "opus", segmentIndex: segment.index, startSec: segment.start, endSec: segment.end });
        exitCode = await ffmpeg.exec(argsFallback, undefined, { signal });
        if (exitCode !== 0) {
          throw new Error(`ffmpeg failed with code ${exitCode}`);
        }
        const data = await ffmpeg.readFile(fallbackPath);
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
        const blob = new Blob([bytes], { type: "audio/webm;codecs=opus" });
        await putSegment({
          key: `${sessionId}:${segment.index}`,
          sessionId,
          index: segment.index,
          startSec: segment.start,
          endSec: segment.end,
          blob,
        });
        await ffmpeg.deleteFile(fallbackPath);
      } else {
        const data = await ffmpeg.readFile(outputPath);
        const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
        const blob = new Blob([bytes], { type: outputMimeType });
        await putSegment({
          key: `${sessionId}:${segment.index}`,
          sessionId,
          index: segment.index,
          startSec: segment.start,
          endSec: segment.end,
          blob,
        });
        await ffmpeg.deleteFile(outputPath);
      }

      const completed = i + 1;
      onProgress?.(completed, segments.length);
      telemetry?.logEvent("SEGMENT_CACHE_PROGRESS", { completed, total: segments.length });
    }
  } finally {
    try {
      await ffmpeg.unmount(inputDir);
    } catch (err) {
      logger.warn("[segmenter] unmount failed", err);
    }
    try {
      await ffmpeg.deleteDir(inputDir);
    } catch (err) {
      logger.warn("[segmenter] delete input dir failed", err);
    }
    try {
      const entries = await ffmpeg.listDir(outputDir);
      for (const entry of entries) {
        if (entry.isDir || entry.name === "." || entry.name === "..") continue;
        try {
          await ffmpeg.deleteFile(`${outputDir}/${entry.name}`);
        } catch (deleteErr) {
          logger.warn("[segmenter] delete output file failed", { name: entry.name, deleteErr });
        }
      }
      await ffmpeg.deleteDir(outputDir);
    } catch (err) {
      logger.warn("[segmenter] delete output dir failed", err);
    }
    try {
      ffmpeg.terminate();
      resetFfmpeg();
      logger.info("[segmenter] ffmpeg terminated");
    } catch (err) {
      logger.warn("[segmenter] ffmpeg terminate failed", err);
    }
    telemetry?.logEvent("SEGMENT_CACHE_DONE", { segments: segments.length });
    logger.info("[segmenter] done", { segments: segments.length });
  }
}
