import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { useLayoutEffect, useRef } from "react";
import type { TelemetrySummary } from "@/lib/telemetry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface TelemetryPanelProps {
  summary?: TelemetrySummary | null;
}

export function TelemetryPanel({ summary }: TelemetryPanelProps) {
  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Télémetrie</CardTitle>
          <CardDescription>Aucun run enregistré pour le moment.</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  // Refs for synchronizing heights between Session and Memory cards
  const sessionRef = useRef<HTMLDivElement | null>(null);
  const memoryRef = useRef<HTMLDivElement | null>(null);

  // Sync memory card height to session card height using ResizeObserver
  useLayoutEffect(() => {
    if (!sessionRef.current || !memoryRef.current) return;

    const setHeight = () => {
      const h = sessionRef.current!.offsetHeight;
      memoryRef.current!.style.height = `${h}px`;
    };

    setHeight();

    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(setHeight);
      ro.observe(sessionRef.current);
    }

    const onWin = () => setHeight();
    window.addEventListener("resize", onWin);

    return () => {
      window.removeEventListener("resize", onWin);
      if (ro) ro.disconnect();
      if (memoryRef.current) memoryRef.current.style.height = "";
    };
  }, [summary]);

  return (
    <div className="grid gap-4 lg:grid-cols-2 items-stretch">
      <Card ref={sessionRef} className="flex flex-col">
        <CardHeader>
          <CardTitle>Session</CardTitle>
          <CardDescription>Profil runtime et timings globaux.</CardDescription>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 space-y-3 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Session :</span> {summary.sessionId}
          </p>
          <p>
            <span className="font-medium text-foreground">Date :</span> {new Date(summary.createdAt).toLocaleString()}
          </p>
          <p>
            <span className="font-medium text-foreground">Agent :</span> {summary.userAgent}
          </p>
          <p>
            <span className="font-medium text-foreground">Transformers.js :</span> {summary.transformersVersion}
          </p>
          <p>
            <span className="font-medium text-foreground">Backend :</span> {summary.backend}
          </p>
          <p>
            <span className="font-medium text-foreground">Modèle :</span> {summary.modelId}
          </p>
          <div>
            <span className="font-medium text-foreground">Timings :</span>
            <div className="mt-1 grid gap-1">
              {Object.entries(summary.timings).map(([key, value]) => (
                <div key={key} className="flex justify-between">
                  <span>{translateTimingKey(key)}</span>
                  <span>{value.toFixed(0)} ms</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card ref={memoryRef} className="flex flex-col">
        <CardHeader>
          <CardTitle>Mémoire</CardTitle>
          <CardDescription>Snapshots Chrome (en Mo).</CardDescription>
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
                {summary.memorySnapshots.map((snapshot, i) => (
                  <TableRow key={`${snapshot.timestamp}-${i}`}>
                    <TableCell>{snapshot.label}</TableCell>
                    <TableCell>{snapshot.usedJSHeapSize ? `${snapshot.usedJSHeapSize} Mo` : "—"}</TableCell>
                    <TableCell>{snapshot.totalJSHeapSize ? `${snapshot.totalJSHeapSize} Mo` : "—"}</TableCell>
                  </TableRow>
                ))}
                {!summary.memorySnapshots.length ? (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      Indisponible dans ce navigateur.
                    </TableCell>
                  </TableRow>
                ) : null}
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
                {summary.chunks.map((chunk) => (
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
                {!summary.chunks.length ? (
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

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Timeline événements</CardTitle>
          <CardDescription>Jalons de la session pour les benchmarks.</CardDescription>
        </CardHeader>
        <CardContent>
          <ScrollArea className="h-64">
            <ul className="space-y-2 text-sm">
              {summary.events.map((event, i) => (
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
              {!summary.events.length ? (
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
