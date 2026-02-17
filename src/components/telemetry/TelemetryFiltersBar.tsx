import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  TelemetryKpis,
  TelemetryLiveMode,
  TelemetryScope,
  TelemetrySeverityFilter,
} from "@/lib/telemetryView";
import {
  formatEventTimestamp,
  shortSessionId,
  telemetryScopeLabel,
} from "@/lib/telemetryView";

interface TelemetryFiltersBarProps {
  sessionId: string;
  createdAt: string;
  backend: string;
  modelId: string;
  scope: TelemetryScope;
  severity: TelemetrySeverityFilter;
  liveMode: TelemetryLiveMode;
  searchQuery: string;
  visibleEventsCount: number;
  kpis: TelemetryKpis;
  onScopeChange: (scope: TelemetryScope) => void;
  onSeverityChange: (severity: TelemetrySeverityFilter) => void;
  onSearchQueryChange: (query: string) => void;
  onLiveModeChange: (mode: TelemetryLiveMode) => void;
  onResetFilters: () => void;
}

export function TelemetryFiltersBar({
  sessionId,
  createdAt,
  backend,
  modelId,
  scope,
  severity,
  liveMode,
  searchQuery,
  visibleEventsCount,
  kpis,
  onScopeChange,
  onSeverityChange,
  onSearchQueryChange,
  onLiveModeChange,
  onResetFilters,
}: TelemetryFiltersBarProps) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">Session {shortSessionId(sessionId)}</Badge>
        <Badge variant={liveMode === "on" ? "success" : "outline"}>{liveMode === "on" ? "Live" : "Pause"}</Badge>
        <Badge variant="secondary">Backend {backend || "auto"}</Badge>
        <Badge variant="violet" className="max-w-[280px] truncate" title={modelId || "non défini"}>
          Modèle {modelId || "non défini"}
        </Badge>
        <Badge variant="outline">Début {new Date(createdAt).toLocaleString()}</Badge>
      </div>

      <div className="grid gap-3 md:grid-cols-4 xl:grid-cols-8">
        <KpiCard label="Événements" value={String(visibleEventsCount)} hint={`sur ${kpis.total}`} />
        <KpiCard label="Erreurs" value={String(kpis.errors)} tone={kpis.errors > 0 ? "error" : "default"} />
        <KpiCard label="Warnings" value={String(kpis.warnings)} tone={kpis.warnings > 0 ? "warn" : "default"} />
        <KpiCard label="Dropped" value={String(kpis.droppedEvents)} tone={kpis.droppedEvents > 0 ? "warn" : "default"} />
        <KpiCard label="Dernière activité" value={formatEventTimestamp(kpis.latestTimestamp)} className="xl:col-span-2" />
        <KpiCard label="Scope" value={telemetryScopeLabel(scope)} className="xl:col-span-2" />
      </div>

      <div className="grid gap-3 lg:grid-cols-12">
        <div className="lg:col-span-3">
          <Label htmlFor="telemetry-scope">Domaine</Label>
          <Select value={scope} onValueChange={(value) => onScopeChange(value as TelemetryScope)}>
            <SelectTrigger id="telemetry-scope" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tous domaines</SelectItem>
              <SelectItem value="local">Local ASR</SelectItem>
              <SelectItem value="cloud">Cloud ASR</SelectItem>
              <SelectItem value="llm_local">LLM Local</SelectItem>
              <SelectItem value="llm_cloud">LLM Cloud</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="lg:col-span-2">
          <Label htmlFor="telemetry-severity">Sévérité</Label>
          <Select value={severity} onValueChange={(value) => onSeverityChange(value as TelemetrySeverityFilter)}>
            <SelectTrigger id="telemetry-severity" className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Tout</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="lg:col-span-4">
          <Label htmlFor="telemetry-search">Recherche</Label>
          <Input
            id="telemetry-search"
            className="mt-1"
            value={searchQuery}
            placeholder="Type événement, provider, stage…"
            onChange={(event) => onSearchQueryChange(event.target.value)}
          />
        </div>

        <div className="lg:col-span-3 flex items-end gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            onClick={() => onLiveModeChange(liveMode === "on" ? "off" : "on")}
          >
            {liveMode === "on" ? "Pause live" : "Reprendre live"}
          </Button>
          <Button type="button" variant="outline" onClick={onResetFilters}>
            Reset filtres
          </Button>
          <div className="flex items-center gap-2 pl-1">
            <Switch
              id="telemetry-live-switch"
              checked={liveMode === "on"}
              onCheckedChange={(checked) => onLiveModeChange(checked ? "on" : "off")}
            />
            <Label htmlFor="telemetry-live-switch" className="text-xs text-muted-foreground">
              Live
            </Label>
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({
  label,
  value,
  hint,
  className,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  className?: string;
  tone?: "default" | "warn" | "error";
}) {
  const valueClassName =
    tone === "error"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-400"
        : "text-foreground";

  return (
    <div className={`rounded-md border bg-muted/30 px-3 py-2 ${className ?? ""}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-sm font-semibold ${valueClassName}`}>{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
