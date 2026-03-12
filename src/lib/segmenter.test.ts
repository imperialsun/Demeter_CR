import { beforeEach, describe, expect, it, vi } from "vitest";

import { createSegmentCache } from "@/lib/segmenter";
import type { ChunkDefinition } from "@/lib/chunking";

const mocks = vi.hoisted(() => {
  const ffmpeg = {
    createDir: vi.fn(async () => {}),
    deleteDir: vi.fn(async () => {}),
    mount: vi.fn(async () => {}),
    unmount: vi.fn(async () => {}),
    exec: vi.fn(async () => 0),
    readFile: vi.fn(async () => new Uint8Array([1, 2, 3])),
    deleteFile: vi.fn(async () => {}),
    listDir: vi.fn(async () => []),
    terminate: vi.fn(() => {}),
  };
  return {
    ffmpeg,
    getFfmpeg: vi.fn(async () => ffmpeg),
    resetFfmpeg: vi.fn(() => {}),
    putSegment: vi.fn(async () => {}),
    loggerInfo: vi.fn(() => {}),
    loggerWarn: vi.fn(() => {}),
  };
});

vi.mock("@/lib/ffmpeg-loader", () => ({
  getFfmpeg: mocks.getFfmpeg,
  resetFfmpeg: mocks.resetFfmpeg,
}));

vi.mock("@/lib/segment-cache", () => ({
  putSegment: mocks.putSegment,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFFSType: {
    WORKERFS: "WORKERFS",
  },
}));

function makeChunks(): ChunkDefinition[] {
  return [
    {
      id: "c1",
      index: 0,
      start: 0,
      end: 2,
      paddedStart: 0,
      paddedEnd: 2,
    },
    {
      id: "c2",
      index: 1,
      start: 2,
      end: 4,
      paddedStart: 2,
      paddedEnd: 4,
    },
  ];
}

describe("createSegmentCache", () => {
  beforeEach(() => {
    mocks.getFfmpeg.mockClear();
    mocks.resetFfmpeg.mockClear();
    mocks.putSegment.mockClear();
    mocks.loggerInfo.mockClear();
    mocks.loggerWarn.mockClear();

    mocks.ffmpeg.createDir.mockClear();
    mocks.ffmpeg.deleteDir.mockClear();
    mocks.ffmpeg.mount.mockClear();
    mocks.ffmpeg.unmount.mockClear();
    mocks.ffmpeg.exec.mockClear();
    mocks.ffmpeg.readFile.mockClear();
    mocks.ffmpeg.deleteFile.mockClear();
    mocks.ffmpeg.listDir.mockClear();
    mocks.ffmpeg.terminate.mockClear();

    mocks.ffmpeg.exec.mockResolvedValue(0);
    mocks.ffmpeg.readFile.mockResolvedValue(new Uint8Array([1, 2, 3]));
  });

  it("caches all segments with copy mode", async () => {
    const onProgress = vi.fn();
    const telemetry = { logEvent: vi.fn() } as const;
    const file = new File(["audio"], "demo.mp3", { type: "audio/mpeg" });

    const result = await createSegmentCache(file, {
      sessionId: "session-a",
      segments: makeChunks(),
      onProgress,
      telemetry,
    });

    expect(result).toEqual({ completed: 2, total: 2, aborted: false });
    expect(mocks.ffmpeg.exec).toHaveBeenCalledTimes(2);
    expect(mocks.putSegment).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onProgress).toHaveBeenCalledWith(2, 2);
    expect(mocks.resetFfmpeg).toHaveBeenCalledTimes(1);
    expect(mocks.ffmpeg.terminate).toHaveBeenCalledTimes(1);
  });

  it("falls back to opus when copy extraction fails", async () => {
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const file = new File(["audio"], "demo.wav", { type: "audio/wav" });

    const result = await createSegmentCache(file, {
      sessionId: "session-b",
      segments: [makeChunks()[0]!],
    });

    expect(result).toEqual({ completed: 1, total: 1, aborted: false });
    expect(mocks.ffmpeg.exec).toHaveBeenCalledTimes(2);
    expect(mocks.putSegment).toHaveBeenCalledTimes(1);
    const firstCallArg = mocks.putSegment.mock.calls[0]?.[0] as { blob: Blob };
    expect(firstCallArg.blob.type).toBe("audio/webm;codecs=opus");
  });

  it("returns aborted when stop signal is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const telemetry = { logEvent: vi.fn() } as const;
    const file = new File(["audio"], "demo.webm", { type: "audio/webm" });

    const result = await createSegmentCache(file, {
      sessionId: "session-c",
      segments: makeChunks(),
      telemetry,
      signal: controller.signal,
    });

    expect(result).toEqual({ completed: 0, total: 2, aborted: true });
    expect(telemetry.logEvent).toHaveBeenCalledWith("STOP_REQUESTED");
    expect(mocks.putSegment).not.toHaveBeenCalled();
  });

  it("supports additional mime extensions and warns on extension mismatch", async () => {
    const cases = [
      { type: "audio/x-m4a", expectedFormat: "mp4", expectedBlobType: "audio/mp4" },
      { type: "audio/aac", expectedFormat: "adts", expectedBlobType: "audio/aac" },
      { type: "audio/ogg", expectedFormat: "ogg", expectedBlobType: "audio/ogg" },
      { type: "", expectedFormat: "webm", expectedBlobType: "audio/webm;codecs=opus" },
    ] as const;

    for (const current of cases) {
      mocks.ffmpeg.exec.mockClear();
      mocks.putSegment.mockClear();
      mocks.ffmpeg.readFile.mockResolvedValueOnce("abc");

      const file = new File(["audio"], current.type ? "demo.mp3" : "demo", { type: current.type });
      await createSegmentCache(file, {
        sessionId: `session-${current.type || "none"}`,
        segments: [makeChunks()[0]!],
      });

      const args = mocks.ffmpeg.exec.mock.calls[0]?.[0] as string[];
      expect(args).toContain("-f");
      expect(args).toContain(current.expectedFormat);
      const putArg = mocks.putSegment.mock.calls[0]?.[0] as { blob: Blob };
      expect(putArg.blob.type).toBe(current.expectedBlobType);
    }

    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "[segmenter] extension mismatch",
      expect.objectContaining({ nameExt: "mp3", mimeExt: "m4a" })
    );
  });

  it("logs directory-creation warnings and continues", async () => {
    mocks.ffmpeg.createDir.mockRejectedValueOnce(new Error("input exists")).mockRejectedValueOnce(new Error("output exists"));
    const file = new File(["audio"], "demo.wav", { type: "audio/wav" });

    const result = await createSegmentCache(file, {
      sessionId: "session-dirs",
      segments: [makeChunks()[0]!],
    });

    expect(result.aborted).toBe(false);
    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] input dir exists", expect.any(Error));
    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] output dir exists", expect.any(Error));
  });

  it("throws when copy and opus fallback both fail", async () => {
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const file = new File(["audio"], "demo.wav", { type: "audio/wav" });

    await expect(
      createSegmentCache(file, {
        sessionId: "session-fail",
        segments: [makeChunks()[0]!],
      })
    ).rejects.toThrow("ffmpeg failed with code 2");
  });

  it("warns when deleting output before opus fallback fails", async () => {
    mocks.ffmpeg.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    mocks.ffmpeg.deleteFile.mockRejectedValueOnce(new Error("cannot delete"));
    const file = new File(["audio"], "demo.wav", { type: "audio/wav" });

    await createSegmentCache(file, {
      sessionId: "session-delete-fallback",
      segments: [makeChunks()[0]!],
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] delete output before fallback failed", expect.any(Error));
  });

  it("returns aborted when signal is aborted during execution", async () => {
    const controller = new AbortController();
    mocks.ffmpeg.exec.mockImplementation(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    const telemetry = { logEvent: vi.fn() } as const;
    const file = new File(["audio"], "demo.webm", { type: "audio/webm" });

    const result = await createSegmentCache(file, {
      sessionId: "session-abort-mid",
      segments: [makeChunks()[0]!],
      telemetry,
      signal: controller.signal,
    });

    expect(result).toEqual({ completed: 0, total: 1, aborted: true });
    expect(telemetry.logEvent).toHaveBeenCalledWith("STOP_REQUESTED");
  });

  it("logs cleanup warnings for unmount, delete, list, terminate and file cleanup failures", async () => {
    mocks.ffmpeg.unmount.mockRejectedValueOnce(new Error("unmount failed"));
    mocks.ffmpeg.deleteDir.mockImplementation(async (path: string) => {
      if (path === "/input") throw new Error("delete input failed");
      if (path === "/output") throw new Error("delete output failed");
    });
    mocks.ffmpeg.listDir.mockResolvedValueOnce([
      { isDir: true, name: "nested" },
      { isDir: false, name: "." },
      { isDir: false, name: ".." },
      { isDir: false, name: "leftover.webm" },
    ]);
    mocks.ffmpeg.deleteFile.mockImplementation(async (path: string) => {
      if (path === "/output/leftover.webm") throw new Error("delete leftover failed");
    });
    mocks.ffmpeg.terminate.mockImplementation(() => {
      throw new Error("terminate failed");
    });

    const file = new File(["audio"], "demo.webm", { type: "audio/webm" });
    await createSegmentCache(file, {
      sessionId: "session-cleanup",
      segments: [makeChunks()[0]!],
    });

    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] unmount failed", expect.any(Error));
    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] delete input dir failed", expect.any(Error));
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "[segmenter] delete output file failed",
      expect.objectContaining({ name: "leftover.webm" })
    );
    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] delete output dir failed", expect.any(Error));
    expect(mocks.loggerWarn).toHaveBeenCalledWith("[segmenter] ffmpeg terminate failed", expect.any(Error));
  });
});
