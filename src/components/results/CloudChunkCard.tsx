import { memo, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { ResultsTable } from "@/components/results/ResultsTable";
import { SpeakerAssignmentDialog } from "@/components/results/SpeakerAssignmentDialog";
import { collectSpeakerAssignmentEntries, resolveSegmentSpeakerLabel, type SpeakerAssignmentMap } from "@/lib/speakerAssignments";
import type { AudioMetadata } from "@/lib/audio";
import type { CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";
import { formatCloudChunkTimeRange } from "@/lib/cloud/transcriptionChunks";
import { useAsrStore } from "@/store/asr-store";
import { Users } from "lucide-react";

interface CloudChunkCardProps {
  chunk: CloudTranscriptionChunkGroup;
  file?: File | null;
  previewUrl?: string | null;
  metadata?: AudioMetadata | null;
  showSegmentConfidence?: boolean;
  enableWordTimestamps?: boolean;
  segmentEditingDisabled?: boolean;
  onSegmentTextChange?: (segmentIndex: number, text: string) => void;
}

export const CloudChunkCard = memo(function CloudChunkCard({
  chunk,
  file,
  previewUrl,
  metadata,
  showSegmentConfidence,
  enableWordTimestamps,
  segmentEditingDisabled = false,
  onSegmentTextChange,
}: CloudChunkCardProps) {
  const [speakerDialogOpen, setSpeakerDialogOpen] = useState(false);
  const speakerAssignments = useAsrStore((state) => state.speakerAssignments.cloud);
  const setSpeakerAssignments = useAsrStore((state) => state.setSpeakerAssignments);

  const localSpeakerEntries = useMemo(
    () =>
      collectSpeakerAssignmentEntries(chunk.segments, "cloud").map((entry) => ({
        ...entry,
        chunkLabel: chunk.label,
      })),
    [chunk.label, chunk.segments]
  );

  const resolvedSpeakers = useMemo(() => {
    const labels = new Set<string>();
    for (const segment of chunk.segments) {
      const label = resolveSegmentSpeakerLabel(segment, speakerAssignments, "cloud") ?? segment.speaker?.trim();
      if (label) {
        labels.add(label);
      }
    }
    return [...labels];
  }, [chunk.segments, speakerAssignments]);

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
    <Card data-testid={`cloud-chunk-card-${chunk.chunkId}`}>
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{chunk.label}</Badge>
              <Badge variant="outline">{formatCloudChunkTimeRange(chunk.start, chunk.end)}</Badge>
              <Badge variant="outline">{chunk.segmentCount} segments</Badge>
              <Badge variant="outline">{resolvedSpeakers.length} speakers</Badge>
            </div>
            <CardTitle className="text-base">Résultat du morceau</CardTitle>
            <CardDescription>ID technique: {chunk.chunkId}</CardDescription>
          </div>

          {localSpeakerEntries.length ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setSpeakerDialogOpen(true)}
            >
              <Users className="h-4 w-4" />
              Assigner les speakers du morceau
            </Button>
          ) : null}
        </div>

        {resolvedSpeakers.length ? (
          <div className="flex flex-wrap gap-2">
            {resolvedSpeakers.map((speaker) => (
              <Badge key={speaker} variant="outline">
                {speaker}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Aucun speaker détecté sur ce morceau.</p>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        <AudioPlayer
          file={file}
          metadata={metadata}
          previewUrl={previewUrl}
          segments={chunk.segments}
          rangeStart={chunk.start}
          rangeEnd={chunk.end}
          timeDisplayMode="absolute"
          variant="inline"
        />

        <ResultsTable
          segments={chunk.segments}
          enableWordTimestamps={enableWordTimestamps}
          showSegmentConfidence={showSegmentConfidence}
          mode="cloud"
          onSegmentTextChange={onSegmentTextChange}
          segmentEditingDisabled={segmentEditingDisabled}
        />
      </CardContent>

      {speakerDialogOpen ? (
        <SpeakerAssignmentDialog
          mode="cloud"
          entries={localSpeakerEntries}
          assignments={speakerAssignments}
          onApply={handleApplySpeakerAssignments}
          onCancel={() => setSpeakerDialogOpen(false)}
        />
      ) : null}
    </Card>
  );
});
