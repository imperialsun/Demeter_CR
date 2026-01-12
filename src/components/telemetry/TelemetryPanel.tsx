import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useLayoutEffect, useRef, useState, useEffect } from "react";
import { useAsrStore } from "@/store/asr-store";
import type { TelemetrySummary, TelemetryEvent, ChunkTelemetry } from "@/lib/telemetry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PreprocessTelemetryPanel } from "@/components/telemetry/PreprocessTelemetryPanel"; 

interface TelemetryPanelProps {
  summary?: TelemetrySummary | null;
}

export function TelemetryPanel({ summary }: TelemetryPanelProps) {
  // support live telemetry during an active transcription
  const collector = useAsrStore((s) => s.telemetryCollector);
  const isTranscribing = useAsrStore((s) => s.isTranscribing);

  const [liveSummary, setLiveSummary] = useState<TelemetrySummary | null>(
    summary ?? (collector ? collector.exportSummary() : null)
  );



  useEffect(() => {
    if (!collector || !isTranscribing) return;
    let mounted = true;
    const update = () => {
      try {
        const s = collector.exportSummary();
        if (!mounted) return;
        setLiveSummary(s);
      } catch (err) {
        void err;
      }
    };
    update();
    const id = window.setInterval(update, 500);
    return () => {
      mounted = false;
      window.clearInterval(id);
    };
  }, [collector, isTranscribing]);

  // Refs for synchronizing heights between Session and Memory cards
  const sessionRef = useRef<HTMLDivElement | null>(null);
  const memoryRef = useRef<HTMLDivElement | null>(null);

  // Sync memory card height to session card height using ResizeObserver
  useLayoutEffect(() => {
    const sEl = sessionRef.current;
    const mEl = memoryRef.current;
    if (!sEl || !mEl) return;

    const setHeight = () => {
      const h = sEl.offsetHeight;
      mEl.style.height = `${h}px`;
    };

    setHeight();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(setHeight);
      ro.observe(sEl as Element);
    }

    const onWin = () => setHeight();
    window.addEventListener("resize", onWin);

    return () => {
      window.removeEventListener("resize", onWin);
      if (ro) ro.disconnect();
      mEl.style.height = "";
    };
  }, [liveSummary]);

  const effective = summary ?? liveSummary;

  if (!effective) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Télémetrie</CardTitle>
          <CardDescription>Aucun run enregistré pour le moment.</CardDescription>
        </CardHeader>
      </Card>
    );
  }



  return (
    <div className="grid gap-4 lg:grid-cols-2 items-stretch">
      <Card ref={sessionRef} className="flex flex-col">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Profil runtime et timings globaux.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 space-y-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Session :</span> {effective.sessionId}
          </p>
          <p>
            <span className="font-medium text-foreground">Date :</span> {new Date(effective.createdAt).toLocaleString()}
          </p>
          <p>
            <span className="font-medium text-foreground">Agent :</span> {effective.userAgent}
          </p>
          <p>
            <span className="font-medium text-foreground">Transformers.js :</span> {effective.transformersVersion}
          </p>
          <p>
            <span className="font-medium text-foreground">Backend :</span> {effective.backend}
          </p>
          <p>
            <span className="font-medium text-foreground">Modèle :</span> {effective.modelId}
          </p>
          <div>
            <span className="font-medium text-foreground">Timings :</span>
            <div className="mt-1 grid gap-1">
              {Object.entries(effective.timings).map(([key, value]) => (
                <div key={key} className="flex justify-between">
                  <span>{translateTimingKey(key)}</span>
                  <span>{(value as number).toFixed(0)} ms</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card ref={memoryRef} className="flex flex-col">
        <CardHeader>
          <CardTitle>Mémoire</CardTitle>
          <CardDescription>Snapshots Chrome (en Mo) et usage par chunk lorsqu'il est disponible.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0">
          <ScrollArea className="h-full">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Used</TableHead>
                  <TableHead>Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(() => {
                  type MemRow = { label: string; used?: string | number; total?: string | number; timestamp: number };

                  const snapshotRows: MemRow[] = effective.memorySnapshots.map((s) => ({
                    label: s.label,
                    used: s.usedJSHeapSize ? `${s.usedJSHeapSize} Mo` : undefined,
                    total: s.totalJSHeapSize ? `${s.totalJSHeapSize} Mo` : undefined,
                    timestamp: s.timestamp,
                  }));

                  type ChunkRamData = { context: "chunk"; index?: number; mb?: number; bytes?: number };

                  function isChunkRamEvent(e: TelemetryEvent): e is TelemetryEvent & { data: ChunkRamData } {
                    return e.type === "RAM_USAGE" && typeof e.data === "object" && (e.data as Record<string, unknown>).context === "chunk";
                  }

                  const chunkRamRows: MemRow[] = effective.events
                    .filter(isChunkRamEvent)
                    .map((e) => {
                      const d = e.data as ChunkRamData;
                      return {
                        label: `Chunk ${d.index ?? "?"}`,
                        used: d.mb ? `${d.mb} Mo` : undefined,
                        total: d.bytes ? `${d.bytes} B` : undefined,
                        timestamp: e.timestamp,
                      };
                    });

                  const combined: MemRow[] = [...snapshotRows, ...chunkRamRows].sort((a, b) => a.timestamp - b.timestamp);

                  if (!combined.length) {
                    return (
                      <TableRow>
                        <TableCell colSpan={3} className="text-center text-muted-foreground">
                          Indisponible dans ce navigateur.
                        </TableCell>
                      </TableRow>
                    );
                  }

                  return combined.map((row, i) => (
                    <TableRow key={`${row.label}-${row.timestamp}-${i}`}>
                      <TableCell>{row.label}</TableCell>
                      <TableCell>{row.used ?? "—"}</TableCell>
                      <TableCell>{row.total ?? "—"}</TableCell>
                    </TableRow>
                  ));
                })()}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Chunks</CardTitle>
          <CardDescription>Durée effective vs temps de traitement.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Fenêtre</TableHead>
                  <TableHead>Durée</TableHead>
                  <TableHead>Traitement</TableHead>
                  <TableHead>x temps réel</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {effective.chunks.map((chunk: ChunkTelemetry) => (
                  <TableRow key={chunk.id}>
                    <TableCell>{chunk.index + 1}</TableCell>
                    <TableCell>
                      {formatTimestamp(chunk.startSec)} → {formatTimestamp(chunk.endSec)}
                    </TableCell>
                    <TableCell>{(chunk.endSec - chunk.startSec).toFixed(1)} s</TableCell>
                    <TableCell>{(chunk.transcriptionMs / 1000).toFixed(2)} s</TableCell>
                    <TableCell>
                      <Badge variant={chunk.realtimeFactor <= 1 ? "default" : "secondary"}>
                        {chunk.realtimeFactor.toFixed(2)}x
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
                {!effective.chunks.length ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      Chunks non mesurés.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>

      <PreprocessTelemetryPanel summary={effective} />

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Timeline événements</CardTitle>
          <CardDescription>Jalons de la session pour les benchmarks.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            <ul className="space-y-2 text-sm">
              {effective.events.map((event: TelemetryEvent, i: number) => (
                <li key={`${event.timestamp}-${i}-${event.type}`} className="rounded-md border bg-muted/40 p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{event.type}</span>
                    <span className="text-xs text-muted-foreground">{event.timestamp.toFixed(0)} ms</span>
                  </div>
                  {event.data ? (
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                      {JSON.stringify(event.data, null, 2)}
                    </pre>
                  ) : null}
                </li>
              ))}
              {!effective.events.length ? (
                <li className="text-center text-muted-foreground">Aucun événement consigné.</li>
              ) : null}
            </ul>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

function formatTimestamp(seconds: number) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}`;
}

function translateTimingKey(key: string) {
  switch (key) {
    case "load_model_total":
      return "Chargement modèle";
    case "decode_audio_total":
      return "Décodage audio";
    default:
      return key;
  }
}
