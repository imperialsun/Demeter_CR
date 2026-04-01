import { memo, useMemo, useState } from "react";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ResultsTable } from "@/components/results/ResultsTable";
import { SpeakerAssignmentDialog } from "@/components/results/SpeakerAssignmentDialog";
import { formatCloudChunkTimeRange, type CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";
import { collectSpeakerAssignmentEntries, resolveSegmentSpeakerLabel, type SpeakerAssignmentMap } from "@/lib/speakerAssignments";
import type { AudioMetadata } from "@/lib/audio";
import type { TranscriptionSegment } from "@/lib/export";
import { useAsrStore } from "@/store/asr-store";
import { PanelRightClose, Users } from "lucide-react";

interface CloudChunkDetailsPanelProps {
  chunk: CloudTranscriptionChunkGroup;
  segments: TranscriptionSegment[];
  file?: File | null;
  previewUrl?: string | null;
  metadata?: AudioMetadata | null;
  showSegmentConfidence?: boolean;
  enableWordTimestamps?: boolean;
  segmentEditingDisabled?: boolean;
  autoPlayRequestId?: number | null;
  onAutoPlayRequestConsumed?: () => void;
  onSegmentTextChange?: (segmentIndex: number, text: string) => void;
  onSegmentSpeakerChange?: (segmentIndex: number, speakerId: string) => void;
  onClose: () => void;
}

export const CloudChunkDetailsPanel = memo(function CloudChunkDetailsPanel({
  chunk,
  segments,
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
  const [speakerDialogOpen, setSpeakerDialogOpen] = useState(false);
  const speakerAssignments = useAsrStore((state) => state.speakerAssignments.cloud);
  const setSpeakerAssignments = useAsrStore((state) => state.setSpeakerAssignments);

  const localSpeakerEntries = useMemo(
    () =>
      speakerDialogOpen
        ? collectSpeakerAssignmentEntries(segments, "cloud").map((entry) => ({
            ...entry,
            chunkLabel: chunk.label,
          }))
        : [],
    [chunk.label, segments, speakerDialogOpen]
  );

  const speakerOptions = useMemo(
    () =>
      chunk.speakerIds.map((speakerId) => {
        const resolvedLabel =
          resolveSegmentSpeakerLabel({ chunkId: chunk.chunkId, speaker: speakerId }, speakerAssignments, "cloud") ?? speakerId;
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

  return (
    <section data-testid={`cloud-chunk-details-${chunk.chunkId}`} className="space-y-4 rounded-md border border-primary/20 bg-primary/5 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">{chunk.label}</Badge>
            <Badge variant="outline">{formatCloudChunkTimeRange(chunk.start, chunk.end)}</Badge>
            <Badge variant="outline">{chunk.segmentCount} segments</Badge>
            <Badge variant="outline">{chunk.speakerIds.length} speakers</Badge>
          </div>
          <h3 className="text-base font-semibold">Détails de la partie</h3>
          <p className="break-words text-sm text-muted-foreground">ID technique: {chunk.chunkId}</p>
        </div>

        <Button type="button" variant="outline" size="sm" className="gap-2" onClick={onClose}>
          <PanelRightClose className="h-4 w-4" />
          Fermer
        </Button>
      </div>

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
        segments={segments}
        rangeStart={chunk.start}
        rangeEnd={chunk.end}
        timeDisplayMode="absolute"
        variant="inline"
        autoPlayRequestId={autoPlayRequestId}
        onAutoPlayRequestConsumed={onAutoPlayRequestConsumed}
      />

      {chunk.speakerIds.length ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => setSpeakerDialogOpen(true)}>
            <Users className="h-4 w-4" />
            Assigner les speakers de la partie
          </Button>
        </div>
      ) : null}

      <ResultsTable
        segments={segments}
        enableWordTimestamps={enableWordTimestamps}
        showSegmentConfidence={showSegmentConfidence}
        mode="cloud"
        speakerOptions={speakerOptions}
        onSegmentTextChange={onSegmentTextChange}
        onSegmentSpeakerChange={onSegmentSpeakerChange}
        segmentEditingDisabled={segmentEditingDisabled}
      />

      {speakerDialogOpen ? (
        <SpeakerAssignmentDialog
          mode="cloud"
          entries={localSpeakerEntries}
          assignments={speakerAssignments}
          onApply={handleApplySpeakerAssignments}
          onCancel={() => setSpeakerDialogOpen(false)}
        />
      ) : null}
    </section>
  );
});
