import { useMemo, useState } from "react";
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
import { estimateTokenCount } from "@/lib/tokens";
import { resolveSpeakerLabel } from "@/lib/speakerAssignments";

interface ResultsTableProps {
  segments: TranscriptionSegment[];
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
  showSpeaker?: boolean;
  mode?: "upload" | "mic" | "cloud";
}

export function ResultsTable({
  segments,
  enableWordTimestamps,
  showSegmentConfidence,
  showSpeaker,
  mode = "upload",
}: ResultsTableProps) {
  const [query, setQuery] = useState("");
  const storeEnableWordTimestamps = useAsrStore((s) => s.enableWordTimestamps);
  const storeShowSegmentConfidence = useAsrStore((s) => s.showSegmentConfidence);
  const speakerAssignments = useAsrStore((s) => s.speakerAssignments[mode]);
  const resolvedEnableWordTimestamps =
    typeof enableWordTimestamps === "boolean" ? enableWordTimestamps : storeEnableWordTimestamps;
  const resolvedShowSegmentConfidence =
    typeof showSegmentConfidence === "boolean" ? showSegmentConfidence : storeShowSegmentConfidence;
  const hasSpeaker = useMemo(
    () => segments.some((segment) => typeof segment.speaker === "string" && segment.speaker.trim().length > 0),
    [segments]
  );
  const resolvedShowSpeaker = typeof showSpeaker === "boolean" ? showSpeaker : hasSpeaker;
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{segments.length} segments</span>
        <span>Tokens (est.) : {totalTokenCount}</span>
      </div>
      <Input
        placeholder="Rechercher un mot clé…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <ScrollArea className="h-[360px] rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">#</TableHead>
              <TableHead>Début</TableHead>
              <TableHead>Fin</TableHead>
              {resolvedShowSpeaker ? <TableHead className="w-28">Speaker</TableHead> : null}
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
                  <TableCell>
                    {resolveSpeakerLabel(
                      segment.speaker?.trim(),
                      segment.speaker?.trim() ? speakerAssignments[segment.speaker.trim()] : undefined
                    ) || "—"}
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
                <TableCell className="max-w-xl whitespace-pre-wrap text-sm">
                  <div>{segment.text}</div>
                  {resolvedEnableWordTimestamps && segment.words && segment.words.length ? (
                    <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      {segment.words.map((w, i) => (
                        <span key={i} className="rounded px-1 py-0.5 bg-muted/10">
                          <span className="font-medium">{w.word}</span>
                          <span className="ml-1 text-xs text-muted-foreground">[{formatTimestamp(w.start)} - {formatTimestamp(w.end)}]</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
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
    </div>
  );
}

function formatTimestamp(seconds: number) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}
