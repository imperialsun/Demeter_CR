import logger from "@/lib/logger";
import type { TelemetryCollector } from "@/lib/telemetry";
import { decodeFileFully, probeAudioMetadata, type DecodedAudio } from "@/lib/audio";
import { getFfmpeg } from "@/lib/ffmpeg-loader";

const TARGET_SAMPLE_RATE = 16000;

function isDecodeFailure(error: unknown) {
  const message = (error as Error)?.message ?? "";
  const name = (error as Error)?.name ?? "";
  return (
    name === "EncodingError" ||
    /Unable to decode audio data/i.test(message) ||
    /décodage audio/i.test(message)
  );
}

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

async function readFileBytes(file: File): Promise<Uint8Array> {
  const candidate = file as File & { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof candidate.arrayBuffer === "function") {
    return new Uint8Array(await candidate.arrayBuffer());
  }
  // Some test/runtime environments expose Blob but not File.arrayBuffer.
  const blob = file as Blob;
  const buffer = await new Response(blob).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decodeWithFfmpeg(file: File, telemetry?: TelemetryCollector): Promise<DecodedAudio> {
  telemetry?.startTimer("cloud_decode_ffmpeg");
  telemetry?.logEvent("START_DECODE", { strategy: "ffmpeg", fileName: file.name });
  const ffmpeg = await getFfmpeg();
  const sessionId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}`;
  const inputName = `cloud-input-${sessionId}.${resolveExtension(file)}`;
  const outputName = `cloud-output-${sessionId}.pcm`;
  const ffAny = ffmpeg as unknown as Record<string, unknown>;
  const hasLegacyFs = typeof ffAny["FS"] === "function" && typeof ffAny["run"] === "function";

  logger.info("[cloud][decode-ffmpeg] start", {
    inputName,
    outputName,
    sizeBytes: file.size,
  });

  let bytes: Uint8Array;
  try {
    const inputBytes = await readFileBytes(file);
    if (hasLegacyFs) {
      const ff = ffmpeg as unknown as {
        FS: (op: string, ...args: unknown[]) => unknown;
        run: (...args: string[]) => Promise<void>;
      };
      ff.FS("writeFile", inputName, inputBytes);
      await ff.run(
        "-y",
        "-i",
        inputName,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(TARGET_SAMPLE_RATE),
        "-f",
        "s16le",
        outputName
      );
      const data = ff.FS("readFile", outputName) as Uint8Array;
      bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      try {
        ff.FS("unlink", inputName);
      } catch (err) {
        void err;
      }
      try {
        ff.FS("unlink", outputName);
      } catch (err) {
        void err;
      }
    } else {
      await ffmpeg.writeFile(inputName, inputBytes);
      const exitCode = await ffmpeg.exec([
        "-y",
        "-i",
        inputName,
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(TARGET_SAMPLE_RATE),
        "-f",
        "s16le",
        outputName,
      ]);
      if (typeof exitCode === "number" && exitCode !== 0) {
        throw new Error(`ffmpeg failed with code ${exitCode}`);
      }
      const data = await ffmpeg.readFile(outputName);
      if (!(data instanceof Uint8Array)) {
        throw new Error("ffmpeg output is not binary data");
      }
      bytes = new Uint8Array(data.byteLength);
      bytes.set(data);
      try {
        await ffmpeg.deleteFile(inputName);
      } catch (err) {
        void err;
      }
      try {
        await ffmpeg.deleteFile(outputName);
      } catch (err) {
        void err;
      }
    }
  } catch (err) {
    telemetry?.logEvent("ERROR", { context: "cloud_decode_ffmpeg", message: (err as Error)?.message });
    logger.error("[cloud][decode-ffmpeg] failed", err);
    throw err;
  }

  const pcm = decodePcm16le(bytes);
  const durationSec = pcm.length / TARGET_SAMPLE_RATE;
  const metadata = await probeAudioMetadata(file);
  telemetry?.stopTimer("cloud_decode_ffmpeg");
  telemetry?.logEvent("END_DECODE", {
    strategy: "ffmpeg",
    durationSec,
    sampleRate: TARGET_SAMPLE_RATE,
  });
  logger.info("[cloud][decode-ffmpeg] done", {
    samples: pcm.length,
    durationSec,
  });
  return {
    metadata: { ...metadata, sampleRate: TARGET_SAMPLE_RATE, durationSec },
    pcm,
    sampleRate: TARGET_SAMPLE_RATE,
  };
}

export async function decodeCloudAudio(
  file: File,
  telemetry?: TelemetryCollector
): Promise<DecodedAudio> {
  try {
    return await decodeFileFully(file, telemetry, TARGET_SAMPLE_RATE);
  } catch (err) {
    if (!isDecodeFailure(err)) {
      throw err;
    }
    const message = (err as Error)?.message ?? "Erreur de décodage";
    telemetry?.recordAlert("CLOUD_DECODE_FALLBACK", {
      reason: message,
      fileName: file.name,
      sizeBytes: file.size,
    });
    logger.warn("[cloud][decode] full decode failed, using ffmpeg fallback", { message });
    return await decodeWithFfmpeg(file, telemetry);
  }
}
