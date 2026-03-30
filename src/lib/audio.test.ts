/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeCompressedBlobToPcm,
  decodeFileFully,
  decodeFileSegmentToPcm,
  encodeWavBuffer,
  extractChunkPcm,
  mixToMono,
  probeAudioMetadata,
  resampleMono,
} from "@/lib/audio";
import { mockAudioContext, mockDocumentAudio, mockMediaRecorder } from "@/test/audioMocks";

function makeAudioBuffer(
  channels: number,
  length: number,
  valuesPerChannel: number[][],
  sampleRate = 16000
): AudioBuffer {
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (index: number) => new Float32Array(valuesPerChannel[index] ?? new Array(length).fill(0)),
  } as unknown as AudioBuffer;
}

const restorerStack: Array<() => void> = [];
function registerRestore(fn: () => void) {
  restorerStack.push(fn);
}

afterEach(() => {
  vi.restoreAllMocks();
  while (restorerStack.length) {
    const restore = restorerStack.pop();
    restore?.();
  }
});

describe("audio helpers", () => {
  it("mixToMono averages channels", () => {
    const buffer = makeAudioBuffer(2, 4, [
      [1, 0.5, -0.5, 0],
      [0, 0.5, 0.5, 1],
    ]);
    const mono = mixToMono(buffer);

    expect(Array.from(mono)).toEqual([0.5, 0.5, 0, 0.5]);
  });

  it("extractChunkPcm slices with padded boundaries", () => {
    const pcm = new Float32Array(16000 * 2);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = i / pcm.length;

    const chunk = { paddedStart: 0.5, paddedEnd: 1.5 };
    const slice = extractChunkPcm(pcm, 16000, chunk as never);
    expect(slice.length).toBe(Math.ceil((1.5 - 0.5) * 16000));
  });

  it("resampleMono returns original buffer when rates match", async () => {
    const mono = new Float32Array([0, 0.2, -0.3, 0.1]);
    const out = await resampleMono(mono, 16000, 16000);
    expect(out).toBe(mono);
  });

  it("resampleMono uses linear fallback when OfflineAudioContext is unavailable", async () => {
    const original = (globalThis as any).OfflineAudioContext;
    delete (globalThis as any).OfflineAudioContext;
    registerRestore(() => {
      (globalThis as any).OfflineAudioContext = original;
    });

    const input = new Float32Array([0, 0.5, 1, 0.5, 0]);
    const out = await resampleMono(input, 5, 10);
    expect(out.length).toBe(10);
    expect(out[0]).toBeCloseTo(0);
    expect(out[2]).toBeGreaterThan(0);
  });

  it("resampleMono uses OfflineAudioContext when available", async () => {
    const Original = (globalThis as any).OfflineAudioContext;
    class MockOfflineAudioContext {
      destination = {};
      constructor(channels: number, frameCount: number, sampleRate: number) {
        void channels;
        void frameCount;
        void sampleRate;
      }
      createBuffer(channels: number, length: number, sampleRate: number) {
        void channels;
        void sampleRate;
        const data = new Float32Array(length);
        return {
          getChannelData: () => data,
        };
      }
      createBufferSource() {
        return {
          buffer: null,
          connect: () => {},
          start: () => {},
        };
      }
      async startRendering() {
        return {
          length: 7,
          copyFromChannel: (out: Float32Array) => {
            out.set(new Float32Array([0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1]));
          },
        };
      }
    }
    (globalThis as any).OfflineAudioContext = MockOfflineAudioContext;
    registerRestore(() => {
      (globalThis as any).OfflineAudioContext = Original;
    });
    const input = new Float32Array([0, 0.1, 0.2, 0.3]);
    const out = await resampleMono(input, 4000, 8000);
    expect(out.length).toBe(7);
  });

  it("probeAudioMetadata returns fallback when document is undefined", async () => {
    const originalDocument = (globalThis as any).document;
    delete (globalThis as any).document;
    registerRestore(() => {
      (globalThis as any).document = originalDocument;
    });

    const file = new File([""], "foo.wav", { type: "audio/wav", lastModified: 123 });
    const meta = await probeAudioMetadata(file);
    expect(meta).toMatchObject({
      name: "foo.wav",
      durationSec: 0,
      sizeBytes: file.size,
      mimeType: "audio/wav",
      lastModified: 123,
    });
  });

  it("probeAudioMetadata reads metadata in browser mode and revokes URL", async () => {
    registerRestore(mockDocumentAudio({ duration: 2.5 }));
    const createSpy = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:meta");
    const revokeSpy = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const file = new File([""], "meta.wav", { type: "audio/wav", lastModified: 10 });

    const meta = await probeAudioMetadata(file);
    expect(meta.durationSec).toBe(2.5);
    expect(meta.sampleRate).toBeUndefined();
    expect(createSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalledWith("blob:meta");
  });

  it("probeAudioMetadata coerces non-finite duration to 0", async () => {
    registerRestore(mockDocumentAudio({ duration: Number.POSITIVE_INFINITY }));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:meta-2");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const file = new File([""], "meta2.wav", { type: "audio/wav" });

    const meta = await probeAudioMetadata(file);
    expect(meta.durationSec).toBe(0);
  });

  it("encodeWavBuffer writes a valid header", () => {
    const pcm = new Float32Array([0, 1, -1]);
    const buffer = encodeWavBuffer(pcm, 16000);
    const view = new DataView(buffer);

    const readString = (offset: number, length: number) => {
      let text = "";
      for (let i = 0; i < length; i += 1) {
        text += String.fromCharCode(view.getUint8(offset + i));
      }
      return text;
    };

    expect(readString(0, 4)).toBe("RIFF");
    expect(readString(8, 4)).toBe("WAVE");
    expect(readString(12, 4)).toBe("fmt ");
    expect(readString(36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });
});

describe("audio decode", () => {
  it("decodeFileFully decodes, resamples, and emits telemetry", async () => {
    const fakeBuffer = makeAudioBuffer(2, 6, [
      [1, 0.5, 0, -0.5, -1, 0],
      [0, 0.5, 1, 0.5, 0, -0.5],
    ], 8000);
    const sliceSpy = vi.spyOn(ArrayBuffer.prototype, "slice");
    registerRestore(mockAudioContext(fakeBuffer));
    delete (globalThis as any).OfflineAudioContext;

    const telemetry = {
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
      logEvent: vi.fn(),
      snapshotMemory: vi.fn(),
    };
    const file = new File([new Uint8Array([1, 2, 3])], "voice.wav", { type: "audio/wav" });

    const decoded = await decodeFileFully(file, telemetry as never, 16000);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.pcm.length).toBeGreaterThan(0);
    expect(decoded.metadata.sampleRate).toBe(16000);
    expect(telemetry.startTimer).toHaveBeenCalledWith("decode_audio_total");
    expect(telemetry.stopTimer).toHaveBeenCalledWith("decode_audio_total");
    expect(sliceSpy).not.toHaveBeenCalled();
  });

  it("decodeFileFully throws when decodeAudioData returns null", async () => {
    const Original = (globalThis as any).AudioContext;
    class NullDecodeAudioContext {
      sampleRate = 16000;
      async decodeAudioData() {
        return null;
      }
      async close() {
        return;
      }
    }
    (globalThis as any).AudioContext = NullDecodeAudioContext;
    registerRestore(() => {
      (globalThis as any).AudioContext = Original;
    });

    const file = new File([new Uint8Array([1])], "bad.wav", { type: "audio/wav" });
    await expect(decodeFileFully(file)).rejects.toThrow("Échec du décodage audio.");
  });

  it("decodeCompressedBlobToPcm decodes and resamples", async () => {
    const fakeBuffer = makeAudioBuffer(1, 5, [[0.1, 0.2, 0.3, 0.2, 0.1]], 1000);
    const sliceSpy = vi.spyOn(ArrayBuffer.prototype, "slice");
    registerRestore(mockAudioContext(fakeBuffer));
    delete (globalThis as any).OfflineAudioContext;
    const telemetry = { startTimer: vi.fn(), stopTimer: vi.fn(), logEvent: vi.fn(), snapshotMemory: vi.fn() };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });

    const result = await decodeCompressedBlobToPcm(blob, telemetry as never, 2000);
    expect(result.sampleRate).toBe(2000);
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(sliceSpy).not.toHaveBeenCalled();
  });

  it("decodeCompressedBlobToPcm throws when decodeAudioData returns null", async () => {
    const Original = (globalThis as any).AudioContext;
    class NullDecodeAudioContext {
      sampleRate = 16000;
      async decodeAudioData() {
        return null;
      }
      async close() {
        return;
      }
    }
    (globalThis as any).AudioContext = NullDecodeAudioContext;
    registerRestore(() => {
      (globalThis as any).AudioContext = Original;
    });
    const blob = new Blob([new Uint8Array([1])], { type: "audio/webm" });
    await expect(decodeCompressedBlobToPcm(blob)).rejects.toThrow("Échec du décodage du segment.");
  });
});

describe("progressive segment decode", () => {
  it("throws when document is undefined", async () => {
    const originalDocument = (globalThis as any).document;
    delete (globalThis as any).document;
    registerRestore(() => {
      (globalThis as any).document = originalDocument;
    });

    const file = new File([""], "clip.webm", { type: "audio/webm" });
    await expect(
      decodeFileSegmentToPcm(file, { index: 0, startSec: 0, endSec: 1 }, { targetSampleRate: 16000 })
    ).rejects.toThrow("Le mode progressif nécessite un environnement navigateur.");
  });

  it("returns empty PCM when expected sample count is zero", async () => {
    const telemetry = { logEvent: vi.fn() };
    const file = new File([""], "clip.webm", { type: "audio/webm" });
    const result = await decodeFileSegmentToPcm(
      file,
      { index: 1, startSec: 5, endSec: 5 },
      { targetSampleRate: 16000, telemetry: telemetry as never }
    );
    expect(result).toEqual({ pcm: new Float32Array(0), sampleRate: 16000, durationSec: 0 });
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "END_DECODE",
      expect.objectContaining({ segmentIndex: 1, samples: 0 })
    );
  });

  it("throws when captureStream is unavailable", async () => {
    const OriginalAudio = (globalThis as any).Audio;
    (globalThis as any).Audio = class {
      currentTime = 0;
      preload = "auto";
      muted = true;
      crossOrigin = "anonymous";
      playbackRate = 1;
      addEventListener(type: string, cb: () => void) {
        if (type === "loadedmetadata") {
          setTimeout(cb, 0);
        }
      }
      removeEventListener() {}
      async play() {}
      pause() {}
      removeAttribute() {}
      load() {}
    };
    registerRestore(() => {
      (globalThis as any).Audio = OriginalAudio;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:nocapture");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const file = new File([""], "clip.webm", { type: "audio/webm" });
    await expect(
      decodeFileSegmentToPcm(file, { index: 0, startSec: 0, endSec: 1 }, { targetSampleRate: 16000 })
    ).rejects.toThrow("captureStream n'est pas supporté dans ce navigateur.");
  });

  it("decodes one progressive segment end-to-end", async () => {
    registerRestore(mockDocumentAudio({ duration: 1 }));
    registerRestore(mockMediaRecorder());
    const fakeBuffer = makeAudioBuffer(1, 40, [new Array(40).fill(0.1)], 1000);
    registerRestore(mockAudioContext(fakeBuffer));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:segment");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const telemetry = {
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
      logEvent: vi.fn(),
      recordAlert: vi.fn(),
    };

    const file = new File([new Uint8Array([1, 2, 3])], "clip.webm", { type: "audio/webm" });
    const result = await decodeFileSegmentToPcm(
      file,
      { index: 2, startSec: 0, endSec: 0.02 },
      { targetSampleRate: 1000, telemetry: telemetry as never, playbackRate: 1.25 }
    );

    expect(result.sampleRate).toBe(1000);
    expect(result.pcm.length).toBeGreaterThan(0);
    expect(result.durationSec).toBeCloseTo(result.pcm.length / 1000);
    expect(telemetry.startTimer).toHaveBeenCalledWith("decode_audio_segment_total");
    expect(telemetry.stopTimer).toHaveBeenCalledWith("decode_audio_segment_total");
  });

  it("stops gracefully when requestData throws", async () => {
    registerRestore(mockDocumentAudio({ duration: 1 }));
    const OriginalRecorder = (globalThis as any).MediaRecorder;
    class ThrowingRecorder extends EventTarget {
      state: "inactive" | "recording" = "inactive";
      constructor() {
        super();
      }
      start() {
        this.state = "recording";
      }
      requestData() {
        throw new Error("requestData not available");
      }
      stop() {
        this.state = "inactive";
        this.dispatchEvent(new Event("stop"));
      }
    }
    (globalThis as any).MediaRecorder = ThrowingRecorder;
    registerRestore(() => {
      (globalThis as any).MediaRecorder = OriginalRecorder;
    });
    const fakeBuffer = makeAudioBuffer(1, 10, [new Array(10).fill(0.2)], 1000);
    registerRestore(mockAudioContext(fakeBuffer));
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:requestdata");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const file = new File([new Uint8Array([1])], "clip.webm", { type: "audio/webm" });
    const result = await decodeFileSegmentToPcm(
      file,
      { index: 3, startSec: 0, endSec: 0.1 },
      { targetSampleRate: 1000 }
    );
    expect(result.pcm.length).toBe(0);
  });

  it("propagates decode errors from progressive chunk decoding", async () => {
    registerRestore(mockDocumentAudio({ duration: 1 }));
    registerRestore(mockMediaRecorder());
    const Original = (globalThis as any).AudioContext;
    class FailingAudioContext {
      sampleRate = 16000;
      async decodeAudioData() {
        throw new Error("decode failed");
      }
      async close() {
        return;
      }
    }
    (globalThis as any).AudioContext = FailingAudioContext;
    registerRestore(() => {
      (globalThis as any).AudioContext = Original;
    });
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:decode-error");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});

    const file = new File([new Uint8Array([1])], "clip.webm", { type: "audio/webm" });
    await expect(
      decodeFileSegmentToPcm(file, { index: 4, startSec: 0, endSec: 0.2 }, { targetSampleRate: 16000 })
    ).rejects.toThrow("decode failed");
  });
});
