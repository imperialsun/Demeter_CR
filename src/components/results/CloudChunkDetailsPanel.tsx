import { createPortal } from "react-dom";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResultsTable } from "@/components/results/ResultsTable";
import { SpeakerAssignmentDialog } from "@/components/results/SpeakerAssignmentDialog";
import { formatCloudChunkTimeRange, type CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";
import {
  collectSpeakerAssignmentEntries,
  resolveSegmentSpeakerLabel,
  type SpeakerAssignmentMap,
} from "@/lib/speakerAssignments";
import type { AudioMetadata } from "@/lib/audio";
import type { TranscriptionSegment } from "@/lib/export";
import logger from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";
import { PanelRightClose, Users } from "lucide-react";

interface CloudChunkDetailsPanelProps {
  chunk: CloudTranscriptionChunkGroup;
  segments?: TranscriptionSegment[];
  loadChunkSegments?: (chunkId: string) => Promise<TranscriptionSegment[]>;
  file?: File | null;
  previewUrl?: string | null;
  metadata?: AudioMetadata | null;
  showSegmentConfidence?: boolean;
  enableWordTimestamps?: boolean;
  segmentEditingDisabled?: boolean;
  autoPlayRequestId?: number | null;
  onAutoPlayRequestConsumed?: () => void;
  onSegmentTextChange?: (segmentIndex: number, text: string) => void | Promise<void>;
  onSegmentSpeakerChange?: (segmentIndex: number, speakerId: string) => void | Promise<void>;
  onClose: () => void;
}

export const CloudChunkDetailsPanel = memo(function CloudChunkDetailsPanel({
  chunk,
  segments,
  loadChunkSegments,
  file,
  previewUrl,
  metadata,
  showSegmentConfidence,
  enableWordTimestamps,
  segmentEditingDisabled = false,
  autoPlayRequestId,
  onAutoPlayRequestConsumed,
  onSegmentTextChange,
  onSegmentSpeakerChange,
  onClose,
}: CloudChunkDetailsPanelProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [speakerDialogOpen, setSpeakerDialogOpen] = useState(false);
  const [localSegments, setLocalSegments] = useState<TranscriptionSegment[]>(segments ?? []);
  const [isLoadingSegments, setIsLoadingSegments] = useState<boolean>(Boolean(loadChunkSegments && !segments?.length));
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const speakerAssignments = useAsrStore((state) => state.speakerAssignments.cloud);
  const setSpeakerAssignments = useAsrStore((state) => state.setSpeakerAssignments);

  useEffect(() => {
    if (segments) {
      setLocalSegments(segments);
      setIsLoadingSegments(false);
      return;
    }
    if (!loadChunkSegments) {
      setLocalSegments([]);
      setIsLoadingSegments(false);
      return;
    }

    let cancelled = false;
    setIsLoadingSegments(true);
    setLocalSegments([]);

    void loadChunkSegments(chunk.chunkId)
      .then((nextSegments) => {
        if (!cancelled) {
          setLocalSegments(nextSegments);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          logger.warn("[cloud][ui] failed to load chunk segments", {
            chunkId: chunk.chunkId,
            message: error instanceof Error ? error.message : String(error),
          });
          setLocalSegments([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSegments(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [chunk.chunkId, chunk.segmentCount, loadChunkSegments, segments]);

  useEffect(() => {
    const modalRoot = modalRef.current;
    if (!modalRoot) {
      return;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const rafId = window.requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }

      const target = event.target;
      if (target instanceof Element) {
        const closestDialog = target.closest('[role="dialog"]');
        if (closestDialog && closestDialog !== modalRoot) {
          return;
        }
      }

      event.preventDefault();
      onClose();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(rafId);
    };
  }, [onClose]);

  const localSpeakerEntries = useMemo(
    () =>
      speakerDialogOpen
        ? collectSpeakerAssignmentEntries(localSegments, "cloud").map((entry) => ({
            ...entry,
            chunkLabel: chunk.label,
          }))
        : [],
    [chunk.label, localSegments, speakerDialogOpen]
  );

  const speakerOptions = useMemo(
    () =>
      chunk.speakerIds.map((speakerId) => {
        const resolvedLabel =
          resolveSegmentSpeakerLabel({ chunkId: chunk.chunkId, speaker: speakerId }, speakerAssignments, "cloud") ??
          speakerId;
        return {
          value: speakerId,
          label: resolvedLabel === speakerId ? speakerId : `${resolvedLabel} · ${speakerId}`,
        };
      }),
    [chunk.chunkId, chunk.speakerIds, speakerAssignments]
  );

  const resolvedSpeakers = useMemo(() => {
    const labels = new Set<string>();
    for (const speakerId of chunk.speakerIds) {
      const label = resolveSegmentSpeakerLabel({ chunkId: chunk.chunkId, speaker: speakerId }, speakerAssignments, "cloud");
      if (label) {
        labels.add(label);
      }
    }
    return [...labels];
  }, [chunk.chunkId, chunk.speakerIds, speakerAssignments]);

  const handleApplySpeakerAssignments = (nextAssignments: SpeakerAssignmentMap) => {
    const mergedAssignments = { ...speakerAssignments };
    for (const key of Object.keys(mergedAssignments)) {
      if (key.startsWith(`${chunk.chunkId}::`)) {
        delete mergedAssignments[key];
      }
    }
    for (const [key, value] of Object.entries(nextAssignments)) {
      mergedAssignments[key] = value;
    }
    setSpeakerAssignments("cloud", mergedAssignments);
    setSpeakerDialogOpen(false);
  };

  const handleSegmentTextChange = async (segmentIndex: number, text: string) => {
    const normalizedText = text.trim();
    setLocalSegments((current) =>
      current.map((segment) => (segment.index === segmentIndex ? { ...segment, text: normalizedText } : segment))
    );
    await onSegmentTextChange?.(segmentIndex, normalizedText);
  };

  const handleSegmentSpeakerChange = async (segmentIndex: number, speakerId: string) => {
    const normalizedSpeaker = speakerId.trim();
    setLocalSegments((current) =>
      current.map((segment) =>
        segment.index === segmentIndex ? { ...segment, speaker: normalizedSpeaker || undefined } : segment
      )
    );
    await onSegmentSpeakerChange?.(segmentIndex, normalizedSpeaker);
  };

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-stretch justify-center p-2 sm:p-4 lg:p-6">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={modalRef}
        data-testid={`cloud-chunk-details-${chunk.chunkId}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-[81] flex h-full w-full flex-col overflow-hidden rounded-none border bg-card shadow-2xl sm:rounded-2xl lg:h-[calc(100dvh-3rem)] lg:w-[min(96vw,1800px)]"
      >
        <div className="flex items-start justify-between gap-4 border-b px-4 py-4 sm:px-6">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="default">{chunk.label}</Badge>
              <Badge variant="outline">{formatCloudChunkTimeRange(chunk.start, chunk.end)}</Badge>
              <Badge variant="outline">{chunk.segmentCount} segments</Badge>
              <Badge variant="outline">{chunk.speakerIds.length} speakers</Badge>
            </div>
            <h3 id={titleId} className="text-lg font-semibold">
              Détails de la partie
            </h3>
            <p id={descriptionId} className="break-words text-sm text-muted-foreground">
              ID technique: {chunk.chunkId}
            </p>
          </div>

          <Button ref={closeButtonRef} type="button" variant="outline" size="sm" className="gap-2" onClick={onClose}>
            <PanelRightClose className="h-4 w-4" />
            Fermer
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-4 sm:px-6">
          {resolvedSpeakers.length ? (
            <div className="flex flex-wrap gap-2">
              {resolvedSpeakers.map((speaker) => (
                <Badge key={speaker} variant="outline" className="gap-1">
                  <Users className="h-3 w-3" />
                  {speaker}
                </Badge>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Aucun speaker détecté sur cette partie.</p>
          )}

          <AudioPlayer
            key={chunk.chunkId}
            file={file}
            metadata={metadata}
            previewUrl={previewUrl}
            segments={localSegments}
            rangeStart={chunk.start}
            rangeEnd={chunk.end}
            timeDisplayMode="absolute"
            variant="inline"
            autoPlayRequestId={autoPlayRequestId}
            onAutoPlayRequestConsumed={onAutoPlayRequestConsumed}
          />

          {chunk.speakerIds.length ? (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={() => setSpeakerDialogOpen(true)}
                disabled={isLoadingSegments}
              >
                <Users className="h-4 w-4" />
                Assigner les speakers de la partie
              </Button>
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {isLoadingSegments ? (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-background/60 px-4 py-6 text-sm text-muted-foreground">
                Chargement des segments détaillés...
              </div>
            ) : localSegments.length ? (
              <ResultsTable
                segments={localSegments}
                enableWordTimestamps={enableWordTimestamps}
                showSegmentConfidence={showSegmentConfidence}
                mode="cloud"
                speakerOptions={speakerOptions}
                onSegmentTextChange={handleSegmentTextChange}
                onSegmentSpeakerChange={handleSegmentSpeakerChange}
                segmentEditingDisabled={segmentEditingDisabled}
                expandToFill
              />
            ) : (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed bg-background/60 px-4 py-6 text-sm text-muted-foreground">
                Aucun segment détaillé n&apos;est disponible pour cette partie.
              </div>
            )}
          </div>
        </div>

        {speakerDialogOpen ? (
          <SpeakerAssignmentDialog
            mode="cloud"
            entries={localSpeakerEntries}
            assignments={speakerAssignments}
            onApply={handleApplySpeakerAssignments}
            onCancel={() => setSpeakerDialogOpen(false)}
          />
        ) : null}
      </div>
    </div>,
    document.body
  );
});
