import { describe, it, expect, vi, beforeEach } from "vitest";
import { preprocessCloudAudio } from "./preprocessCloudAudio";

const mocks = vi.hoisted(() => ({
  mockDecode: vi.fn(async () => ({
    metadata: { durationSec: 1, sampleRate: 16000 },
    pcm: new Float32Array([0, 0.1, -0.1, 0.2]),
    sampleRate: 16000,
  })),
  mockPreprocess: vi.fn(async () => ({
    pcm: new Float32Array([0.01, 0.02]),
    sampleRate: 16000,
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
}));

vi.mock("@/lib/cloud/decodeCloudAudio", () => ({
  decodeCloudAudio: mocks.mockDecode,
}));

vi.mock("@/lib/preprocessing", () => ({
  estimateNoiseProfile: mocks.mockEstimate,
  estimateNoiseProfileWithVad: mocks.mockEstimateVad,
  preprocessDecodedAudio: mocks.mockPreprocess,
  computePreprocessParams: mocks.mockAutoTune,
}));

describe("preprocessCloudAudio", () => {
  beforeEach(() => {
    mocks.mockDecode.mockClear();
    mocks.mockPreprocess.mockClear();
    mocks.mockEstimate.mockClear();
    mocks.mockEstimateVad.mockClear();
    mocks.mockAutoTune.mockClear();
  });

  it("returns decoded audio without applying preprocessing in quick mode", async () => {
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
    expect(mocks.mockDecode).toHaveBeenCalled();
    expect(mocks.mockPreprocess).not.toHaveBeenCalled();
    expect(result.applied).toBe(false);
    expect(result.processed.pcm.length).toBe(4);
  });

  it("applies preprocessing in full mode and computes autotune", async () => {
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
    expect(mocks.mockDecode).toHaveBeenCalled();
    expect(mocks.mockPreprocess).toHaveBeenCalled();
    expect(mocks.mockAutoTune).toHaveBeenCalled();
    expect(result.applied).toBe(true);
    expect(result.processed.pcm.length).toBe(2);
    expect(result.tune?.noiseFloorDb).toBe(-30);
  });
});
