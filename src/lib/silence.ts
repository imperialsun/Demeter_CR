export interface SilenceDetectionOptions {
  sampleRate?: number;
  silenceThresholdDb: number;
  minSilenceMs: number;
  minChunkMs: number;
  maxChunkMs: number;
}

export interface SpeechRegion {
  startSec: number;
  endSec: number;
  peakDb: number;
}

export function detectSilenceRegions(
  pcm: Float32Array,
  options: SilenceDetectionOptions
): SpeechRegion[] {
  if (!options.sampleRate) return [];
  const sampleRate = options.sampleRate;
  const frameDuration = 0.02; // 20 ms
  const frameSamples = Math.max(1, Math.floor(sampleRate * frameDuration));
  const thresholdLinear = dbToLinear(options.silenceThresholdDb);
  const minSilenceFrames = Math.max(
    1,
    Math.floor(options.minSilenceMs / 1000 / frameDuration)
  );
  const minChunkSec = options.minChunkMs / 1000;
  const maxChunkSec = options.maxChunkMs / 1000;

  let inSpeech = false;
  let speechStartFrame = 0;
  let silenceFrames = 0;
  let peakDb = -Infinity;
  const segments: SpeechRegion[] = [];

  for (let frameIndex = 0; frameIndex * frameSamples < pcm.length; frameIndex++) {
    const frameStart = frameIndex * frameSamples;
    const frameEnd = Math.min(frameStart + frameSamples, pcm.length);
    const rms = computeRms(pcm, frameStart, frameEnd);
    const frameDb = linearToDb(rms);
    if (rms > thresholdLinear) {
      if (!inSpeech) {
        inSpeech = true;
        speechStartFrame = frameIndex;
        peakDb = frameDb;
      } else {
        peakDb = Math.max(peakDb, frameDb);
      }
      silenceFrames = 0;
    } else if (inSpeech) {
      silenceFrames += 1;
      if (silenceFrames >= minSilenceFrames) {
        const speechEndFrame = Math.max(frameIndex - silenceFrames, speechStartFrame + 1);
        segments.push({
          startSec: speechStartFrame * frameDuration,
          endSec: speechEndFrame * frameDuration,
          peakDb,
        });
        inSpeech = false;
      }
    }
  }

  if (inSpeech) {
    const totalFrames = Math.ceil(pcm.length / frameSamples);
    segments.push({
      startSec: speechStartFrame * frameDuration,
      endSec: totalFrames * frameDuration,
      peakDb,
    });
  }

  const merged = mergeTinySegments(segments, minChunkSec);
  const bounded = splitLargeSegments(merged, maxChunkSec);
  return bounded;
}

function mergeTinySegments(segments: SpeechRegion[], minChunkSec: number): SpeechRegion[] {
  if (!segments.length) return segments;
  const result: SpeechRegion[] = [];
  for (const segment of segments) {
    const duration = segment.endSec - segment.startSec;
    if (duration >= minChunkSec || !result.length) {
      result.push({ ...segment });
      continue;
    }
    const prev = result[result.length - 1];
    prev.endSec = segment.endSec;
    prev.peakDb = Math.max(prev.peakDb, segment.peakDb);
  }
  return result;
}

function splitLargeSegments(segments: SpeechRegion[], maxChunkSec: number): SpeechRegion[] {
  if (!segments.length) return segments;
  if (maxChunkSec <= 0) return segments;
  const result: SpeechRegion[] = [];
  for (const segment of segments) {
    let start = segment.startSec;
    while (start < segment.endSec) {
      const end = Math.min(segment.endSec, start + maxChunkSec);
      result.push({ startSec: start, endSec: end, peakDb: segment.peakDb });
      start = end;
    }
  }
  return result;
}

function computeRms(buffer: Float32Array, start: number, end: number) {
  let sum = 0;
  const length = end - start;
  for (let i = start; i < end; i++) {
    sum += buffer[i]! * buffer[i]!;
  }
  return Math.sqrt(sum / Math.max(1, length));
}

function dbToLinear(db: number) {
  return Math.pow(10, db / 20);
}

function linearToDb(value: number) {
  return 20 * Math.log10(value + 1e-12);
}
