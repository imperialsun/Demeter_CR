import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TelemetryViewEvent } from "@/lib/telemetryView";
import { formatEventTimestamp, telemetryDomainLabel } from "@/lib/telemetryView";

interface TelemetryEventInspectorProps {
  event: TelemetryViewEvent | null;
}

const CONTEXT_KEYS = ["provider", "stage", "modelId", "sourceMode", "format", "reason", "backend", "dtype"];

export function TelemetryEventInspector({ event }: TelemetryEventInspectorProps) {
  if (!event) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Inspecteur</CardTitle>
          <CardDescription>Sélectionnez un événement de la timeline.</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">Aucun événement sélectionné.</p>
        </CardContent>
      </Card>
    );
  }

  const dataEntries = event.event.data ? Object.entries(event.event.data) : [];
  const contextEntries = dataEntries.filter(([key]) => CONTEXT_KEYS.includes(key));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="break-all text-base">{event.event.type}</CardTitle>
        <CardDescription>Détails techniques de l’événement sélectionné.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant={domainBadgeVariant(event.domain)}>{telemetryDomainLabel(event.domain)}</Badge>
          <Badge variant={severityBadgeVariant(event.severity)}>{event.severity}</Badge>
          <Badge variant="outline">{formatEventTimestamp(event.event.timestamp)}</Badge>
        </div>

        {contextEntries.length ? (
          <div className="rounded-md border bg-muted/20 p-2">
            <p className="text-xs font-medium">Contexte</p>
            <div className="mt-2 space-y-1 text-xs">
              {contextEntries.map(([key, value]) => (
                <div key={key} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{key}</span>
                  <span className="max-w-[220px] truncate text-right" title={String(value)}>
                    {String(value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-1 text-xs font-medium">Payload brut</p>
          <pre className="max-h-[24rem] overflow-auto rounded-md border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            {JSON.stringify(event.event.data ?? {}, null, 2)}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

function severityBadgeVariant(severity: TelemetryViewEvent["severity"]): "destructive" | "warning" | "secondary" | "outline" {
  if (severity === "error") return "destructive";
  if (severity === "warn") return "warning";
  if (severity === "debug") return "outline";
  return "secondary";
}

function domainBadgeVariant(domain: TelemetryViewEvent["domain"]): "success" | "secondary" | "violet" | "warning" | "outline" {
  if (domain === "local") return "success";
  if (domain === "cloud") return "secondary";
  if (domain === "llm_local") return "violet";
  if (domain === "llm_cloud") return "warning";
  return "outline";
}
