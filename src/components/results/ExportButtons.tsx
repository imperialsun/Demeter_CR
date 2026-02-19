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
import { useAsrStore } from "@/store/asr-store";

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
  const runHeader = state.runExportHeaders[mode];

  if (runHeader) {
    return {
      ...runHeader,
      exportedAt: new Date().toISOString(),
    };
  }

  return buildFallbackExportHeader(mode, state);
}

function buildFallbackExportHeader(
  mode: "upload" | "mic" | "cloud",
  state: ReturnType<typeof useAsrStore.getState>
): ExportHeader {
  if (mode === "upload") {
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
          preprocessingMode: state.preprocessingMode,
          enableWordTimestamps: state.enableWordTimestamps,
          showSegmentConfidence: state.showSegmentConfidence,
        },
      },
      runtime: {
        activeBackend: state.activeBackend ?? null,
        source: "fallback-current-settings",
      },
    };
  }

  if (mode === "mic") {
    return {
      exportedAt: new Date().toISOString(),
      mode,
      settings: {
        mic: {
          micActivePreset: state.micActivePreset,
          micCustomModelId: state.micCustomModelId,
          micBackendPreference: state.micBackendPreference,
          micPreprocessingMode: state.micPreprocessingMode,
          micSegmentationMode: state.micSegmentationMode,
          micEnableWordTimestamps: state.micEnableWordTimestamps,
          micShowSegmentConfidence: state.micShowSegmentConfidence,
        },
      },
      runtime: {
        activeBackend: state.activeBackend ?? null,
        source: "fallback-current-settings",
      },
    };
  }

  return {
    exportedAt: new Date().toISOString(),
    mode,
    settings: {
      cloud: {
        provider: "unknown",
        cloudPreprocessingMode: state.cloudPreprocessingMode,
        cloudAutoTunePreprocess: state.cloudAutoTunePreprocess,
        cloudEnableWordTimestamps: state.cloudEnableWordTimestamps,
        cloudShowSegmentConfidence: state.cloudShowSegmentConfidence,
      },
    },
    runtime: {
      source: "fallback-current-settings",
    },
  };
}
