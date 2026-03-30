import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAsrStore } from "@/store/asr-store";
import type { TranscriptionSegment } from "@/lib/export";
import logger from "@/lib/logger";
import { estimateTokenCount } from "@/lib/tokens";
import { resolveSegmentSpeakerLabel } from "@/lib/speakerAssignments";
import { SegmentEditorDialog } from "@/components/results/SegmentEditorDialog";

interface ResultsTableProps {
  segments: TranscriptionSegment[];
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
  showSpeaker?: boolean;
  speakerOptions?: Array<{ value: string; label: string }>;
  mode?: "upload" | "mic" | "cloud";
  onSegmentTextChange?: (segmentIndex: number, text: string) => void;
  onSegmentSpeakerChange?: (segmentIndex: number, speakerId: string) => void;
  segmentEditingDisabled?: boolean;
}

export const ResultsTable = memo(function ResultsTable({
  segments,
  enableWordTimestamps,
  showSegmentConfidence,
  showSpeaker,
  speakerOptions,
  mode = "upload",
  onSegmentTextChange,
  onSegmentSpeakerChange,
  segmentEditingDisabled = false,
}: ResultsTableProps) {
  const [query, setQuery] = useState("");
  const [editingSegment, setEditingSegment] = useState<{ index: number; text: string } | null>(null);
  const storeEnableWordTimestamps = useAsrStore((s) => s.enableWordTimestamps);
  const storeShowSegmentConfidence = useAsrStore((s) => s.showSegmentConfidence);
  const speakerAssignments = useAsrStore((s) => s.speakerAssignments[mode]);
  const resolvedSpeakerOptions = speakerOptions ?? [];
  const resolvedEnableWordTimestamps =
    typeof enableWordTimestamps === "boolean" ? enableWordTimestamps : storeEnableWordTimestamps;
  const resolvedShowSegmentConfidence =
    typeof showSegmentConfidence === "boolean" ? showSegmentConfidence : storeShowSegmentConfidence;
  const hasSpeaker = useMemo(
    () => segments.some((segment) => typeof segment.speaker === "string" && segment.speaker.trim().length > 0),
    [segments]
  );
  const resolvedShowSpeaker =
    typeof showSpeaker === "boolean" ? showSpeaker : hasSpeaker || resolvedSpeakerOptions.length > 0;
  const canEditSegments = Boolean(onSegmentTextChange) && !segmentEditingDisabled;
  const canSelectSpeaker = mode === "cloud" && Boolean(onSegmentSpeakerChange) && resolvedSpeakerOptions.length > 0;
  const canEditSpeaker = canSelectSpeaker && !segmentEditingDisabled && resolvedSpeakerOptions.length > 1;
  const emptyRowColSpan = (resolvedShowSegmentConfidence ? 6 : 5) + (resolvedShowSpeaker ? 1 : 0);
  const filtered = useMemo(() => {
    if (!query) return segments;
    const lower = query.toLowerCase();
    return segments.filter((segment) => segment.text.toLowerCase().includes(lower));
  }, [segments, query]);
  const totalTokenCount = useMemo(
    () => segments.reduce((acc, segment) => acc + estimateTokenCount(segment.text), 0),
    [segments]
  );

  useEffect(() => {
    if (!editingSegment) return;
    if (!canEditSegments) {
      setEditingSegment(null);
      return;
    }
    const stillVisible = segments.some((segment) => segment.index === editingSegment.index);
    if (!stillVisible) {
      setEditingSegment(null);
    }
  }, [canEditSegments, editingSegment, segments]);

  useEffect(() => {
    logger.info("[results] table mounted", {
      mode,
      segmentCount: segments.length,
      showSpeaker: resolvedShowSpeaker,
      showSegmentConfidence: resolvedShowSegmentConfidence,
      enableWordTimestamps: resolvedEnableWordTimestamps,
    });
    return () => {
      logger.debug("[results] table unmounted", { mode });
    };
  }, [mode, resolvedEnableWordTimestamps, resolvedShowSegmentConfidence, resolvedShowSpeaker, segments.length]);

  useEffect(() => {
    logger.debug("[results] table filter updated", {
      mode,
      query,
      visibleSegments: filtered.length,
      totalSegments: segments.length,
    });
  }, [filtered.length, mode, query, segments.length]);

  const handleSaveSegmentText = useCallback(
    (text: string) => {
      if (!editingSegment || !onSegmentTextChange) return;
      onSegmentTextChange(editingSegment.index, text);
      setEditingSegment(null);
    },
    [editingSegment, onSegmentTextChange]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{segments.length} segments</span>
        <span>Tokens (est.) : {totalTokenCount}</span>
      </div>
      {canEditSegments ? (
        <p className="text-xs text-muted-foreground">
          Cliquez sur le texte d’un segment pour modifier sa transcription localement.
        </p>
      ) : null}
      <Input
        placeholder="Rechercher un mot clé…"
        value={query}
        onChange={(event) => {
          logger.debug("[results] search query changed", {
            mode,
            query: event.target.value,
          });
          setQuery(event.target.value);
        }}
      />
      <ScrollArea className="h-[360px] rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Début</TableHead>
              <TableHead>Fin</TableHead>
              {resolvedShowSpeaker ? <TableHead className="w-56">Speaker</TableHead> : null}
              {resolvedShowSegmentConfidence ? <TableHead className="w-24">Conf.</TableHead> : null}
              <TableHead className="w-28">Tokens (est.)</TableHead>
              <TableHead>Texte</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((segment) => (
              <TableRow key={segment.index}>
                <TableCell className="font-medium">{segment.index + 1}</TableCell>
                <TableCell>{formatTimestamp(segment.start)}</TableCell>
                <TableCell>{formatTimestamp(segment.end)}</TableCell>
                {resolvedShowSpeaker ? (
                  <TableCell className="align-top">
                    {canSelectSpeaker && normalizeSpeakerId(segment.speaker) ? (
                      <Select
                        value={normalizeSpeakerId(segment.speaker) ?? undefined}
                        onValueChange={(value) => {
                          if (!canEditSpeaker || !onSegmentSpeakerChange) return;
                          onSegmentSpeakerChange(segment.index, value);
                        }}
                      >
                        <SelectTrigger
                          aria-label={`Speaker du segment ${segment.index + 1}`}
                          className="h-8 w-full text-xs"
                          disabled={!canEditSpeaker}
                        >
                          <SelectValue placeholder="Speaker" />
                        </SelectTrigger>
                        <SelectContent>
                          {resolvedSpeakerOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <div className="text-sm">{resolveSegmentSpeakerLabel(segment, speakerAssignments, mode) || "—"}</div>
                    )}
                  </TableCell>
                ) : null}
                {resolvedShowSegmentConfidence ? (
                  <TableCell>
                    {typeof segment.confidence === "number" ? (
                      <div className="text-sm font-mono">
                        <span className={
                          segment.confidence >= 0.85 ? "text-emerald-600" : segment.confidence >= 0.6 ? "text-amber-600" : "text-destructive-600"
                        }>{Math.round(segment.confidence * 100)}%</span>
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground">—</div>
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="text-sm font-mono">
                  {estimateTokenCount(segment.text)}
                </TableCell>
                <TableCell className="max-w-xl whitespace-pre-wrap text-sm align-top">
                  {canEditSegments ? (
                    <button
                      type="button"
                      className="group w-full cursor-pointer rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Modifier le segment ${segment.index + 1}`}
                      onClick={() => {
                        setEditingSegment({ index: segment.index, text: segment.text });
                      }}
                    >
                      <div>{segment.text}</div>
                      {resolvedEnableWordTimestamps && segment.words && segment.words.length ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {segment.words.map((w, i) => (
                            <span key={i} className="rounded bg-muted/10 px-1 py-0.5">
                              <span className="font-medium">{w.word}</span>
                              <span className="ml-1 text-xs text-muted-foreground">
                                [{formatTimestamp(w.start)} - {formatTimestamp(w.end)}]
                              </span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </button>
                  ) : (
                    <div className="space-y-2">
                      <div>{segment.text}</div>
                      {resolvedEnableWordTimestamps && segment.words && segment.words.length ? (
                        <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {segment.words.map((w, i) => (
                            <span key={i} className="rounded bg-muted/10 px-1 py-0.5">
                              <span className="font-medium">{w.word}</span>
                              <span className="ml-1 text-xs text-muted-foreground">
                                [{formatTimestamp(w.start)} - {formatTimestamp(w.end)}]
                              </span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!filtered.length ? (
              <TableRow>
                <TableCell colSpan={emptyRowColSpan} className="h-24 text-center text-muted-foreground">
                  Aucun segment ne correspond à « {query} ».
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </ScrollArea>

      <SegmentEditorDialog
        open={editingSegment !== null}
        segmentNumber={(editingSegment?.index ?? 0) + 1}
        initialText={editingSegment?.text ?? ""}
        onSave={handleSaveSegmentText}
        onCancel={() => {
          setEditingSegment(null);
        }}
      />
    </div>
  );
});

function formatTimestamp(seconds: number) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

function normalizeSpeakerId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
