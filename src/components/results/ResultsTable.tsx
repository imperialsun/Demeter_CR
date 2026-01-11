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
import type { TranscriptionSegment } from "@/lib/export";

interface ResultsTableProps {
  segments: TranscriptionSegment[];
}

export function ResultsTable({ segments }: ResultsTableProps) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    if (!query) return segments;
    const lower = query.toLowerCase();
    return segments.filter((segment) => segment.text.toLowerCase().includes(lower));
  }, [segments, query]);

  return (
    <div className="space-y-3">
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
              <TableHead>Texte</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((segment) => (
              <TableRow key={segment.index}>
                <TableCell className="font-medium">{segment.index + 1}</TableCell>
                <TableCell>{formatTimestamp(segment.start)}</TableCell>
                <TableCell>{formatTimestamp(segment.end)}</TableCell>
                <TableCell className="max-w-xl whitespace-pre-wrap text-sm">{segment.text}</TableCell>
              </TableRow>
            ))}
            {!filtered.length ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
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
