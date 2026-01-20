import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import {
  serializeVtt,
  serializeSrt,
  serializeSegmentsJson,
  serializeTelemetry,
  downloadBlob,
  type TranscriptionSegment,
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
}

export function ExportButtons({
  segments,
  telemetry,
  showVtt,
  showSrt,
  showJson,
  showTelemetry,
}: ExportButtonsProps) {
  const exportVtt = useCallback(() => {
    if (!segments.length) return;
    downloadBlob(serializeVtt(segments), buildFilename("transcription.vtt"), "text/vtt");
  }, [segments]);

  const exportSrt = useCallback(() => {
    if (!segments.length) return;
    downloadBlob(serializeSrt(segments), buildFilename("transcription.srt"), "text/plain");
  }, [segments]);

  const exportJson = useCallback(() => {
    if (!segments.length) return;
    downloadBlob(serializeSegmentsJson(segments), buildFilename("segments.json"), "application/json");
  }, [segments]);

  const exportTelemetry = useCallback(() => {
    if (!telemetry) return;
    downloadBlob(serializeTelemetry(telemetry), buildFilename("telemetry.json"), "application/json");
  }, [telemetry]);

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
