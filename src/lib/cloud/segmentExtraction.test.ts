import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractSegmentBlob } from "./segmentExtraction";

const mocks = vi.hoisted(() => ({
  ffmpeg: {
    createDir: vi.fn(),
    deleteDir: vi.fn(),
    mount: vi.fn(),
    unmount: vi.fn(),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    deleteFile: vi.fn(),
  },
  getFfmpeg: vi.fn(async () => mocks.ffmpeg),
}));

vi.mock("@/lib/ffmpeg-loader", () => ({
  getFfmpeg: mocks.getFfmpeg,
}));

describe("extractSegmentBlob", () => {
  beforeEach(() => {
    mocks.ffmpeg.createDir.mockClear();
    mocks.ffmpeg.deleteDir.mockClear();
    mocks.ffmpeg.mount.mockClear();
    mocks.ffmpeg.unmount.mockClear();
    mocks.ffmpeg.exec.mockClear();
    mocks.ffmpeg.readFile.mockClear();
    mocks.ffmpeg.deleteFile.mockClear();
  });

  it("extracts a segment with copy mode", async () => {
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await extractSegmentBlob(file, { index: 0, startSec: 0, endSec: 10 });
    expect(result.blob.size).toBeGreaterThan(0);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(mocks.ffmpeg.exec).toHaveBeenCalled();
  });

  it("falls back to opus when copy fails", async () => {
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });
    const result = await extractSegmentBlob(file, { index: 1, startSec: 0, endSec: 10 });
    expect(result.mimeType).toBe("audio/webm;codecs=opus");
    expect(mocks.ffmpeg.exec).toHaveBeenCalledTimes(2);
  });
});
