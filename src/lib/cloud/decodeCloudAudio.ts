import { FFFSType } from "@ffmpeg/ffmpeg";
import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { decodeFileFully, probeAudioMetadata, type DecodedAudio } from "@/lib/audio";
import { getFfmpeg } from "@/lib/ffmpeg-loader";

const TARGET_SAMPLE_RATE = 16000;

function resolveExtension(file: File) {
  const name = file.name ?? "";
  const dot = name.lastIndexOf(".");
  if (dot > -1 && dot < name.length - 1) {
    return name.slice(dot + 1).toLowerCase();
  }
  const type = file.type;
  if (type === "audio/mpeg") return "mp3";
  if (type === "audio/mp4" || type === "audio/x-m4a") return "m4a";
  if (type === "audio/aac") return "aac";
  if (type === "audio/ogg") return "ogg";
  if (type === "audio/webm") return "webm";
  if (type === "audio/wav" || type === "audio/x-wav") return "wav";
  return "audio";
}

function decodePcm16le(bytes: Uint8Array): Float32Array {
  const sampleCount = Math.floor(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pcm = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm[i] = view.getInt16(i * 2, true) / 32768;
  }
  return pcm;
}

function normalizeFfmpegOutput(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (typeof data === "object" && data !== null && data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  throw new Error("ffmpeg output is not binary data");
}

async function decodeWithMountedFfmpeg(file: File, telemetry?: TelemetryCollector): Promise<DecodedAudio> {
  telemetry?.startTimer("cloud_decode_ffmpeg");
  telemetry?.logEvent("START_DECODE", { strategy: "ffmpeg", fileName: file.name });
  const ffmpeg = await getFfmpeg();
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  const inputName = `cloud-input-${sessionId}.${resolveExtension(file)}`;
  const outputName = `cloud-output-${sessionId}.pcm`;
  const inputDir = `/cloud-input-${sessionId}`;
  const outputDir = `/cloud-output-${sessionId}`;
  const inputPath = `${inputDir}/${inputName}`;
  const outputPath = `${outputDir}/${outputName}`;
  const workerFsType =
    ((FFFSType as unknown as { WORKERFS?: string } | undefined)?.WORKERFS ?? "WORKERFS") as unknown as FFFSType;

  logger.debug("[cloud][decode-ffmpeg] start", {
    inputName,
    outputName,
    sizeBytes: file.size,
  });

  let mounted = false;

  try {
    try {
      await ffmpeg.createDir(inputDir);
    } catch (err) {
      logger.warn("[cloud][decode-ffmpeg] input dir exists", err);
    }
    try {
      await ffmpeg.createDir(outputDir);
    } catch (err) {
      logger.warn("[cloud][decode-ffmpeg] output dir exists", err);
    }

    if (typeof ffmpeg.mount !== "function" || typeof ffmpeg.unmount !== "function" || typeof ffmpeg.deleteDir !== "function") {
      throw new Error("ffmpeg WorkerFS is unavailable");
    }

    await ffmpeg.mount(workerFsType, { files: [file] }, inputDir);
    mounted = true;

    const exitCode = await ffmpeg.exec([
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(TARGET_SAMPLE_RATE),
      "-f",
      "s16le",
      outputPath,
    ]);
    if (typeof exitCode === "number" && exitCode !== 0) {
      throw new Error(`ffmpeg failed with code ${exitCode}`);
    }

    const data = await ffmpeg.readFile(outputPath);
    const bytes = normalizeFfmpegOutput(data);
    const pcm = decodePcm16le(bytes);
    const durationSec = pcm.length / TARGET_SAMPLE_RATE;
    const metadata = await probeAudioMetadata(file);

    telemetry?.logEvent("END_DECODE", {
      strategy: "ffmpeg",
      durationSec,
      sampleRate: TARGET_SAMPLE_RATE,
    });
    logger.debug("[cloud][decode-ffmpeg] done", {
      samples: pcm.length,
      durationSec,
    });

    bytes.fill(0);
    return {
      metadata: { ...metadata, sampleRate: TARGET_SAMPLE_RATE, durationSec },
      pcm,
      sampleRate: TARGET_SAMPLE_RATE,
    };
  } catch (err) {
    telemetry?.logEvent("ERROR", { context: "cloud_decode_ffmpeg", message: (err as Error)?.message });
    logger.error("[cloud][decode-ffmpeg] failed", err);
    throw err;
  } finally {
    telemetry?.stopTimer("cloud_decode_ffmpeg");
    if (mounted) {
      try {
        await ffmpeg.unmount(inputDir);
      } catch (err) {
        logger.warn("[cloud][decode-ffmpeg] unmount failed", err);
      }
    }
    try {
      await ffmpeg.deleteDir(inputDir);
    } catch (err) {
      logger.warn("[cloud][decode-ffmpeg] delete input dir failed", err);
    }
    try {
      await ffmpeg.deleteFile(outputPath);
    } catch (err) {
      logger.warn("[cloud][decode-ffmpeg] delete output failed", err);
    }
    try {
      await ffmpeg.deleteDir(outputDir);
    } catch (err) {
      logger.warn("[cloud][decode-ffmpeg] delete output dir failed", err);
    }
  }
}

export async function decodeCloudAudio(file: File, telemetry?: TelemetryCollector): Promise<DecodedAudio> {
  try {
    return await decodeWithMountedFfmpeg(file, telemetry);
  } catch (err) {
    if ((err as DOMException)?.name === "AbortError") {
      throw err;
    }
    const message = (err as Error)?.message ?? "Erreur de décodage";
    telemetry?.recordAlert("CLOUD_DECODE_FALLBACK", {
      strategy: "ffmpeg",
      reason: message,
      fileName: file.name,
      sizeBytes: file.size,
    });
    logger.warn("[cloud][decode] ffmpeg decode failed, using AudioContext fallback", { message });
    return await decodeFileFully(file, telemetry, TARGET_SAMPLE_RATE);
  }
}
