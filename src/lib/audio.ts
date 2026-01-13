import type { ChunkDefinition } from "@/lib/chunking";
import { TelemetryCollector } from "@/lib/telemetry";

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

export interface ProgressiveChunkResult {
  index: number;
  startSec: number;
  endSec: number;
  pcm: Float32Array;
  sampleRate: number;
}

export interface ProgressiveDecodeOptions {
  chunkPlan: ChunkDefinition[];
  targetSampleRate: number;
  telemetry?: TelemetryCollector;
  signal?: AbortSignal;
  onChunk: (chunk: ProgressiveChunkResult) => Promise<void> | void;
  onProgress?: (progress: number) => void;

  // Manual requestData mode (strict serial): when true, recorder.requestData() is used
  // to request the next chunk only after the previous one has been processed.
  // Default: true (strict serial)
  manualRequestChunks?: boolean;
  // Timeout for requestData in ms before retrying
  requestDataTimeoutMs?: number;
  // Number of retries for requestData before falling back
  requestDataRetries?: number;
  // Max pending chunks allowed (safety); defaults to 1 in manual mode
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

  import("@/lib/logger").then(({ info }) => info("[decode-full] read file", {
    name: file.name,
    size: file.size,
    type: file.type,
    targetSampleRate,
  }));

  const arrayBuffer = await file.arrayBuffer();
  const ctx = new AudioContext();
  import("@/lib/logger").then(({ info }) => info("[decode-full] audio context created", { sampleRate: ctx.sampleRate }));
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  import("@/lib/logger").then(({ info }) => info("[decode-full] decoded buffer", {
    durationSec: audioBuffer.duration,
    sampleRate: audioBuffer.sampleRate,
    channels: audioBuffer.numberOfChannels,
    frames: audioBuffer.length,
  }));
  // Snapshot memory and estimate decoded audio size
  telemetry?.snapshotMemory("FULL_DECODE_AFTER_AUDIOBUFFER");
  import("@/lib/logger").then(({ info }) => info("[decode-full] memory estimate (audioBuffer)", {
    frames: audioBuffer.length,
    channels: audioBuffer.numberOfChannels,
    estimatedBytes: audioBuffer.length * audioBuffer.numberOfChannels * 4,
  }));
  const metadata = buildMetadata(file, audioBuffer);
  const mono = mixToMono(audioBuffer);
  import("@/lib/logger").then(({ info }) => info("[decode-full] mixed to mono", { frames: mono.length }));
  const pcm = await resampleMono(mono, audioBuffer.sampleRate, targetSampleRate);
  import("@/lib/logger").then(({ info }) => info("[decode-full] resampled", {
    from: audioBuffer.sampleRate,
    to: targetSampleRate,
    frames: pcm.length,
    durationSec: pcm.length / targetSampleRate,
  }));
  telemetry?.snapshotMemory("FULL_DECODE_AFTER_RESAMPLE");
  import("@/lib/logger").then(({ info }) => info("[decode-full] memory estimate (pcm)", {
    frames: pcm.length,
    estimatedBytes: pcm.length * 4,
  }));
  await ctx.close();
  import("@/lib/logger").then(({ info }) => info("[decode-full] audio context closed"));

  // Final memory snapshot and summary for full decode
  telemetry?.snapshotMemory("FULL_DECODE_END");
  telemetry?.logEvent("MEMORY_SUMMARY", {
    strategy: "full",
    estimatedAudioBufferBytes: audioBuffer.length * audioBuffer.numberOfChannels * 4,
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

export async function decodeFileProgressively(
  file: File,
  options: ProgressiveDecodeOptions
): Promise<AudioMetadata> {
  if (typeof document === "undefined") {
    throw new Error("Le mode progressif nécessite un environnement navigateur.");
  }

  const {
    chunkPlan,
    targetSampleRate,
    telemetry,
    manualRequestChunks = true,
    requestDataTimeoutMs = 2000,
    requestDataRetries = 2,
    maxPendingChunks,
  } = options;
  const url = URL.createObjectURL(file);
  const audio = new Audio(url);
  audio.preload = "auto";
  audio.muted = true;
  audio.crossOrigin = "anonymous";
  audio.playbackRate = 1.25; // accélère légèrement l'analyse

  telemetry?.startTimer("decode_audio_total");
  telemetry?.logEvent("START_DECODE", { strategy: "progressive", fileName: file.name });

  import("@/lib/logger").then(({ info }) => info("[progressive-decode] read file", {
    name: file.name,
    size: file.size,
    type: file.type,
    targetSampleRate,
  }));

  await waitForEvent(audio, "loadedmetadata");

  import("@/lib/logger").then(({ info }) => info("[progressive-decode] metadata", {
    durationSec: audio.duration,
    readyState: audio.readyState,
  }));

  const metadata: AudioMetadata = {
    name: file.name,
    durationSec: audio.duration,
    sizeBytes: file.size,
    mimeType: file.type,
    lastModified: file.lastModified,
  };

  const stream = (audio as HTMLMediaElement & {
    captureStream?: () => MediaStream;
  }).captureStream?.();
  if (!stream) {
    throw new Error("captureStream n'est pas supporté dans ce navigateur.");
  }

  import("@/lib/logger").then(({ info }) => info("[progressive-decode] captureStream obtained", {
    tracks: stream.getAudioTracks().length,
  }));

  const recorder = new MediaRecorder(stream, {
    mimeType: "audio/webm;codecs=opus",
    audioBitsPerSecond: 128_000,
  });

  import("@/lib/logger").then(({ info }) => info("[progressive-decode] recorder created", {
    mimeType: recorder.mimeType,
    audioBitsPerSecond: 128_000,
  }));

  // Baseline memory snapshot before starting progressive decode
  telemetry?.snapshotMemory("PROGRESSIVE_BEFORE_START");
  import("@/lib/logger").then(({ info }) => info("[progressive-decode] memory baseline snapshot taken"));

  const decodeCtx = new DecodeContext();
  let processingQueue: Promise<void> = Promise.resolve();
  let chunkIndex = 0;
  let lastEnd = 0;
  let stopped = false;
  let decodeError: unknown = null;

  // Queue backpressure: limit number of pending chunks to avoid memory/CPU blowup
  let pendingQueueCount = 0;
  const MAX_PENDING_CHUNKS = typeof maxPendingChunks === "number" ? maxPendingChunks : manualRequestChunks ? 1 : 5;

  // Manual requestData control (strict serial)
  let requestPending = false;
  let requestRetryCount = 0;
  let requestTimeoutId: number | null = null;
  const REQUESTDATA_TIMEOUT_MS = requestDataTimeoutMs;
  const REQUESTDATA_MAX_RETRIES = requestDataRetries;

  const clearRequestTimeout = () => {
    if (requestTimeoutId !== null) {
      clearTimeout(requestTimeoutId);
      requestTimeoutId = null;
    }
  };

  const stopRecorder = () => {
    if (!stopped) {
      stopped = true;
      clearRequestTimeout();
      if (recorder.state !== "inactive") {
        recorder.stop();
      }
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
    }
  };

  // Request the next chunk when in manual mode
  const scheduleRequestData = () => {
    if (!manualRequestChunks || stopped || requestPending || recorder.state !== "recording") return;
    requestPending = true;
    requestRetryCount = 0;
    try {
      recorder.requestData();
    } catch (e) {
      // Some implementations can throw if recorder is not in a proper state
      import("@/lib/logger").then(({ warn }) => warn("requestData failed", e));
      requestPending = false;
      return;
    }
    // start timeout
    requestTimeoutId = window.setTimeout(function onRequestTimeout() {
      requestRetryCount += 1;
      telemetry?.logEvent("REQUESTDATA_TIMEOUT", { tries: requestRetryCount });
      if (requestRetryCount <= REQUESTDATA_MAX_RETRIES) {
        try {
          recorder.requestData();
        } catch (e) {
          import("@/lib/logger").then(({ warn }) => warn("requestData retry failed", e));
        }
        requestTimeoutId = window.setTimeout(onRequestTimeout, REQUESTDATA_TIMEOUT_MS);
      } else {
        // Fallback: switch to timeslice mode to avoid stalling
        telemetry?.logEvent("REQUESTDATA_FALLBACK", { reason: "timeout" });
        telemetry?.recordAlert("REQUESTDATA_FALLBACK", {
          reason: "timeout",
          requestRetries: requestRetryCount,
          processedChunks: chunkIndex,
          processedSamples: decodeCtx.getProcessedSamples?.() ?? undefined,
          headerSize: decodeCtx.getHeaderSize?.() ?? undefined,
        });
        import("@/lib/logger").then(({ warn }) => warn("requestData timed out, falling back to timeslice mode"));
        // start recorder in periodic mode if still recording
        try {
          if (recorder.state === "recording") {
            recorder.start(timesliceMs);
          }
        } catch (e) {
          import("@/lib/logger").then(({ warn }) => warn("fallback recorder.start(timesliceMs) failed", e));
        }
        requestPending = false;
        requestTimeoutId = null;
      }
    }, REQUESTDATA_TIMEOUT_MS);
  };
  options.signal?.addEventListener("abort", () => {
    telemetry?.logEvent("STOP_REQUESTED");
    stopRecorder();
  });

  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data || event.data.size === 0 || decodeError) return;

    // If manual mode, clear pending request state since we got data
    if (manualRequestChunks) {
      requestPending = false;
      clearRequestTimeout();
    }

    const currentIndex = chunkIndex;
    const plan = chunkPlan[Math.min(currentIndex, chunkPlan.length - 1)];
    const start = plan?.start ?? lastEnd;
    const end = plan?.end ?? Math.min(metadata.durationSec, start + planDuration(chunkPlan));
    chunkIndex += 1;

    import("@/lib/logger").then(({ info }) => info("[progressive-decode] enqueue chunk", {
      index: currentIndex,
      blobSize: event.data.size,
      plannedStart: plan?.start,
      plannedEnd: plan?.end,
    }));

    // Backpressure: if too many chunks pending, skip this one to avoid memory blowup
    if (pendingQueueCount >= MAX_PENDING_CHUNKS) {
      telemetry?.logEvent("SKIP_CHUNK", { chunkIndex: currentIndex, reason: "queue_full" });
      import("@/lib/logger").then(({ warn }) => warn("[progressive-decode] skip chunk (queue full)", { index: currentIndex, pendingQueueCount }));
      // Advance lastEnd/progress so UI doesn't stall on skipped slices
      lastEnd = end;
      const progress = end / metadata.durationSec;
      options.onProgress?.(Math.min(1, progress));
      // In manual mode, still request next chunk so we don't stall
      if (manualRequestChunks && recorder.state === "recording") {
        scheduleRequestData();
      }
      return;
    }

    // Reserve a slot in the pending queue
    pendingQueueCount += 1;
    processingQueue = processingQueue.then(async () => {
      telemetry?.logEvent("START_CHUNK", {
        chunkIndex: currentIndex,
        plannedStart: plan?.start,
        plannedEnd: plan?.end,
      });

      // Snapshot memory at the start of processing this chunk and log audio memory summary
      telemetry?.snapshotMemory("PROGRESSIVE_CHUNK_START");
      import("@/lib/logger").then(({ info }) => info("[progressive-decode] chunk start memory", {
        chunkIndex: currentIndex,
        processedSamples: decodeCtx.getProcessedSamples(),
        estimatedProcessedBytes: decodeCtx.getProcessedSamples() * 4,
        headerSize: decodeCtx.getHeaderSize(),
        incomingBlobSize: event.data.size,
      }));

      try {
        const { pcm, sampleRate } = await decodeCtx.decodeBlob(event.data, targetSampleRate);
        if (!pcm.length) {
          telemetry?.logEvent("SKIP_CHUNK", { chunkIndex: currentIndex, reason: "empty_pcm" });
          import("@/lib/logger").then(({ info }) => info("[progressive-decode] skip chunk (empty pcm)", { index: currentIndex, start, end }));
          lastEnd = end;
          const progress = end / metadata.durationSec;
          options.onProgress?.(Math.min(1, progress));
          return;
        }

        // Snapshot memory after a decoded chunk (progressive mode)
        telemetry?.snapshotMemory("PROGRESSIVE_AFTER_CHUNK");
        import("@/lib/logger").then(({ info }) => info("[progressive-decode] memory snapshot after chunk", {
          chunkIndex: currentIndex,
          pcmFrames: pcm.length,
          estimatedPcmBytes: pcm.length * 4,
          blobSize: event.data.size,
          headerSize: decodeCtx.getHeaderSize(),
        }));

        const chunk: ProgressiveChunkResult = {
          index: currentIndex,
          startSec: start,
          endSec: end,
          pcm,
          sampleRate,
        };
        import("@/lib/logger").then(({ info }) => info("[progressive-decode] chunk decoded", {
          index: currentIndex,
          pcmFrames: pcm.length,
          sampleRate,
          start,
          end,
        }));
        lastEnd = end;
        await options.onChunk(chunk);
        telemetry?.logEvent("END_CHUNK", {
          chunkIndex: chunk.index,
          start: chunk.startSec,
          end: chunk.endSec,
        });
        const progress = chunk.endSec / metadata.durationSec;
        options.onProgress?.(Math.min(1, progress));
      } catch (error) {
          decodeError = error;
          import("@/lib/logger").then(({ error: logErr }) => logErr("[progressive-decode] decodeBlob failed", error));
          telemetry?.logEvent("ERROR", {
            scope: "progressive_decode",
            message: (error as Error)?.message,
          });
          stopRecorder();
        } finally {
          // Release the reserved pending slot regardless of success/failure
          pendingQueueCount -= 1;
          // In manual mode request the next chunk after finishing processing
          if (manualRequestChunks && recorder.state === "recording") {
            scheduleRequestData();
          }
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

        // Final memory snapshot and summary for progressive decode
        telemetry?.snapshotMemory("PROGRESSIVE_END");
        telemetry?.logEvent("MEMORY_SUMMARY", {
          strategy: "progressive",
          processedSamples: decodeCtx.getProcessedSamples(),
          estimatedProcessedBytes: decodeCtx.getProcessedSamples() * 4,
          headerSize: decodeCtx.getHeaderSize(),
          processedChunks: chunkIndex,
        });

        telemetry?.stopTimer("decode_audio_total");
        telemetry?.logEvent("END_DECODE", { processedChunks: chunkIndex });
        resolve();
      },
      { once: true }
    );
  });

  const timesliceMs = chunkPlan.length
    ? Math.max(500, (chunkPlan[0]!.end - chunkPlan[0]!.start) * 1000)
    : 10_000;
  import("@/lib/logger").then(({ info }) => info("[progressive-decode] recorder start", { timesliceMs, manualRequestChunks }));
  if (manualRequestChunks) {
    // Start without timeslice and request first chunk manually
    recorder.start();
    scheduleRequestData();
  } else {
    recorder.start(timesliceMs);
  }
  await audio.play();
  import("@/lib/logger").then(({ info }) => info("[progressive-decode] audio play triggered"));
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

  return metadata;
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

  // Try to decode the file to extract the sampleRate. If decoding fails, return metadata without sampleRate.
  let sampleRate: number | undefined = undefined;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const ctx = new AudioContext();
    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      sampleRate = audioBuffer.sampleRate;
    } catch (err) {
      // Some formats may fail to decode here; ignore and continue with undefined sampleRate
      import("@/lib/logger").then(({ warn }) => warn("probeAudioMetadata: decodeAudioData failed", err));
    } finally {
      try {
        await ctx.close();
      } catch (err) {
        void err;
      }
    }
  } catch (err) {
    import("@/lib/logger").then(({ warn }) => warn("probeAudioMetadata: failed to read file for sample rate", err));
  }

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

function planDuration(plan: ChunkDefinition[]): number {
  if (!plan.length) return 30;
  const first = plan[0]!;
  return first.end - first.start;
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

  private async ensureContext() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      import("@/lib/logger").then(({ info }) => info("[progressive-decode] create decode context", { sampleRate: this.ctx?.sampleRate }));
    }
    return this.ctx;
  }

  async decodeBlob(blob: Blob, targetSampleRate: number) {
    // Some browsers emit MediaRecorder chunks without container headers after the first one.
    // We keep the first blob as a header and prepend it to subsequent chunks so decodeAudioData
    // always receives a decodable container.
    if (!this.headerBlob) {
      this.headerBlob = blob;
      import("@/lib/logger").then(({ info }) => info("[progressive-decode] captured header blob", { size: blob.size, type: blob.type }));
    }

    const containerBlob = blob === this.headerBlob ? blob : new Blob([this.headerBlob, blob], { type: blob.type });
    import("@/lib/logger").then(({ info }) => info("[progressive-decode] decoding blob", {
      inputSize: blob.size,
      containerSize: containerBlob.size,
    }));
    const arrayBuffer = await containerBlob.arrayBuffer();
    const ctx = await this.ensureContext();
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const mono = mixToMono(buffer);
    import("@/lib/logger").then(({ info }) => info("[progressive-decode] decoded buffer", {
      durationSec: buffer.duration,
      sampleRate: buffer.sampleRate,
      frames: buffer.length,
      monoFrames: mono.length,
    }));
    const newSamples = mono.length - this.processedSamples;
    if (newSamples <= 0) {
      import("@/lib/logger").then(({ info }) => info("[progressive-decode] no new samples", {
        processedSamples: this.processedSamples,
        monoFrames: mono.length,
        inputSize: blob.size,
        containerSize: containerBlob.size,
      }));
      return { pcm: new Float32Array(0), sampleRate: targetSampleRate };
    }

    const delta = mono.slice(this.processedSamples);
    this.processedSamples = mono.length;

    // Keep the header blob cumulative so subsequent container blobs grow and
    // decodeAudioData receives increasing audio content rather than repeating
    // the same header + old delta.
    this.headerBlob = containerBlob;
    import("@/lib/logger").then(({ info }) => info("[progressive-decode] updated header blob", { headerSize: this.headerBlob?.size }));

    const pcm = await resampleMono(delta, buffer.sampleRate, targetSampleRate);
    import("@/lib/logger").then(({ info }) => info("[progressive-decode] resampled delta", {
      from: buffer.sampleRate,
      to: targetSampleRate,
      deltaFrames: delta.length,
      pcmFrames: pcm.length,
      durationSec: pcm.length / targetSampleRate,
    }));
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
    import("@/lib/logger").then(({ info }) => info("[progressive-decode] decode context closed", {
      processedSamples: this.processedSamples,
    }));
    this.headerBlob = null;
    this.processedSamples = 0;
  }
}
