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
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
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
});
