import { beforeEach, describe, expect, it, vi } from "vitest";
import { preprocessCloudAudio } from "./preprocessCloudAudio";

const mocks = vi.hoisted(() => ({
  mockDecode: vi.fn(async (file: File) => ({
    metadata: { durationSec: 1, sampleRate: 16000, name: file.name },
    pcm: new Float32Array([0, 0.1, -0.1, 0.2]),
    sampleRate: 16000,
  })),
  mockPreprocessDecoded: vi.fn(async () => ({
    pcm: new Float32Array([0.01, 0.02]),
    sampleRate: 16000,
    noiseProfile: new Float32Array([0.1, 0.2]),
  })),
  mockPreprocessPcm: vi.fn(async () => ({
    pcm: new Float32Array([0.03, 0.04]),
    sampleRate: 16000,
    noiseProfile: new Float32Array([0.3, 0.4]),
  })),
  mockEstimate: vi.fn(() => ({ profile: new Float32Array([0.1, 0.2]), frames: 2 })),
  mockEstimateVad: vi.fn(() => ({
    profile: new Float32Array([0.2, 0.3]),
    frames: 3,
    vadUsed: true,
    silenceRanges: 1,
  })),
  mockAutoTune: vi.fn(() => ({
    noiseFloorDb: -30,
    reductionDb: 8,
    smoothing: 0.8,
    targetLufs: -20,
    highpassHz: 80,
    lowpassHz: 7000,
    limiterThresholdDb: -1,
    limiterSoftness: 0.6,
    vadThresholdDb: -42,
    overlapBlockSec: 1,
    overlapSec: 0.2,
    snrDb: 15,
  })),
  mockExtractSegmentBlob: vi.fn(async (_file: File, segment: { index: number; startSec: number; endSec: number }) => ({
    blob: new Blob([`segment-${segment.index}`], { type: "audio/wav" }),
    mimeType: "audio/wav",
    name: "calibration.wav",
  })),
  mockEncodeWavBuffer: vi.fn(() => new Uint8Array([1, 2, 3, 4]).buffer),
}));

vi.mock("@/lib/audio", () => ({
  encodeWavBuffer: mocks.mockEncodeWavBuffer,
}));

vi.mock("@/lib/cloud/decodeCloudAudio", () => ({
  decodeCloudAudio: mocks.mockDecode,
}));

vi.mock("@/lib/cloud/segmentExtraction", () => ({
  extractSegmentBlob: mocks.mockExtractSegmentBlob,
}));

vi.mock("@/lib/preprocessing", () => ({
  estimateNoiseProfile: mocks.mockEstimate,
  estimateNoiseProfileWithVad: mocks.mockEstimateVad,
  preprocessDecodedAudio: mocks.mockPreprocessDecoded,
  preprocessPcmChunk: mocks.mockPreprocessPcm,
  computePreprocessParams: mocks.mockAutoTune,
}));

describe("preprocessCloudAudio", () => {
  beforeEach(() => {
    mocks.mockDecode.mockClear();
    mocks.mockPreprocessDecoded.mockClear();
    mocks.mockPreprocessPcm.mockClear();
    mocks.mockEstimate.mockClear();
    mocks.mockEstimateVad.mockClear();
    mocks.mockAutoTune.mockClear();
    mocks.mockExtractSegmentBlob.mockClear();
    mocks.mockEncodeWavBuffer.mockClear();
  });

  it("prepares and stages a processed wav in quick mode without autotune", async () => {
    const settings = {
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
      preprocessVadEnabled: false,
      preprocessVadThresholdDb: -42,
      preprocessVadMinSilenceMs: 200,
      preprocessOverlapAdd: true,
      preprocessOverlapBlockSec: 1.4,
      preprocessOverlapSec: 0.3,
      autoTunePreprocess: false,
    };
    const file = new File([""], "test.wav", { type: "audio/wav" });
    const result = await preprocessCloudAudio(file, settings);

    expect(result.applied).toBe(true);
    expect(result.tune).toBeUndefined();
    expect(result.noiseProfile).toBeDefined();
    expect(mocks.mockExtractSegmentBlob).toHaveBeenCalledTimes(1);
    expect(mocks.mockDecode).toHaveBeenCalledTimes(2);
    expect(mocks.mockDecode.mock.calls[0]?.[0]).toBeInstanceOf(File);
    expect((mocks.mockDecode.mock.calls[0]?.[0] as File).name).toBe("calibration.wav");
    expect(mocks.mockPreprocessDecoded).not.toHaveBeenCalled();
    expect(mocks.mockPreprocessPcm).toHaveBeenCalledTimes(1);
    expect(mocks.mockEncodeWavBuffer).toHaveBeenCalledWith(expect.any(Float32Array), 16000);
  });

  it("decodes only a calibration slice in quick mode when autotune is enabled", async () => {
    const settings = {
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
      autoTunePreprocess: true,
    };
    const file = new File([""], "test.wav", { type: "audio/wav" });
    const result = await preprocessCloudAudio(file, settings);

    expect(mocks.mockExtractSegmentBlob).toHaveBeenCalledWith(
      file,
      expect.objectContaining({ index: 0, startSec: 0, endSec: 1 }),
      undefined
    );
    expect(mocks.mockDecode).toHaveBeenCalledTimes(2);
    const calibrationFile = mocks.mockDecode.mock.calls[0]?.[0] as File;
    expect(calibrationFile.name).toBe("calibration.wav");
    expect(mocks.mockPreprocessDecoded).not.toHaveBeenCalled();
    expect(mocks.mockPreprocessPcm).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.tune?.noiseFloorDb).toBe(-30);
    expect(result.tune?.lowpassHz).toBe(7000);
    expect(mocks.mockAutoTune).toHaveBeenCalledTimes(1);
    expect(result.noiseProfile).toBeDefined();
  });

  it("continues quick processing when calibration fails", async () => {
    mocks.mockDecode.mockRejectedValueOnce(new Error("calibration failed"));
    const settings = {
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
      autoTunePreprocess: true,
    };
    const file = new File([""], "test.wav", { type: "audio/wav" });
    const result = await preprocessCloudAudio(file, settings);

    expect(result.applied).toBe(true);
    expect(result.tune).toBeUndefined();
    expect(result.noiseProfile).toBeUndefined();
    expect(mocks.mockExtractSegmentBlob).toHaveBeenCalled();
    expect(mocks.mockDecode).toHaveBeenCalledTimes(2);
    expect(mocks.mockPreprocessPcm).toHaveBeenCalledTimes(1);
  });

  it("returns a processed wav file in full mode", async () => {
    const settings = {
      preprocessingMode: "full" as const,
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
      autoTunePreprocess: true,
    };
    const file = new File([""], "test.wav", { type: "audio/wav" });
    const result = await preprocessCloudAudio(file, settings);

    expect(mocks.mockDecode).toHaveBeenCalledTimes(1);
    expect(mocks.mockPreprocessDecoded).toHaveBeenCalledTimes(1);
    expect(mocks.mockPreprocessPcm).not.toHaveBeenCalled();
    expect(mocks.mockAutoTune).toHaveBeenCalledTimes(1);
    expect(mocks.mockEncodeWavBuffer).toHaveBeenCalledWith(expect.any(Float32Array), 16000);
    expect(result.applied).toBe(true);
    expect(result.uploadFile.type).toBe("audio/wav");
    expect(result.uploadFile.name).toBe("test-cloud.wav");
    expect(result.uploadFile.size).toBeGreaterThan(0);
    expect(result.tune?.noiseFloorDb).toBe(-30);
    expect(result.noiseProfile).toBeDefined();
  });
});
