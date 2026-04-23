import { useEffect, useMemo, useState } from "react";

import { TelemetryDomainHealth } from "@/components/telemetry/TelemetryDomainHealth";
import { TelemetryEventInspector } from "@/components/telemetry/TelemetryEventInspector";
import { TelemetryEventTimeline } from "@/components/telemetry/TelemetryEventTimeline";
import { TelemetryFiltersBar } from "@/components/telemetry/TelemetryFiltersBar";
import { PreprocessTelemetryPanel } from "@/components/telemetry/PreprocessTelemetryPanel";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { exportLogsAsTelemetrySummary } from "@/lib/logger";
import type { ChunkTelemetry, TelemetryEvent, TelemetrySummary } from "@/lib/telemetry";
import {
  computeDomainStats,
  computeTelemetryKpis,
  enrichTelemetryEvents,
  filterTelemetryEvents,
  normalizeTelemetryScope,
  normalizeTelemetrySeverity,
  normalizeTelemetryTab,
  resolveAlertDomain,
  type TelemetryDetailTab,
  type TelemetryLiveMode,
  type TelemetryScope,
  type TelemetrySeverityFilter,
} from "@/lib/telemetryView";
import { useAsrStore } from "@/store/asr-store";

interface TelemetryPanelProps {
  summary?: TelemetrySummary | null;
  scope?: TelemetryScope;
  severity?: TelemetrySeverityFilter;
  tab?: TelemetryDetailTab;
  liveMode?: TelemetryLiveMode;
  onScopeChange?: (scope: TelemetryScope) => void;
  onSeverityChange?: (severity: TelemetrySeverityFilter) => void;
  onTabChange?: (tab: TelemetryDetailTab) => void;
  onLiveModeChange?: (mode: TelemetryLiveMode) => void;
  onResetFilters?: () => void;
}

const TELEMETRY_PREVIEW_SUMMARY: TelemetrySummary = {
  sessionId: "preview-session",
  createdAt: "2026-02-17T12:00:00.000Z",
  userAgent: "Preview Agent",
  transformersVersion: "4.0.0-next.3",
  backend: "wasm",
  modelId: "Xenova/whisper-medium",
  timings: {
    load_model_total: 1834,
    decode_audio_total: 972,
  },
  chunks: [
    {
      id: "preview-chunk-1",
      index: 0,
      startSec: 0,
      endSec: 15,
      transcriptionMs: 6120,
      realtimeFactor: 0.41,
      text: "Segment de démonstration",
    },
  ],
  memorySnapshots: [
    { label: "INIT", timestamp: 120, usedJSHeapSize: 114, totalJSHeapSize: 180 },
    { label: "MODEL_READY", timestamp: 1880, usedJSHeapSize: 322, totalJSHeapSize: 420 },
  ],
  events: [
    { type: "LOCAL_UPLOAD_PAGE_VIEW", timestamp: 10, data: { route: "/localupload", mode: "local" } },
    { type: "START_LOAD_MODEL", timestamp: 210, data: { backend: "wasm" } },
    { type: "END_DECODE", timestamp: 1230, data: { strategy: "full", durationMs: 972 } },
    { type: "PREPROCESS_DONE", timestamp: 1590, data: { durationMs: 820 } },
    { type: "RAM_USAGE", timestamp: 1700, data: { context: "chunk", index: 0, mb: 128 } },
    { type: "CLOUD_UPLOAD_PAGE_VIEW", timestamp: 1910, data: { route: "/cloudupload", mode: "cloud" } },
    { type: "CLOUD_TRANSCRIBE_DONE", timestamp: 2480, data: { segments: 4 } },
    { type: "LLM_LOCAL_PAGE_VIEW", timestamp: 2560, data: { route: "/llmlocal", mode: "local" } },
    { type: "LLM_CLOUD_PAGE_VIEW", timestamp: 2610, data: { route: "/llmapi", mode: "cloud" } },
    {
      type: "LLM_RUN_STAGE",
      timestamp: 2670,
      data: {
        provider: "huggingface",
        stage: "report_sequence_start",
        stageLabel: "Séquence des formats",
        globalPassIndex: 1,
        globalPassTotal: 1,
        totalFormats: 3,
      },
    },
    {
      type: "LLM_RUN_STAGE",
      timestamp: 2830,
      data: {
        provider: "huggingface",
        stage: "workflow_done",
        stageLabel: "Passe 6/6 · Terminé",
        globalPassIndex: 6,
        globalPassTotal: 6,
        reportWordCount: 12840,
        sourceWordCount: 34120,
        pipelinePasses: 6,
      },
    },
    { type: "LOG_WARN", timestamp: 3010, data: { message: "Aperçu: warning exemple" } },
  ],
  alerts: {
    PREPROCESS_NOISE_PROFILE_EMPTY: {
      count: 1,
      lastTimestamp: 1600,
      lastData: { fallback: true },
    },
    CLOUD_TRANSCRIBE_STALL: {
      count: 1,
      lastTimestamp: 2350,
      lastData: { elapsedMs: 30000 },
    },
  },
  droppedEvents: 0,
};

export function TelemetryPanel({
  summary,
  scope = "all",
  severity = "all",
  tab = "overview",
  liveMode = "on",
  onScopeChange,
  onSeverityChange,
  onTabChange,
  onLiveModeChange,
  onResetFilters,
}: TelemetryPanelProps) {
  const collector = useAsrStore((state) => state.telemetryCollector);
  const [liveTick, setLiveTick] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null);

  useEffect(() => {
    if (liveMode !== "on") return;
    const timer = window.setInterval(() => {
      setLiveTick((prev) => prev + 1);
    }, 500);

    return () => {
      window.clearInterval(timer);
    };
  }, [collector, liveMode]);

  const liveSummary = useMemo(() => {
    void liveTick;
    if (collector) {
      try {
        return collector.exportSummary();
      } catch {
        return null;
      }
    }
    if (summary) {
      return null;
    }
    return exportLogsAsTelemetrySummary();
  }, [collector, liveTick, summary]);

  const hasTelemetrySession = Boolean(summary ?? liveSummary);
  const effective = summary ?? liveSummary ?? TELEMETRY_PREVIEW_SUMMARY;
  const isPreviewMode = !hasTelemetrySession;
  const events = effective.events;
  const alerts = effective.alerts;
  const memorySnapshots = effective.memorySnapshots;

  const normalizedScope = normalizeTelemetryScope(scope);
  const normalizedSeverity = normalizeTelemetrySeverity(severity);
  const normalizedTab = normalizeTelemetryTab(tab);

  const allEvents = useMemo(() => enrichTelemetryEvents(events), [events]);
  const filteredEvents = useMemo(
    () =>
      filterTelemetryEvents(allEvents, {
        scope: normalizedScope,
        severity: normalizedSeverity,
        search: searchQuery,
      }),
    [allEvents, normalizedScope, normalizedSeverity, searchQuery]
  );
  const globalKpis = useMemo(() => computeTelemetryKpis(allEvents, effective.droppedEvents), [allEvents, effective.droppedEvents]);
  const domainStats = useMemo(() => computeDomainStats(allEvents), [allEvents]);

  const resolvedSelectedEventKey = useMemo(() => {
    if (!filteredEvents.length) return null;
    if (selectedEventKey && filteredEvents.some((event) => event.key === selectedEventKey)) {
      return selectedEventKey;
    }
    return filteredEvents[filteredEvents.length - 1]!.key;
  }, [filteredEvents, selectedEventKey]);

  const selectedEvent =
    filteredEvents.find((event) => event.key === resolvedSelectedEventKey) ??
    (filteredEvents.length ? filteredEvents[filteredEvents.length - 1]! : null);

  const memoryRows = useMemo(() => buildMemoryRows(events, memorySnapshots), [events, memorySnapshots]);

  const alertEntries = useMemo(() => {
    return Object.entries(alerts).filter(([alertType]) => {
      if (normalizedScope === "all") return true;
      return resolveAlertDomain(alertType) === normalizedScope;
    });
  }, [alerts, normalizedScope]);

  const latestIssues = useMemo(() => {
    return filteredEvents
      .filter((event) => event.severity === "error" || event.severity === "warn")
      .slice(-80)
      .reverse();
  }, [filteredEvents]);

  const handleResetFilters = () => {
    setSearchQuery("");
    setSelectedEventKey(null);
    onResetFilters?.();
  };

  return (
    <div className="space-y-4">
      {isPreviewMode ? (
        <Card className="border-dashed border-amber-500/60 bg-amber-500/5">
          <CardContent className="pt-6 text-sm text-muted-foreground">
            Aucune session telemetry active. Aperçu de démonstration affiché pour visualiser la page.
          </CardContent>
        </Card>
      ) : null}
      <Card className="sticky top-2 z-10 border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <CardHeader>
          <CardTitle>Pilotage session</CardTitle>
          <CardDescription>Suivi live des événements, filtres de lecture et indicateurs de santé.</CardDescription>
        </CardHeader>
        <CardContent>
          <TelemetryFiltersBar
            sessionId={effective.sessionId}
            createdAt={effective.createdAt}
            backend={effective.backend}
            modelId={effective.modelId}
            scope={normalizedScope}
            severity={normalizedSeverity}
            liveMode={liveMode}
            searchQuery={searchQuery}
            visibleEventsCount={filteredEvents.length}
            kpis={globalKpis}
            onScopeChange={(nextScope) => onScopeChange?.(normalizeTelemetryScope(nextScope))}
            onSeverityChange={(nextSeverity) => onSeverityChange?.(normalizeTelemetrySeverity(nextSeverity))}
            onSearchQueryChange={setSearchQuery}
            onLiveModeChange={(nextMode) => onLiveModeChange?.(nextMode)}
            onResetFilters={handleResetFilters}
          />
        </CardContent>
      </Card>

      <Tabs value={normalizedTab} onValueChange={(value) => onTabChange?.(normalizeTelemetryTab(value))}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="overview">Vue globale</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="preprocess">Prétraitement</TabsTrigger>
          <TabsTrigger value="alerts">Alertes</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[280px_minmax(0,1fr)_360px]">
            <div className="order-2 xl:order-1">
              <TelemetryDomainHealth
                statsByDomain={domainStats}
                scope={normalizedScope}
                onScopeChange={(nextScope) => onScopeChange?.(normalizeTelemetryScope(nextScope))}
              />
            </div>

            <div className="order-1 xl:order-2">
              <TelemetryEventTimeline
                events={filteredEvents}
                selectedEventKey={resolvedSelectedEventKey}
                liveMode={liveMode}
                onSelectEvent={setSelectedEventKey}
              />
            </div>

            <div className="order-3 xl:order-3">
              <TelemetryEventInspector event={selectedEvent} />
            </div>
          </div>
        </TabsContent>

        <TabsContent value="timeline" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <TelemetryEventTimeline
              events={filteredEvents}
              selectedEventKey={resolvedSelectedEventKey}
              liveMode={liveMode}
              onSelectEvent={setSelectedEventKey}
              compact
            />
            <TelemetryEventInspector event={selectedEvent} />
          </div>
        </TabsContent>

        <TabsContent value="performance" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2 items-stretch">
            <Card>
              <CardHeader>
                <CardTitle>Session</CardTitle>
                <CardDescription>Profil runtime et timings globaux.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm text-muted-foreground">
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
                  <span className="font-medium text-foreground">Backend :</span> {effective.backend || "auto"}
                </p>
                <p>
                  <span className="font-medium text-foreground">Modèle :</span> {effective.modelId || "non défini"}
                </p>
                <div>
                  <span className="font-medium text-foreground">Timings :</span>
                  <div className="mt-1 grid gap-1">
                    {Object.entries(effective.timings).map(([key, value]) => (
                      <div key={key} className="flex justify-between gap-2">
                        <span>{translateTimingKey(key)}</span>
                        <span>{(value as number).toFixed(0)} ms</span>
                      </div>
                    ))}
                    {!Object.keys(effective.timings).length ? (
                      <span className="text-xs text-muted-foreground">Aucun timing enregistré.</span>
                    ) : null}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Mémoire</CardTitle>
                <CardDescription>Snapshots navigateur et RAM chunk.</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-72">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Label</TableHead>
                        <TableHead>Used</TableHead>
                        <TableHead>Total</TableHead>
                        <TableHead>Temps</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {memoryRows.length ? (
                        memoryRows.map((row) => (
                          <TableRow key={`${row.label}-${row.timestamp}-${row.total ?? "none"}`}>
                            <TableCell>{row.label}</TableCell>
                            <TableCell>{row.used ?? "—"}</TableCell>
                            <TableCell>{row.total ?? "—"}</TableCell>
                            <TableCell>{row.timestamp.toFixed(0)} ms</TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={4} className="text-center text-muted-foreground">
                            Indisponible dans ce navigateur.
                          </TableCell>
                        </TableRow>
                      )}
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
                <ScrollArea className="h-72">
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
                      {effective.chunks.length ? (
                        effective.chunks.map((chunk: ChunkTelemetry) => (
                          <TableRow key={chunk.id}>
                            <TableCell>{chunk.index + 1}</TableCell>
                            <TableCell>
                              {formatTimestamp(chunk.startSec)} → {formatTimestamp(chunk.endSec)}
                            </TableCell>
                            <TableCell>{(chunk.endSec - chunk.startSec).toFixed(1)} s</TableCell>
                            <TableCell>{(chunk.transcriptionMs / 1000).toFixed(2)} s</TableCell>
                            <TableCell>
                              <Badge variant={chunk.realtimeFactor <= 1 ? "success" : "warning"}>
                                {chunk.realtimeFactor.toFixed(2)}x
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))
                      ) : (
                        <TableRow>
                          <TableCell colSpan={5} className="text-center text-muted-foreground">
                            Chunks non mesurés.
                          </TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="preprocess" className="space-y-4">
          <PreprocessTelemetryPanel summary={effective} />
        </TabsContent>

        <TabsContent value="alerts" className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Alertes agrégées</CardTitle>
                <CardDescription>Compteurs consolidés par type.</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-72">
                  <div className="space-y-2">
                    {alertEntries.length ? (
                      alertEntries.map(([alertType, alertValue]) => (
                        <div key={alertType} className="rounded-md border bg-muted/30 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium">{alertType}</p>
                            <Badge variant="warning">x{alertValue.count}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Dernier événement: {alertValue.lastTimestamp.toFixed(0)} ms
                          </p>
                          {alertValue.lastData ? (
                            <pre className="mt-2 max-h-24 overflow-auto rounded bg-background/50 p-2 text-[11px] text-muted-foreground">
                              {JSON.stringify(alertValue.lastData, null, 2)}
                            </pre>
                          ) : null}
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">Aucune alerte pour les filtres actuels.</p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Derniers signaux critiques</CardTitle>
                <CardDescription>Warnings et erreurs récents sur la vue filtrée.</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-72">
                  <div className="space-y-2">
                    {latestIssues.length ? (
                      latestIssues.map((entry) => (
                        <button
                          key={entry.key}
                          type="button"
                          className="w-full rounded-md border bg-muted/30 p-2 text-left hover:bg-muted/50"
                          onClick={() => {
                            setSelectedEventKey(entry.key);
                            onTabChange?.("timeline");
                          }}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold">{entry.event.type}</p>
                            <Badge variant={entry.severity === "error" ? "destructive" : "warning"}>{entry.severity}</Badge>
                          </div>
                          <p className="mt-1 text-[11px] text-muted-foreground">{entry.event.timestamp.toFixed(0)} ms</p>
                        </button>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">Aucun warning/error avec ces filtres.</p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
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

interface MemoryRow {
  label: string;
  used?: string;
  total?: string;
  timestamp: number;
}

function buildMemoryRows(events: TelemetryEvent[], snapshots: TelemetrySummary["memorySnapshots"]): MemoryRow[] {
  const snapshotRows: MemoryRow[] = snapshots.map((snapshot) => ({
    label: snapshot.label,
    used: typeof snapshot.usedJSHeapSize === "number" ? `${snapshot.usedJSHeapSize} Mo` : undefined,
    total: typeof snapshot.totalJSHeapSize === "number" ? `${snapshot.totalJSHeapSize} Mo` : undefined,
    timestamp: snapshot.timestamp,
  }));

  const chunkRows: MemoryRow[] = events
    .filter((event) => isChunkRamEvent(event))
    .map((event) => {
      const data = event.data as { index?: number; mb?: number; bytes?: number };
      return {
        label: `Chunk ${data.index ?? "?"}`,
        used: typeof data.mb === "number" ? `${data.mb} Mo` : undefined,
        total: typeof data.bytes === "number" ? `${data.bytes} B` : undefined,
        timestamp: event.timestamp,
      };
    });

  return [...snapshotRows, ...chunkRows].sort((a, b) => a.timestamp - b.timestamp);
}

function isChunkRamEvent(event: TelemetryEvent): boolean {
  if (event.type !== "RAM_USAGE") return false;
  if (!event.data || typeof event.data !== "object") return false;
  return (event.data as Record<string, unknown>).context === "chunk";
}
