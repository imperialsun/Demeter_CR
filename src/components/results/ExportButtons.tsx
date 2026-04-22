import { Download, Loader2, Users } from "lucide-react";
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
import { memo, useCallback, useMemo, useState } from "react";
import { useAsrStore } from "@/store/asr-store";
import {
  applySpeakerAssignments,
  collectSpeakerAssignmentEntries,
  type SpeakerAssignmentMap,
} from "@/lib/speakerAssignments";
import { SpeakerAssignmentDialog } from "@/components/results/SpeakerAssignmentDialog";
import logger from "@/lib/logger";
import { TooltipButton } from "@/components/ui/tooltip-button";

interface ExportButtonsProps {
  segments?: TranscriptionSegment[];
  segmentCount?: number;
  loadSegments?: () => Promise<TranscriptionSegment[]>;
  telemetry?: TelemetrySummary;
  showVtt?: boolean;
  showSrt?: boolean;
  showJson?: boolean;
  showTelemetry?: boolean;
  showDocx?: boolean;
  mode?: "upload" | "mic" | "cloud";
  onSpeakerAssignmentsApplied?: () => void | Promise<void>;
}

export const ExportButtons = memo(function ExportButtons({
  segments = [],
  segmentCount,
  loadSegments,
  telemetry,
  showVtt,
  showSrt,
  showJson,
  showTelemetry,
  showDocx,
  mode = "upload",
  onSpeakerAssignmentsApplied,
}: ExportButtonsProps) {
  const [isSpeakerDialogOpen, setSpeakerDialogOpen] = useState(false);
  const [isDocxExporting, setDocxExporting] = useState(false);
  const speakerAssignments = useAsrStore((s) => s.speakerAssignments[mode]);
  const setSpeakerAssignments = useAsrStore((s) => s.setSpeakerAssignments);
  const audioSource = useAsrStore((s) => s.audioSource);
  const uploadedFile = useAsrStore((s) => s.uploadedFile);
  const speakerEntries = useMemo(
    () => (mode === "cloud" ? [] : collectSpeakerAssignmentEntries(segments, mode)),
    [mode, segments]
  );
  const resolvedSegmentCount = typeof segmentCount === "number" ? segmentCount : segments.length;
  const sourceLabel = audioSource?.label?.trim() || uploadedFile?.name?.trim() || undefined;
  const showExportDocx = Boolean(showDocx && resolvedSegmentCount);

  const resolveSegmentsForExport = useCallback(async () => {
    const rawSegments = mode === "cloud" && loadSegments ? await loadSegments() : segments;
    return applySpeakerAssignments(rawSegments, speakerAssignments, mode);
  }, [loadSegments, mode, segments, speakerAssignments]);

  const exportVtt = useCallback(async () => {
    const segmentsForExport = await resolveSegmentsForExport();
    if (!segmentsForExport.length) return;
    const header = buildExportHeader(mode);
    logger.info("[export] VTT download requested", {
      mode,
      segmentCount: segmentsForExport.length,
      filename: buildFilename("transcription.vtt"),
    });
    downloadBlob(serializeVtt(segmentsForExport, header), buildFilename("transcription.vtt"), "text/vtt");
  }, [mode, resolveSegmentsForExport]);

  const exportSrt = useCallback(async () => {
    const segmentsForExport = await resolveSegmentsForExport();
    if (!segmentsForExport.length) return;
    const header = buildExportHeader(mode);
    logger.info("[export] SRT download requested", {
      mode,
      segmentCount: segmentsForExport.length,
      filename: buildFilename("transcription.srt"),
    });
    downloadBlob(serializeSrt(segmentsForExport, header), buildFilename("transcription.srt"), "text/plain");
  }, [mode, resolveSegmentsForExport]);

  const exportJson = useCallback(async () => {
    const segmentsForExport = await resolveSegmentsForExport();
    if (!segmentsForExport.length) return;
    const header = buildExportHeader(mode);
    logger.info("[export] JSON download requested", {
      mode,
      segmentCount: segmentsForExport.length,
      filename: buildFilename("segments.json"),
    });
    downloadBlob(serializeSegmentsJson(segmentsForExport, header), buildFilename("segments.json"), "application/json");
  }, [mode, resolveSegmentsForExport]);

  const exportTelemetry = useCallback(() => {
    if (!telemetry) return;
    const header = buildExportHeader(mode);
    logger.info("[export] telemetry download requested", {
      mode,
      filename: buildFilename("telemetry.json"),
    });
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

  const exportDocx = useCallback(async () => {
    if (isDocxExporting) {
      return;
    }
    setDocxExporting(true);
    const generatedAt = new Date().toISOString();
    const segmentsForExport = await resolveSegmentsForExport();
    if (!segmentsForExport.length) {
      setDocxExporting(false);
      return;
    }
    logger.info("[export] DOCX download requested", {
      mode,
      segmentCount: segmentsForExport.length,
      sourceLabel: sourceLabel ?? null,
    });
    try {
      const { buildTranscriptDocx, downloadDocxBlob, formatTranscriptDocxFilename } = await import(
        "@/lib/docx/transcriptDocx"
      );
      const blob = await buildTranscriptDocx(segmentsForExport, {
        sourceMode: mode,
        sourceLabel,
        generatedAt,
      });
      const filename = formatTranscriptDocxFilename(new Date(generatedAt));
      downloadDocxBlob(blob, filename);
      logger.info("[export] DOCX download done", {
        mode,
        segmentCount: segmentsForExport.length,
        sourceLabel: sourceLabel ?? null,
        filename,
      });
    } catch (error) {
      logger.error("[export] DOCX download failed", {
        mode,
        segmentCount: segmentsForExport.length,
        sourceLabel: sourceLabel ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDocxExporting(false);
    }
  }, [isDocxExporting, mode, resolveSegmentsForExport, sourceLabel]);

  const handleApplySpeakerAssignments = useCallback(
    (nextAssignments: SpeakerAssignmentMap) => {
      logger.info("[results] speaker assignments applied", {
        mode,
        speakerCount: Object.keys(nextAssignments).length,
      });
      setSpeakerAssignments(mode, nextAssignments);
      if (onSpeakerAssignmentsApplied) {
        void onSpeakerAssignmentsApplied();
      }
      setSpeakerDialogOpen(false);
    },
    [mode, onSpeakerAssignmentsApplied, setSpeakerAssignments]
  );

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {showExportDocx ? (
          <TooltipButton
            tooltip="Télécharge la transcription complète au format DOCX avec les intervenants résolus."
            className="gap-2"
            disabled={isDocxExporting}
            onClick={() => {
              void exportDocx();
            }}
            size="sm"
            variant="default"
          >
            {isDocxExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Télécharger en DOCX
          </TooltipButton>
        ) : null}

        {speakerEntries.length ? (
          <TooltipButton
            tooltip="Ouvre la fenêtre de renommage global des intervenants pour cette session."
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              logger.info("[results] opening speaker assignment dialog", {
                mode,
                speakerCount: speakerEntries.length,
              });
              setSpeakerDialogOpen(true);
            }}
          >
            <Users className="h-4 w-4" /> Nommer les intervenants
          </TooltipButton>
        ) : null}

        {showExportVtt ? (
          <TooltipButton
            tooltip="Télécharge les sous-titres au format VTT."
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void exportVtt()}
            disabled={!resolvedSegmentCount}
          >
            <Download className="h-4 w-4" /> VTT
          </TooltipButton>
        ) : null}

        {showExportSrt ? (
          <TooltipButton
            tooltip="Télécharge les sous-titres au format SRT."
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void exportSrt()}
            disabled={!resolvedSegmentCount}
          >
            <Download className="h-4 w-4" /> SRT
          </TooltipButton>
        ) : null}

        {showExportJson ? (
          <TooltipButton
            tooltip="Télécharge les segments au format JSON."
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void exportJson()}
            disabled={!resolvedSegmentCount}
          >
            <Download className="h-4 w-4" /> JSON
          </TooltipButton>
        ) : null}

        {showExportTelemetry ? (
          <TooltipButton
            tooltip="Télécharge la télémétrie associée à cette session."
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={exportTelemetry}
            disabled={!telemetry}
          >
            <Download className="h-4 w-4" /> Telemetry
          </TooltipButton>
        ) : null}
      </div>

      {mode !== "cloud" && isSpeakerDialogOpen ? (
        <SpeakerAssignmentDialog
          mode={mode}
          entries={speakerEntries}
          assignments={speakerAssignments}
          onCancel={() => {
            logger.debug("[results] speaker assignment dialog cancelled", { mode });
            setSpeakerDialogOpen(false);
          }}
          onApply={handleApplySpeakerAssignments}
        />
      ) : null}
    </>
  );
});

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
