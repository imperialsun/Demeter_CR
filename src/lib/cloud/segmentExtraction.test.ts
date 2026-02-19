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
    mocks.ffmpeg.exec.mockResolvedValue(0);
    mocks.ffmpeg.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
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

  it("uses mime extension over file name extension mismatch", async () => {
    const file = new File([""], "test.wav", { type: "audio/mpeg" });
    const result = await extractSegmentBlob(file, { index: 2, startSec: 0, endSec: 10 });
    expect(result.name.endsWith(".mp3")).toBe(true);
    expect(result.mimeType).toBe("audio/mpeg");
  });

  it("throws when copy and fallback both fail", async () => {
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const file = new File([""], "test.mp3", { type: "audio/mpeg" });

    await expect(extractSegmentBlob(file, { index: 3, startSec: 0, endSec: 10 })).rejects.toThrow(
      "ffmpeg failed with code 2"
    );
    expect(mocks.ffmpeg.unmount).toHaveBeenCalled();
    expect(mocks.ffmpeg.deleteDir).toHaveBeenCalled();
  });

  it("supports remaining extension and mime mappings", async () => {
    const cases = [
      { name: "sample.mp4", type: "audio/mp4", expectedNameExt: ".m4a", expectedMime: "audio/mp4" },
      { name: "sample.m4a", type: "audio/x-m4a", expectedNameExt: ".m4a", expectedMime: "audio/mp4" },
      { name: "sample.aac", type: "audio/aac", expectedNameExt: ".aac", expectedMime: "audio/aac" },
      { name: "sample.wav", type: "audio/wav", expectedNameExt: ".wav", expectedMime: "audio/wav" },
      { name: "sample.wav", type: "audio/x-wav", expectedNameExt: ".wav", expectedMime: "audio/wav" },
      { name: "sample.webm", type: "audio/webm", expectedNameExt: ".webm", expectedMime: "audio/webm;codecs=opus" },
      { name: "sample.ogg", type: "audio/ogg", expectedNameExt: ".ogg", expectedMime: "audio/ogg" },
    ] as const;

    for (const item of cases) {
      const file = new File([""], item.name, { type: item.type });
      const result = await extractSegmentBlob(file, { index: 10, startSec: 0, endSec: 2 });
      expect(result.name.endsWith(item.expectedNameExt)).toBe(true);
      expect(result.mimeType).toBe(item.expectedMime);
    }
  });

  it("keeps best-effort cleanup on create/delete/unmount errors and unknown extension", async () => {
    mocks.ffmpeg.createDir.mockRejectedValue(new Error("dir exists"));
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.ffmpeg.readFile.mockResolvedValue("raw-audio");
    mocks.ffmpeg.deleteFile.mockRejectedValue(new Error("cannot delete output"));
    mocks.ffmpeg.unmount.mockRejectedValue(new Error("cannot unmount"));
    mocks.ffmpeg.deleteDir.mockRejectedValue(new Error("cannot delete dir"));

    const file = new File(["payload"], "sample.xyz", { type: "" });
    const result = await extractSegmentBlob(file, { index: 11, startSec: 1, endSec: 1.5 });

    expect(result.name.endsWith(".webm")).toBe(true);
    expect(result.mimeType).toBe("audio/webm;codecs=opus");
    expect(result.blob.size).toBeGreaterThan(0);
    expect(mocks.ffmpeg.unmount).toHaveBeenCalled();
    expect(mocks.ffmpeg.deleteDir).toHaveBeenCalledTimes(2);
  });
});
