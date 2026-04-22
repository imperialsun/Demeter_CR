import { memo, useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { formatCloudChunkTimeRange, type CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";
import { resolveSegmentSpeakerLabel } from "@/lib/speakerAssignments";
import { useAsrStore } from "@/store/asr-store";
import { Play, PanelRightOpen, Users } from "lucide-react";

interface CloudChunkCardProps {
  chunk: CloudTranscriptionChunkGroup;
  isActive?: boolean;
  onOpen: (chunkId: string) => void;
  onPlay: (chunkId: string) => void;
}

export const CloudChunkCard = memo(function CloudChunkCard({
  chunk,
  isActive = false,
  onOpen,
  onPlay,
}: CloudChunkCardProps) {
  const speakerAssignments = useAsrStore((state) => state.speakerAssignments.cloud);

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

  return (
    <Card
      data-testid={`cloud-chunk-card-${chunk.chunkId}`}
      className={isActive ? "border-primary/60 bg-primary/5 shadow-sm" : undefined}
    >
      <CardHeader className="space-y-3 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={isActive ? "default" : "secondary"}>{isActive ? "Ouverte" : "Résumé"}</Badge>
              <Badge variant="outline">{formatCloudChunkTimeRange(chunk.start, chunk.end)}</Badge>
              <Badge variant="outline">{chunk.segmentCount} segments</Badge>
              <Badge variant="outline">{chunk.speakerIds.length} intervenants</Badge>
            </div>
            <CardTitle className="text-base">{chunk.label}</CardTitle>
            <CardDescription className="break-words">ID technique: {chunk.chunkId}</CardDescription>
          </div>

          <div className="flex flex-wrap gap-2">
            <TooltipButton
              tooltip="Afficher le détail de cette partie pour lire ou modifier les segments."
              type="button"
              variant={isActive ? "secondary" : "outline"}
              size="sm"
              onClick={() => onOpen(chunk.chunkId)}
              aria-expanded={isActive}
            >
              <PanelRightOpen className="h-4 w-4" />
              {isActive ? "Ouverte" : "Ouvrir"}
            </TooltipButton>
            <TooltipButton
              tooltip="Lire un extrait audio centré sur cette partie."
              type="button"
              variant="default"
              size="sm"
              className="gap-2"
              onClick={() => onPlay(chunk.chunkId)}
            >
              <Play className="h-4 w-4" />
              Lire
            </TooltipButton>
          </div>
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
          <p className="text-xs text-muted-foreground">Aucun intervenant détecté sur ce morceau.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {chunk.textSample ? (
          <p className="text-sm leading-6 text-muted-foreground">{chunk.textSample}</p>
        ) : (
          <p className="text-sm text-muted-foreground">Aucun extrait disponible pour cette partie.</p>
        )}
      </CardContent>
    </Card>
  );
});
