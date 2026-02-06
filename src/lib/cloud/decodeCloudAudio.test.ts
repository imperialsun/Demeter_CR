import { describe, it, expect, vi } from "vitest";
import { decodeCloudAudio } from "./decodeCloudAudio";

const mocks = vi.hoisted(() => ({
  decodeFileFully: vi.fn(),
  getFfmpeg: vi.fn(async () => ({
    writeFile: vi.fn(),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([0, 0, 0, 64])),
    deleteFile: vi.fn(),
  })),
  probeAudioMetadata: vi.fn(async () => ({ durationSec: 1, sampleRate: 44100 })),
}));

vi.mock("@/lib/audio", () => ({
  decodeFileFully: mocks.decodeFileFully,
  probeAudioMetadata: mocks.probeAudioMetadata,
}));

vi.mock("@/lib/ffmpeg-loader", () => ({
  getFfmpeg: mocks.getFfmpeg,
}));

describe("decodeCloudAudio", () => {
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
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await decodeCloudAudio(file);
    expect(mocks.getFfmpeg).toHaveBeenCalled();
    expect(result.sampleRate).toBe(16000);
    expect(result.pcm.length).toBe(2);
  });
});
