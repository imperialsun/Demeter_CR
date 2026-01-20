import type { ChunkDefinition } from "@/lib/chunking";
import { TelemetryCollector } from "@/lib/telemetry";
import logger from "@/lib/logger";

export interface AudioMetadata {
  name?: string;
  durationSec: number;
  sampleRate?: number;
  channels?: number;
  sizeBytes?: number;
  mimeType?: string;
  lastModified?: number;
}

export interface DecodedAudio {
  metadata: AudioMetadata;
  pcm: Float32Array;
  sampleRate: number;
}

export interface ProgressiveSegmentDefinition {
  index: number;
  startSec: number;
  endSec: number;
}

export interface SegmentDecodeOptions {
  targetSampleRate: number;
  telemetry?: TelemetryCollector;
  signal?: AbortSignal;
  playbackRate?: number;
  requestDataTimeoutMs?: number;
  requestDataRetries?: number;
  maxPendingChunks?: number;
}

const TARGET_SAMPLE_RATE = 16000;

export async function decodeFileFully(
  file: File,
  telemetry?: TelemetryCollector,
  targetSampleRate: number = TARGET_SAMPLE_RATE
): Promise<DecodedAudio> {
  telemetry?.startTimer("decode_audio_total");
  telemetry?.logEvent("START_DECODE", {
    strategy: "full",
    fileName: file.name,
  });

  logger.info("[decode-full] read file", {
    name: file.name,
    size: file.size,
    type: file.type,
    targetSampleRate,
  });

  let arrayBuffer: ArrayBuffer | null = await file.arrayBuffer();
  const ctx = new AudioContext();
  logger.info("[decode-full] audio context created", { sampleRate: ctx.sampleRate });
  let audioBuffer: AudioBuffer | null = await ctx.decodeAudioData(arrayBuffer.slice(0));
  arrayBuffer = null;
  if (!audioBuffer) {
    throw new Error("Échec du décodage audio.");
  }
  logger.info("[decode-full] decoded buffer", {
    durationSec: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    frames: audioBuffer.length,
  });
  // Snapshot memory and estimate decoded audio size
  telemetry?.snapshotMemory("FULL_DECODE_AFTER_AUDIOBUFFER");
  logger.info("[decode-full] memory estimate (audioBuffer)", {
    frames: audioBuffer.length,
    channels: audioBuffer.numberOfChannels,
    estimatedBytes: audioBuffer.length * audioBuffer.numberOfChannels * 4,
  });
  const metadata = buildMetadata(file, audioBuffer);
  const audioBufferFrames = audioBuffer.length;
  const audioBufferChannels = audioBuffer.numberOfChannels;
  const audioBufferSampleRate = audioBuffer.sampleRate;
  let mono = mixToMono(audioBuffer);
  logger.info("[decode-full] mixed to mono", { frames: mono.length });
  const pcm = await resampleMono(mono, audioBufferSampleRate, targetSampleRate);
  mono = new Float32Array(0);
  audioBuffer = null;
  telemetry?.snapshotMemory("FULL_DECODE_AFTER_RELEASE");
  logger.info("[decode-full] released intermediate buffers");
  logger.info("[decode-full] resampled", {
    from: audioBufferSampleRate,
    to: targetSampleRate,
    frames: pcm.length,
    durationSec: pcm.length / targetSampleRate,
  });
  telemetry?.snapshotMemory("FULL_DECODE_AFTER_RESAMPLE");
  logger.info("[decode-full] memory estimate (pcm)", {
    frames: pcm.length,
    estimatedBytes: pcm.length * 4,
  });
  await ctx.close();
  logger.info("[decode-full] audio context closed");

  // Final memory snapshot and summary for full decode
  telemetry?.snapshotMemory("FULL_DECODE_END");
  telemetry?.logEvent("MEMORY_SUMMARY", {
    strategy: "full",
    estimatedAudioBufferBytes: audioBufferFrames * audioBufferChannels * 4,
    estimatedPcmBytes: pcm.length * 4,
  });

  telemetry?.stopTimer("decode_audio_total");
  telemetry?.logEvent("END_DECODE", {
    durationSec: metadata.durationSec,
    sampleRate: targetSampleRate,
  });

  return {
    metadata: { ...metadata, sampleRate: targetSampleRate },
    pcm,
    sampleRate: targetSampleRate,
  };
}

export async function decodeFileSegmentToPcm(
  file: File,
  segment: ProgressiveSegmentDefinition,
  options: SegmentDecodeOptions
): Promise<{ pcm: Float32Array; sampleRate: number; durationSec: number }> {
  if (typeof document === "undefined") {
    throw new Error("Le mode progressif nécessite un environnement navigateur.");
  }

  const targetSampleRate = options.targetSampleRate;
  const telemetry = options.telemetry;
  const segmentDurationSec = Math.max(0, segment.endSec - segment.startSec);
  const expectedSamples = Math.max(0, Math.floor(segmentDurationSec * targetSampleRate));
  if (expectedSamples === 0) {
    telemetry?.logEvent("END_DECODE", {
      strategy: "progressive_segment",
      segmentIndex: segment.index,
      samples: 0,
    });
    return { pcm: new Float32Array(0), sampleRate: targetSampleRate, durationSec: 0 };
  }

  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.muted = true;
  audio.crossOrigin = "anonymous";
  audio.playbackRate = options.playbackRate ?? 1.0;

  telemetry?.startTimer("decode_audio_segment_total");
  telemetry?.logEvent("START_DECODE", {
    strategy: "progressive_segment",
    fileName: file.name,
    segmentIndex: segment.index,
    startSec: segment.startSec,
    endSec: segment.endSec,
  });

  logger.info("[progressive-segment] start", {
    fileName: file.name,
    startSec: segment.startSec,
    endSec: segment.endSec,
    playbackRate: audio.playbackRate,
  });

  await waitForEvent(audio, "loadedmetadata");

  if (segment.startSec > 0) {
    audio.currentTime = segment.startSec;
    await waitForEvent(audio, "seeked");
  }

  const stream = (audio as HTMLMediaElement & {
    captureStream?: () => MediaStream;
  }).captureStream?.();
  if (!stream) {
    URL.revokeObjectURL(url);
    throw new Error("captureStream n'est pas supporté dans ce navigateur.");
  }

  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 128_000,
  });

  const decodeCtx = new DecodeContext("progressive-segment");
  let processingQueue: Promise<void> = Promise.resolve();
  let pendingQueueCount = 0;
  const MAX_PENDING_CHUNKS = typeof options.maxPendingChunks === "number" ? options.maxPendingChunks : 1;
  let stopped = false;
  let decodeError: unknown = null;
  let requestPending = false;
  let requestRetryCount = 0;
  let requestTimeoutId: number | null = null;
  const REQUESTDATA_TIMEOUT_MS = options.requestDataTimeoutMs ?? 2000;
  const REQUESTDATA_MAX_RETRIES = options.requestDataRetries ?? 2;

  const collected: Float32Array[] = [];
  let collectedSamples = 0;

  const clearRequestTimeout = () => {
    if (requestTimeoutId !== null) {
      clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  };

  const stopRecorder = () => {
    if (stopped) return;
    stopped = true;
    clearRequestTimeout();
    if (recorder.state !== "inactive") {
      recorder.stop();
    }
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    URL.revokeObjectURL(url);
  };

  const scheduleRequestData = () => {
    if (stopped || requestPending || recorder.state !== "recording") return;
    requestPending = true;
    requestRetryCount = 0;
    try {
      recorder.requestData();
    } catch (e) {
      logger.warn("[progressive-segment] requestData failed", e);
      requestPending = false;
      return;
    }
    requestTimeoutId = window.setTimeout(function onRequestTimeout() {
      requestRetryCount += 1;
      telemetry?.logEvent("REQUESTDATA_TIMEOUT", { tries: requestRetryCount });
      if (requestRetryCount <= REQUESTDATA_MAX_RETRIES) {
        try {
          recorder.requestData();
        } catch (e) {
          logger.warn("[progressive-segment] requestData retry failed", e);
        }
        requestTimeoutId = window.setTimeout(onRequestTimeout, REQUESTDATA_TIMEOUT_MS);
      } else {
        telemetry?.recordAlert("REQUESTDATA_FALLBACK", {
          reason: "timeout",
          requestRetries: requestRetryCount,
        });
        logger.warn("[progressive-segment] requestData timed out, stopping segment");
        requestPending = false;
        requestTimeoutId = null;
        stopRecorder();
      }
    }, REQUESTDATA_TIMEOUT_MS);
  };

  options.signal?.addEventListener("abort", () => {
    telemetry?.logEvent("STOP_REQUESTED");
    stopRecorder();
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0 || decodeError) return;
    requestPending = false;
    clearRequestTimeout();

    if (pendingQueueCount >= MAX_PENDING_CHUNKS) {
      telemetry?.logEvent("SKIP_CHUNK", { reason: "queue_full", segmentIndex: segment.index });
      logger.warn("[progressive-segment] skip chunk (queue full)", { segmentIndex: segment.index, pendingQueueCount });
      scheduleRequestData();
      return;
    }

    pendingQueueCount += 1;
    processingQueue = processingQueue.then(async () => {
      try {
        const { pcm, sampleRate } = await decodeCtx.decodeBlob(event.data, targetSampleRate);
        if (!pcm.length) {
          scheduleRequestData();
          return;
        }

        const remaining = expectedSamples - collectedSamples;
        const slice = remaining > 0 && pcm.length > remaining ? pcm.subarray(0, remaining) : pcm;
        collected.push(slice);
        collectedSamples += slice.length;

        telemetry?.logEvent("PROGRESS_SEGMENT_PCM", {
          segmentIndex: segment.index,
          samples: collectedSamples,
          expectedSamples,
          sampleRate,
        });

        if (collectedSamples >= expectedSamples) {
          stopRecorder();
          return;
        }
        scheduleRequestData();
      } catch (error) {
        decodeError = error;
        telemetry?.logEvent("ERROR", {
          scope: "progressive_segment_decode",
          message: (error as Error)?.message,
        });
        logger.error("[progressive-segment] decodeBlob failed", error);
        stopRecorder();
      } finally {
        pendingQueueCount -= 1;
      }
    });
  });

  const stopPromise = new Promise<void>((resolve) => {
    recorder.addEventListener(
      "stop",
      async () => {
        try {
          await processingQueue;
        } catch (err) {
          void err;
        }
        await decodeCtx.close();
        resolve();
      },
      { once: true }
    );
  });

  recorder.start();
  scheduleRequestData();
  await audio.play();
  audio.addEventListener(
    "ended",
    () => {
      stopRecorder();
    },
    { once: true }
  );

  await stopPromise;

  if (decodeError) {
    throw decodeError;
  }

  const pcm = concatFloat32Arrays(collected, collectedSamples);
  telemetry?.stopTimer("decode_audio_segment_total");
  telemetry?.logEvent("END_DECODE", {
    strategy: "progressive_segment",
    segmentIndex: segment.index,
    samples: pcm.length,
  });
  logger.info("[progressive-segment] done", {
    segmentIndex: segment.index,
    pcmFrames: pcm.length,
    durationSec: pcm.length / targetSampleRate,
  });

  return {
    pcm,
    sampleRate: targetSampleRate,
    durationSec: pcm.length / targetSampleRate,
  };
}

export async function decodeCompressedBlobToPcm(
  blob: Blob,
  telemetry?: TelemetryCollector,
  targetSampleRate: number = TARGET_SAMPLE_RATE
): Promise<DecodedAudio> {
  telemetry?.startTimer("decode_audio_total");
  telemetry?.logEvent("START_DECODE", { strategy: "segment_blob" });

  let arrayBuffer: ArrayBuffer | null = await blob.arrayBuffer();
  const ctx = new AudioContext();
  logger.info("[decode-blob] audio context created", { sampleRate: ctx.sampleRate });
  let audioBuffer: AudioBuffer | null = await ctx.decodeAudioData(arrayBuffer.slice(0));
  arrayBuffer = null;
  if (!audioBuffer) {
    throw new Error("Échec du décodage du segment.");
  }

  const metadata: AudioMetadata = {
    durationSec: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
  };
  const audioBufferSampleRate = audioBuffer.sampleRate;
  let mono = mixToMono(audioBuffer);
  const pcm = await resampleMono(mono, audioBufferSampleRate, targetSampleRate);
  mono = new Float32Array(0);
  audioBuffer = null;
  telemetry?.snapshotMemory("SEGMENT_DECODE_AFTER_RELEASE");
  logger.info("[decode-blob] released intermediate buffers");
  await ctx.close();

  telemetry?.stopTimer("decode_audio_total");
  telemetry?.logEvent("END_DECODE", { strategy: "segment_blob", sampleRate: targetSampleRate });

  return {
    metadata: { ...metadata, sampleRate: targetSampleRate },
    pcm,
    sampleRate: targetSampleRate,
  };
}

export async function probeAudioMetadata(file: File): Promise<AudioMetadata> {
  if (typeof document === "undefined") {
    return {
      name: file.name,
      durationSec: 0,
      sizeBytes: file.size,
      mimeType: file.type,
      lastModified: file.lastModified,
    };
  }
  const url = URL.createObjectURL(file);
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = url;
  await waitForEvent(audio, "loadedmetadata");

  // Avoid decoding full files here to prevent large memory spikes during import.
  const sampleRate: number | undefined = undefined;

  const metadata: AudioMetadata = {
    name: file.name,
    durationSec: Number.isFinite(audio.duration) ? audio.duration : 0,
    sizeBytes: file.size,
    mimeType: file.type,
    lastModified: file.lastModified,
    sampleRate: sampleRate,
  };
  URL.revokeObjectURL(url);
  return metadata;
}

export function mixToMono(buffer: AudioBuffer): Float32Array {
  const channelCount = buffer.numberOfChannels;
  const length = buffer.length;
  const temp = new Float32Array(length);
  for (let channel = 0; channel < channelCount; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      temp[i] += channelData[i]! / channelCount;
    }
  }
  return temp;
}

export async function resampleMono(
  mono: Float32Array,
  fromSampleRate: number,
  toSampleRate: number
): Promise<Float32Array> {
  if (fromSampleRate === toSampleRate) {
    return mono;
  }
  // In some environments (tests, older browsers) OfflineAudioContext may be missing.
  // Fall back to a simple linear resampler rather than crashing.
  if (typeof (globalThis as unknown as { OfflineAudioContext?: unknown }).OfflineAudioContext !== "function") {
    const ratio = toSampleRate / fromSampleRate;
    const newLength = Math.max(0, Math.round(mono.length * ratio));
    const out = new Float32Array(newLength);
    for (let i = 0; i < newLength; i += 1) {
      const src = i / ratio;
      const i0 = Math.floor(src);
      const i1 = Math.min(mono.length - 1, i0 + 1);
      const frac = src - i0;
      const s0 = mono[i0] ?? 0;
      const s1 = mono[i1] ?? s0;
      out[i] = s0 + (s1 - s0) * frac;
    }
    return out;
  }
  const durationSec = mono.length / fromSampleRate;
  const frameCount = Math.ceil(durationSec * toSampleRate);
  const offline = new OfflineAudioContext(1, frameCount, toSampleRate);
  const buffer = offline.createBuffer(1, mono.length, fromSampleRate);
  buffer.getChannelData(0).set(mono);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const resampled = new Float32Array(rendered.length);
  rendered.copyFromChannel(resampled, 0);
  return resampled;
}

export function extractChunkPcm(
  pcm: Float32Array,
  sampleRate: number,
  chunk: ChunkDefinition
): Float32Array {
  const startSample = Math.floor(chunk.paddedStart * sampleRate);
  const endSample = Math.min(pcm.length, Math.ceil(chunk.paddedEnd * sampleRate));
  return pcm.slice(startSample, endSample);
}

function buildMetadata(file: File, buffer: AudioBuffer): AudioMetadata {
  return {
    name: file.name,
    durationSec: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    sizeBytes: file.size,
    mimeType: file.type,
    lastModified: file.lastModified,
  };
}

function concatFloat32Arrays(chunks: Float32Array[], totalLength: number) {
  const result = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function waitForEvent(target: EventTarget, type: string) {
  await new Promise<void>((resolve, reject) => {
    const onError = (event: Event) => {
      target.removeEventListener(type, onLoaded);
      reject(event);
    };
    const onLoaded = () => {
      target.removeEventListener("error", onError);
      resolve();
    };
    target.addEventListener(type, onLoaded, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

class DecodeContext {
  private ctx: AudioContext | null = null;
  private headerBlob: Blob | null = null;
  private processedSamples = 0;
  private readonly logPrefix: string;

  constructor(label: string = "progressive") {
    this.logPrefix = `[${label}]`;
  }

  private async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      logger.info(`${this.logPrefix} create decode context`, { sampleRate: this.ctx.sampleRate });
    }
    return this.ctx;
  }

  async decodeBlob(blob: Blob, targetSampleRate: number) {
    // Some browsers emit MediaRecorder chunks without container headers after the first one.
    // We keep the first blob as a header and prepend it to subsequent chunks so decodeAudioData
    // always receives a decodable container.
    if (!this.headerBlob) {
      this.headerBlob = blob;
      logger.info(`${this.logPrefix} captured header blob`, { size: blob.size, type: blob.type });
    }

    const containerBlob = blob === this.headerBlob ? blob : new Blob([this.headerBlob, blob], { type: blob.type });
    logger.info(`${this.logPrefix} decoding blob`, {
      inputSize: blob.size,
      containerSize: containerBlob.size,
    });
    const arrayBuffer = await containerBlob.arrayBuffer();
    const ctx = await this.ensureContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const mono = mixToMono(buffer);
    logger.info(`${this.logPrefix} decoded buffer`, {
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      frames: buffer.length,
      monoFrames: mono.length,
    });
    const newSamples = mono.length - this.processedSamples;
    if (newSamples <= 0) {
      logger.info(`${this.logPrefix} no new samples`, {
        processedSamples: this.processedSamples,
        monoFrames: mono.length,
        inputSize: blob.size,
        containerSize: containerBlob.size,
      });
      return { pcm: new Float32Array(0), sampleRate: targetSampleRate };
    }

    const delta = mono.slice(this.processedSamples);
    this.processedSamples = mono.length;

    // Keep the header blob cumulative so subsequent container blobs grow and
    // decodeAudioData receives increasing audio content rather than repeating
    // the same header + old delta.
    this.headerBlob = containerBlob;
    logger.info(`${this.logPrefix} updated header blob`, { headerSize: this.headerBlob?.size });

    const pcm = await resampleMono(delta, buffer.sampleRate, targetSampleRate);
    logger.info(`${this.logPrefix} resampled delta`, {
      from: buffer.sampleRate,
      to: targetSampleRate,
      deltaFrames: delta.length,
      pcmFrames: pcm.length,
      durationSec: pcm.length / targetSampleRate,
    });
    return { pcm, sampleRate: targetSampleRate };
  }

  getProcessedSamples() {
    return this.processedSamples;
  }

  getHeaderSize() {
    return this.headerBlob?.size ?? 0;
  }

  async close() {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
    }
    logger.info(`${this.logPrefix} decode context closed`, {
      processedSamples: this.processedSamples,
    });
    this.headerBlob = null;
    this.processedSamples = 0;
  }
}
