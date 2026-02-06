import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import {
  serializeVtt,
  serializeSrt,
  serializeSegmentsJson,
  serializeTelemetry,
  downloadBlob,
  type TranscriptionSegment,
  type ExportHeader,
} from "@/lib/export";
import type { TelemetrySummary } from "@/lib/telemetry";
import { useCallback } from "react";
import { resolveModelId, useAsrStore } from "@/store/asr-store";

interface ExportButtonsProps {
  segments: TranscriptionSegment[];
  telemetry?: TelemetrySummary;
  showVtt?: boolean;
  showSrt?: boolean;
  showJson?: boolean;
  showTelemetry?: boolean;
  mode?: "upload" | "mic" | "cloud";
}

export function ExportButtons({
  segments,
  telemetry,
  showVtt,
  showSrt,
  showJson,
  showTelemetry,
  mode = "upload",
}: ExportButtonsProps) {
  const exportVtt = useCallback(() => {
    if (!segments.length) return;
    const header = buildExportHeader(mode);
    downloadBlob(serializeVtt(segments, header), buildFilename("transcription.vtt"), "text/vtt");
  }, [mode, segments]);

  const exportSrt = useCallback(() => {
    if (!segments.length) return;
    const header = buildExportHeader(mode);
    downloadBlob(serializeSrt(segments, header), buildFilename("transcription.srt"), "text/plain");
  }, [mode, segments]);

  const exportJson = useCallback(() => {
    if (!segments.length) return;
    const header = buildExportHeader(mode);
    downloadBlob(serializeSegmentsJson(segments, header), buildFilename("segments.json"), "application/json");
  }, [mode, segments]);

  const exportTelemetry = useCallback(() => {
    if (!telemetry) return;
    const header = buildExportHeader(mode);
    downloadBlob(serializeTelemetry(telemetry, header), buildFilename("telemetry.json"), "application/json");
  }, [mode, telemetry]);

  const storeShowVtt = useAsrStore((s) => s.showExportVtt);
  const storeShowSrt = useAsrStore((s) => s.showExportSrt);
  const storeShowJson = useAsrStore((s) => s.showExportJson);
  const storeShowTelemetry = useAsrStore((s) => s.showExportTelemetry);
  const showExportVtt = typeof showVtt === "boolean" ? showVtt : storeShowVtt;
  const showExportSrt = typeof showSrt === "boolean" ? showSrt : storeShowSrt;
  const showExportJson = typeof showJson === "boolean" ? showJson : storeShowJson;
  const showExportTelemetry = typeof showTelemetry === "boolean" ? showTelemetry : storeShowTelemetry;

  return (
    <div className="flex flex-wrap gap-2">
      {showExportVtt ? (
        <Button variant="outline" size="sm" className="gap-2" onClick={exportVtt} disabled={!segments.length}>
          <Download className="h-4 w-4" /> VTT
        </Button>
      ) : null}

      {showExportSrt ? (
        <Button variant="outline" size="sm" className="gap-2" onClick={exportSrt} disabled={!segments.length}>
          <Download className="h-4 w-4" /> SRT
        </Button>
      ) : null}

      {showExportJson ? (
        <Button variant="outline" size="sm" className="gap-2" onClick={exportJson} disabled={!segments.length}>
          <Download className="h-4 w-4" /> JSON
        </Button>
      ) : null}

      {showExportTelemetry ? (
        <Button variant="outline" size="sm" className="gap-2" onClick={exportTelemetry} disabled={!telemetry}>
          <Download className="h-4 w-4" /> Telemetry
        </Button>
      ) : null}
    </div>
  );
}

function buildFilename(suffix: string) {
  const now = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
  return `transcription-${now}-${suffix}`;
}

function buildExportHeader(mode: "upload" | "mic" | "cloud"): ExportHeader {
  const state = useAsrStore.getState();
  return {
    exportedAt: new Date().toISOString(),
    mode,
    settings: {
      file: {
        activePreset: state.activePreset,
        customModelId: state.customModelId,
        backendPreference: state.backendPreference,
        memoryMode: state.memoryMode,
        chunkStrategy: state.chunkStrategy,
        segmentationMode: state.segmentationMode,
        dedupeMode: state.dedupeMode,
        cleanIntraChunk: state.cleanIntraChunk,
        preprocessingMode: state.preprocessingMode,
        chunkDurationSec: state.chunkDurationSec,
        overlapSec: state.overlapSec,
        progressiveSegmentDurationSec: state.progressiveSegmentDurationSec,
        silenceThresholdDb: state.silenceThresholdDb,
        minSilenceMs: state.minSilenceMs,
        minChunkMs: state.minChunkMs,
        maxChunkMs: state.maxChunkMs,
        showExportVtt: state.showExportVtt,
        showExportSrt: state.showExportSrt,
        showExportJson: state.showExportJson,
        showExportTelemetry: state.showExportTelemetry,
        denoiseNoiseFloorDb: state.denoiseNoiseFloorDb,
        denoiseReductionDb: state.denoiseReductionDb,
        denoiseSmoothing: state.denoiseSmoothing,
        denoiseCalibrationSeconds: state.denoiseCalibrationSeconds,
        preprocessEnableFilters: state.preprocessEnableFilters,
        preprocessHighpassHz: state.preprocessHighpassHz,
        preprocessLowpassHz: state.preprocessLowpassHz,
        preprocessEnableLufs: state.preprocessEnableLufs,
        preprocessTargetLufs: state.preprocessTargetLufs,
        preprocessLimiterEnabled: state.preprocessLimiterEnabled,
        preprocessLimiterThresholdDb: state.preprocessLimiterThresholdDb,
        preprocessLimiterSoftness: state.preprocessLimiterSoftness,
        preprocessVadEnabled: state.preprocessVadEnabled,
        preprocessVadThresholdDb: state.preprocessVadThresholdDb,
        preprocessVadMinSilenceMs: state.preprocessVadMinSilenceMs,
        preprocessOverlapAdd: state.preprocessOverlapAdd,
        preprocessOverlapBlockSec: state.preprocessOverlapBlockSec,
        preprocessOverlapSec: state.preprocessOverlapSec,
        autoTunePreprocess: state.autoTunePreprocess,
        enableWordTimestamps: state.enableWordTimestamps,
        showSegmentConfidence: state.showSegmentConfidence,
        debugConfidence: state.debugConfidence,
        forceSingleThread: state.forceSingleThread,
      },
      mic: {
        micActivePreset: state.micActivePreset,
        micCustomModelId: state.micCustomModelId,
        micBackendPreference: state.micBackendPreference,
        micPreprocessingMode: state.micPreprocessingMode,
        micSegmentationMode: state.micSegmentationMode,
        micSilenceThresholdDb: state.micSilenceThresholdDb,
        micNoiseCalibrationMarginDb: state.micNoiseCalibrationMarginDb,
        micMinSilenceMs: state.micMinSilenceMs,
        micMinChunkMs: state.micMinChunkMs,
        micMaxChunkMs: state.micMaxChunkMs,
        micShowExportVtt: state.micShowExportVtt,
        micShowExportSrt: state.micShowExportSrt,
        micShowExportJson: state.micShowExportJson,
        micShowExportTelemetry: state.micShowExportTelemetry,
        micDenoiseNoiseFloorDb: state.micDenoiseNoiseFloorDb,
        micDenoiseReductionDb: state.micDenoiseReductionDb,
        micDenoiseSmoothing: state.micDenoiseSmoothing,
        micDenoiseCalibrationSeconds: state.micDenoiseCalibrationSeconds,
        micPreprocessEnableFilters: state.micPreprocessEnableFilters,
        micPreprocessHighpassHz: state.micPreprocessHighpassHz,
        micPreprocessLowpassHz: state.micPreprocessLowpassHz,
        micPreprocessEnableLufs: state.micPreprocessEnableLufs,
        micPreprocessTargetLufs: state.micPreprocessTargetLufs,
        micPreprocessLimiterEnabled: state.micPreprocessLimiterEnabled,
        micPreprocessLimiterThresholdDb: state.micPreprocessLimiterThresholdDb,
        micPreprocessLimiterSoftness: state.micPreprocessLimiterSoftness,
        micPreprocessVadEnabled: state.micPreprocessVadEnabled,
        micPreprocessVadThresholdDb: state.micPreprocessVadThresholdDb,
        micPreprocessVadMinSilenceMs: state.micPreprocessVadMinSilenceMs,
        micPreprocessOverlapAdd: state.micPreprocessOverlapAdd,
        micPreprocessOverlapBlockSec: state.micPreprocessOverlapBlockSec,
        micPreprocessOverlapSec: state.micPreprocessOverlapSec,
        micAutoTunePreprocess: state.micAutoTunePreprocess,
        micEnableWordTimestamps: state.micEnableWordTimestamps,
        micShowSegmentConfidence: state.micShowSegmentConfidence,
        micForceSingleThread: state.micForceSingleThread,
      },
      cloud: {
        cloudApiUrl: state.cloudApiUrl,
        cloudMaxTokens: state.cloudMaxTokens,
        cloudTemperature: state.cloudTemperature,
        cloudTopP: state.cloudTopP,
        cloudDoSample: state.cloudDoSample,
        cloudContextPreset: state.cloudContextPreset,
        cloudShowSegments: state.cloudShowSegments,
        cloudShowExportVtt: state.cloudShowExportVtt,
        cloudShowExportSrt: state.cloudShowExportSrt,
        cloudShowExportJson: state.cloudShowExportJson,
        cloudShowExportTelemetry: state.cloudShowExportTelemetry,
        cloudPreprocessingMode: state.cloudPreprocessingMode,
        cloudDenoiseNoiseFloorDb: state.cloudDenoiseNoiseFloorDb,
        cloudDenoiseReductionDb: state.cloudDenoiseReductionDb,
        cloudDenoiseSmoothing: state.cloudDenoiseSmoothing,
        cloudDenoiseCalibrationSeconds: state.cloudDenoiseCalibrationSeconds,
        cloudPreprocessEnableFilters: state.cloudPreprocessEnableFilters,
        cloudPreprocessHighpassHz: state.cloudPreprocessHighpassHz,
        cloudPreprocessLowpassHz: state.cloudPreprocessLowpassHz,
        cloudPreprocessEnableLufs: state.cloudPreprocessEnableLufs,
        cloudPreprocessTargetLufs: state.cloudPreprocessTargetLufs,
        cloudPreprocessLimiterEnabled: state.cloudPreprocessLimiterEnabled,
        cloudPreprocessLimiterThresholdDb: state.cloudPreprocessLimiterThresholdDb,
        cloudPreprocessLimiterSoftness: state.cloudPreprocessLimiterSoftness,
        cloudPreprocessVadEnabled: state.cloudPreprocessVadEnabled,
        cloudPreprocessVadThresholdDb: state.cloudPreprocessVadThresholdDb,
        cloudPreprocessVadMinSilenceMs: state.cloudPreprocessVadMinSilenceMs,
        cloudPreprocessOverlapAdd: state.cloudPreprocessOverlapAdd,
        cloudPreprocessOverlapBlockSec: state.cloudPreprocessOverlapBlockSec,
        cloudPreprocessOverlapSec: state.cloudPreprocessOverlapSec,
        cloudAutoTunePreprocess: state.cloudAutoTunePreprocess,
        cloudEnableWordTimestamps: state.cloudEnableWordTimestamps,
        cloudShowSegmentConfidence: state.cloudShowSegmentConfidence,
      },
    },
    runtime: {
      activeBackend: state.activeBackend,
      activePreset: state.activePreset,
      activeModelId: resolveModelId(state.activePreset, state.customModelId),
      micActiveModelId: resolveModelId(state.micActivePreset, state.micCustomModelId),
      preprocessingMode: state.preprocessingMode,
      micPreprocessingMode: state.micPreprocessingMode,
      cloudApiUrl: state.cloudApiUrl,
    },
  };
}
