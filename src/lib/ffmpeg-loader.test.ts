import { beforeEach, describe, expect, it, vi } from "vitest";

import { useAsrStore } from "@/store/asr-store";
import { getFfmpeg, releaseFfmpeg, resetFfmpeg } from "@/lib/ffmpeg-loader";

const mocks = vi.hoisted(() => {
  const load = vi.fn(async () => {});
  const terminate = vi.fn(async () => {});
  class FFmpegMock {
    load = load;
    terminate = terminate;
  }
  return {
    load,
    terminate,
    FFmpegMock,
    loggerInfo: vi.fn(() => {}),
    loggerError: vi.fn(() => {}),
  };
});

vi.mock("@ffmpeg/ffmpeg", () => ({
  FFmpeg: mocks.FFmpegMock,
}));

vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: mocks.loggerError,
  },
}));

describe("ffmpeg-loader", () => {
  beforeEach(() => {
    resetFfmpeg();
    mocks.load.mockClear();
    mocks.terminate.mockClear();
    mocks.loggerInfo.mockClear();
    mocks.loggerError.mockClear();
    useAsrStore.setState({ telemetryCollector: null } as never);
  });

  it("loads ffmpeg once and caches instance", async () => {
    const first = await getFfmpeg();
    const second = await getFfmpeg();

    expect(first).toBe(second);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("emits telemetry events when loading succeeds", async () => {
    const telemetry = { logEvent: vi.fn() };
    useAsrStore.setState({ telemetryCollector: telemetry } as never);

    await getFfmpeg();

    expect(telemetry.logEvent).toHaveBeenCalledWith("FFMPEG_LOAD_START", expect.any(Object));
    expect(telemetry.logEvent).toHaveBeenCalledWith("FFMPEG_LOAD_DONE");
  });

  it("reports load failure and keeps rejecting", async () => {
    mocks.load.mockRejectedValueOnce(new Error("ffmpeg load failed"));
    const telemetry = { logEvent: vi.fn() };
    useAsrStore.setState({ telemetryCollector: telemetry } as never);

    await expect(getFfmpeg()).rejects.toThrow("ffmpeg load failed");
    await expect(getFfmpeg()).rejects.toThrow("ffmpeg load failed");
    expect(telemetry.logEvent).toHaveBeenCalledWith(
      "FFMPEG_LOAD_ERROR",
      expect.objectContaining({ message: "ffmpeg load failed" })
    );
  });

  it("releases the loaded ffmpeg instance and reloads on demand", async () => {
    const first = await getFfmpeg();

    await releaseFfmpeg();

    expect(mocks.terminate).toHaveBeenCalledTimes(1);

    const second = await getFfmpeg();
    expect(second).not.toBe(first);
    expect(mocks.load).toHaveBeenCalledTimes(2);
  });
});
