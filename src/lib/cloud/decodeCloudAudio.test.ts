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
});
