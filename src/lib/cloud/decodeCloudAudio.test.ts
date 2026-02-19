import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCloudAudio } from "./decodeCloudAudio";

const mocks = vi.hoisted(() => {
  const ffmpeg = {
    writeFile: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([0, 0, 0, 64])),
    deleteFile: vi.fn(async () => {}),
  };
  return {
    ffmpeg,
    decodeFileFully: vi.fn(),
    getFfmpeg: vi.fn(async () => ffmpeg),
    probeAudioMetadata: vi.fn(async () => ({ durationSec: 1, sampleRate: 44100 })),
  };
});

vi.mock("@/lib/audio", () => ({
  decodeFileFully: mocks.decodeFileFully,
  probeAudioMetadata: mocks.probeAudioMetadata,
}));

vi.mock("@/lib/ffmpeg-loader", () => ({
  getFfmpeg: mocks.getFfmpeg,
}));

describe("decodeCloudAudio", () => {
  beforeEach(() => {
    mocks.decodeFileFully.mockReset();
    mocks.getFfmpeg.mockClear();
    mocks.probeAudioMetadata.mockClear();
    mocks.ffmpeg.writeFile.mockClear();
    mocks.ffmpeg.exec.mockClear();
    mocks.ffmpeg.readFile.mockClear();
    mocks.ffmpeg.deleteFile.mockClear();
    mocks.ffmpeg.exec.mockResolvedValue(0);
    mocks.ffmpeg.readFile.mockResolvedValue(new Uint8Array([0, 0, 0, 64]));
  });

  it("uses decodeFileFully when it succeeds", async () => {
    mocks.decodeFileFully.mockResolvedValueOnce({
      metadata: { durationSec: 1, sampleRate: 16000 },
      pcm: new Float32Array([0.1, 0.2]),
      sampleRate: 16000,
    });
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await decodeCloudAudio(file);
    expect(result.pcm.length).toBe(2);
    expect(mocks.decodeFileFully).toHaveBeenCalled();
    expect(mocks.getFfmpeg).not.toHaveBeenCalled();
  });

  it("falls back to ffmpeg on encoding errors", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Unable to decode audio data", "EncodingError"));
    const telemetry = { recordAlert: vi.fn(), logEvent: vi.fn(), startTimer: vi.fn(), stopTimer: vi.fn() };
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await decodeCloudAudio(file, telemetry as never);
    expect(mocks.getFfmpeg).toHaveBeenCalled();
    expect(result.sampleRate).toBe(16000);
    expect(result.pcm.length).toBe(2);
    expect(telemetry.recordAlert).toHaveBeenCalledWith(
      "CLOUD_DECODE_FALLBACK",
      expect.objectContaining({ fileName: "test.mp3" })
    );
  });

  it("rethrows non decode failures without ffmpeg fallback", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new Error("permission denied"));

    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    await expect(decodeCloudAudio(file)).rejects.toThrow("permission denied");
    expect(mocks.getFfmpeg).not.toHaveBeenCalled();
  });

  it("throws when ffmpeg output is not binary data", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Unable to decode audio data", "EncodingError"));
    mocks.ffmpeg.readFile.mockResolvedValueOnce("not-binary");
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });

    await expect(decodeCloudAudio(file)).rejects.toThrow("ffmpeg output is not binary data");
  });

  it("uses legacy FS/run path when available", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Échec du décodage audio", "Error"));
    const fs = vi.fn((op: string, ...args: unknown[]) => {
      if (op === "readFile") {
        return new Uint8Array([0, 0, 0, 64]);
      }
      return args[0];
    });
    const run = vi.fn(async () => {});
    mocks.getFfmpeg.mockResolvedValueOnce({
      FS: fs,
      run,
    });

    const file = new File([""], "recording.ogg", { type: "audio/ogg" });
    const result = await decodeCloudAudio(file);

    expect(result.sampleRate).toBe(16000);
    expect(run).toHaveBeenCalled();
    expect(fs).toHaveBeenCalledWith("writeFile", expect.stringMatching(/\.ogg$/), expect.any(Uint8Array));
    expect(fs).toHaveBeenCalledWith("readFile", expect.any(String));
    expect(fs).toHaveBeenCalledWith("unlink", expect.any(String));
  });

  it("falls back to Response(blob).arrayBuffer when file.arrayBuffer is unavailable", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Unable to decode audio data", "EncodingError"));
    const file = new File(["blob-bytes"], "voice.m4a", { type: "audio/x-m4a" }) as File & {
      arrayBuffer?: () => Promise<ArrayBuffer>;
    };
    Object.defineProperty(file, "arrayBuffer", { value: undefined });

    const result = await decodeCloudAudio(file as File);
    expect(result.sampleRate).toBe(16000);
    expect(mocks.ffmpeg.writeFile).toHaveBeenCalledWith(expect.stringMatching(/\.m4a$/), expect.any(Uint8Array));
  });

  it("throws on non-zero ffmpeg exit code and logs telemetry error", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Unable to decode audio data", "EncodingError"));
    mocks.ffmpeg.exec.mockResolvedValueOnce(3);
    const telemetry = {
      recordAlert: vi.fn(),
      logEvent: vi.fn(),
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
    };
    const file = new File([""], "bad.aac", { type: "audio/aac" });

    await expect(decodeCloudAudio(file, telemetry as never)).rejects.toThrow("ffmpeg failed with code 3");
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "ERROR",
      expect.objectContaining({ context: "cloud_decode_ffmpeg" })
    );
  });

  it("rethrows ffmpeg conversion errors and keeps cleanup best-effort", async () => {
    mocks.decodeFileFully.mockRejectedValueOnce(new DOMException("Unable to decode audio data", "EncodingError"));
    mocks.ffmpeg.exec.mockRejectedValueOnce(new Error("ffmpeg crashed"));
    mocks.ffmpeg.deleteFile.mockRejectedValue(new Error("delete failed"));
    const telemetry = {
      recordAlert: vi.fn(),
      logEvent: vi.fn(),
      startTimer: vi.fn(),
      stopTimer: vi.fn(),
    };
    const file = new File([""], "broken.webm", { type: "audio/webm" });

    await expect(decodeCloudAudio(file, telemetry as never)).rejects.toThrow("ffmpeg crashed");
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "ERROR",
      expect.objectContaining({ context: "cloud_decode_ffmpeg", message: "ffmpeg crashed" })
    );
  });
});
