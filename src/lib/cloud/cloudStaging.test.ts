import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelemetryCollector } from "@/lib/telemetry";
import { stageCloudSegments } from "./cloudStaging";

const mocks = vi.hoisted(() => ({
  extractSegmentBlob: vi.fn(),
  preprocessCloudAudio: vi.fn(),
  putSegment: vi.fn(),
  probeAudioMetadata: vi.fn(),
}));

vi.mock("@/lib/cloud/segmentExtraction", () => ({
  extractSegmentBlob: mocks.extractSegmentBlob,
}));

vi.mock("@/lib/cloud/preprocessCloudAudio", () => ({
  preprocessCloudAudio: mocks.preprocessCloudAudio,
}));

vi.mock("@/lib/segment-cache", () => ({
  putSegment: mocks.putSegment,
}));

vi.mock("@/lib/audio", () => ({
  probeAudioMetadata: mocks.probeAudioMetadata,
}));

function buildPreprocessSettings() {
  return {
    preprocessingMode: "quick" as const,
    denoiseNoiseFloorDb: -28,
    denoiseReductionDb: 10,
    denoiseSmoothing: 0.8,
    denoiseCalibrationSeconds: 1,
    preprocessEnableFilters: true,
    preprocessHighpassHz: 80,
    preprocessLowpassHz: 7000,
    preprocessEnableLufs: true,
    preprocessTargetLufs: -20,
    preprocessLimiterEnabled: true,
    preprocessLimiterThresholdDb: -1,
    preprocessLimiterSoftness: 0.6,
    preprocessVadEnabled: true,
    preprocessVadThresholdDb: -42,
    preprocessVadMinSilenceMs: 200,
    preprocessOverlapAdd: true,
    preprocessOverlapBlockSec: 1.4,
    preprocessOverlapSec: 0.3,
    autoTunePreprocess: false,
  };
}

function buildTelemetry(): TelemetryCollector {
  return {
    logEvent: vi.fn(),
    recordAlert: vi.fn(),
  } as unknown as TelemetryCollector;
}

describe("stageCloudSegments", () => {
  beforeEach(() => {
    mocks.extractSegmentBlob.mockReset();
    mocks.preprocessCloudAudio.mockReset();
    mocks.putSegment.mockReset();
    mocks.probeAudioMetadata.mockReset();
  });

  it("keeps readable audio segments with a supported format", async () => {
    const sourceFile = new File(["source"], "source.wav", { type: "audio/wav" });
    const uploadFile = new File([new Uint8Array([1, 2, 3, 4])], "segment_0.wav", { type: "audio/wav" });
    const telemetry = buildTelemetry();

    mocks.extractSegmentBlob.mockResolvedValue({
      blob: new Blob(["segment"], { type: "audio/webm;codecs=opus" }),
      mimeType: "audio/webm;codecs=opus",
      name: "segment_0.webm",
    });
    mocks.preprocessCloudAudio.mockResolvedValue({
      uploadFile,
      applied: true,
    });
    mocks.probeAudioMetadata.mockResolvedValue({
      durationSec: 1.5,
      sampleRate: 16000,
    });

    const result = await stageCloudSegments({
      sessionId: "session-1",
      sourceFile,
      provider: "demeter_sante",
      segments: [{ startSec: 0, endSec: 1.5 }],
      preprocessSettings: buildPreprocessSettings(),
      telemetry,
      shouldAbort: () => false,
    });

    expect(result.aborted).toBe(false);
    expect(result.stagedSegments).toHaveLength(1);
    expect(mocks.putSegment).toHaveBeenCalledTimes(1);
    expect(mocks.probeAudioMetadata).toHaveBeenCalledWith(uploadFile);
  });

  it("rejects a staged segment when the generated file format is unsupported", async () => {
    const sourceFile = new File(["source"], "source.wav", { type: "audio/wav" });
    const telemetry = buildTelemetry();

    mocks.extractSegmentBlob.mockResolvedValue({
      blob: new Blob(["segment"], { type: "audio/webm;codecs=opus" }),
      mimeType: "audio/webm;codecs=opus",
      name: "segment_0.webm",
    });
    mocks.preprocessCloudAudio.mockResolvedValue({
      uploadFile: new File([new Uint8Array([1, 2, 3])], "segment_0.bin", { type: "application/octet-stream" }),
      applied: true,
    });

    await expect(
      stageCloudSegments({
        sessionId: "session-1",
        sourceFile,
        provider: "demeter_sante",
        segments: [{ startSec: 0, endSec: 1.5 }],
        preprocessSettings: buildPreprocessSettings(),
        telemetry,
        shouldAbort: () => false,
      })
    ).rejects.toThrow("format non supporté");

    expect(mocks.putSegment).not.toHaveBeenCalled();
    expect(mocks.probeAudioMetadata).not.toHaveBeenCalled();
    expect((telemetry.recordAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "CLOUD_STAGE_SEGMENT_INVALID"
    );
  });

  it("rejects a staged segment when the generated file is unreadable", async () => {
    const sourceFile = new File(["source"], "source.wav", { type: "audio/wav" });
    const telemetry = buildTelemetry();

    mocks.extractSegmentBlob.mockResolvedValue({
      blob: new Blob(["segment"], { type: "audio/webm;codecs=opus" }),
      mimeType: "audio/webm;codecs=opus",
      name: "segment_0.webm",
    });
    mocks.preprocessCloudAudio.mockResolvedValue({
      uploadFile: new File([new Uint8Array([1, 2, 3])], "segment_0.wav", { type: "audio/wav" }),
      applied: true,
    });
    mocks.probeAudioMetadata.mockResolvedValue({
      durationSec: 0,
      sampleRate: 16000,
    });

    await expect(
      stageCloudSegments({
        sessionId: "session-1",
        sourceFile,
        provider: "demeter_sante",
        segments: [{ startSec: 0, endSec: 1.5 }],
        preprocessSettings: buildPreprocessSettings(),
        telemetry,
        shouldAbort: () => false,
      })
    ).rejects.toThrow("illisible");

    expect(mocks.putSegment).not.toHaveBeenCalled();
    expect(mocks.probeAudioMetadata).toHaveBeenCalledTimes(1);
    expect((telemetry.recordAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(
      "CLOUD_STAGE_SEGMENT_INVALID"
    );
  });
});
