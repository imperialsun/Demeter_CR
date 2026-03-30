import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCloudAudio } from "./decodeCloudAudio";

const mocks = vi.hoisted(() => {
  const ffmpeg = {
    createDir: vi.fn(async () => {}),
    mount: vi.fn(async () => {}),
    unmount: vi.fn(async () => {}),
    deleteDir: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([0, 0, 0, 64])),
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
    mocks.ffmpeg.createDir.mockClear();
    mocks.ffmpeg.mount.mockClear();
    mocks.ffmpeg.unmount.mockClear();
    mocks.ffmpeg.deleteDir.mockClear();
    mocks.ffmpeg.deleteFile.mockClear();
    mocks.ffmpeg.exec.mockClear();
    mocks.ffmpeg.readFile.mockClear();
    mocks.ffmpeg.exec.mockResolvedValue(0);
    mocks.ffmpeg.readFile.mockResolvedValue(new Uint8Array([0, 0, 0, 64]));
  });

  it("uses ffmpeg WorkerFS as the primary decode path", async () => {
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await decodeCloudAudio(file);

    expect(result.sampleRate).toBe(16000);
    expect(result.pcm.length).toBe(2);
    expect(mocks.getFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.decodeFileFully).not.toHaveBeenCalled();
    expect(mocks.ffmpeg.mount).toHaveBeenCalledWith(expect.any(String), { files: [file] }, expect.stringMatching(/^\/cloud-input-/));
    expect(mocks.ffmpeg.exec).toHaveBeenCalledWith([
      "-y",
      "-i",
      expect.stringMatching(/^\/cloud-input-/),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "s16le",
      expect.stringMatching(/^\/cloud-output-/),
    ]);
    expect(mocks.ffmpeg.unmount).toHaveBeenCalledTimes(1);
    expect(mocks.ffmpeg.deleteDir).toHaveBeenCalled();
    expect(mocks.probeAudioMetadata).toHaveBeenCalledWith(file);
  });

  it("falls back to AudioContext decoding when ffmpeg fails", async () => {
    mocks.ffmpeg.exec.mockRejectedValueOnce(new Error("ffmpeg crashed"));
    mocks.decodeFileFully.mockResolvedValueOnce({
      metadata: { durationSec: 1, sampleRate: 16000 },
      pcm: new Float32Array([0.1, 0.2]),
      sampleRate: 16000,
    });
    const telemetry = { recordAlert: vi.fn(), logEvent: vi.fn(), startTimer: vi.fn(), stopTimer: vi.fn() };
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await decodeCloudAudio(file, telemetry as never);

    expect(mocks.getFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.decodeFileFully).toHaveBeenCalledWith(file, telemetry, 16000);
    expect(result.sampleRate).toBe(16000);
    expect(result.pcm.length).toBe(2);
    expect(telemetry.recordAlert).toHaveBeenCalledWith(
      "CLOUD_DECODE_FALLBACK",
      expect.objectContaining({ fileName: "test.mp3" })
    );
  });
});
