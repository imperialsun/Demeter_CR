import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TelemetryDomain, TelemetryDomainStats, TelemetryScope } from "@/lib/telemetryView";
import { formatEventTimestamp, telemetryDomainLabel } from "@/lib/telemetryView";

interface TelemetryDomainHealthProps {
  statsByDomain: Record<TelemetryDomain, TelemetryDomainStats>;
  scope: TelemetryScope;
  onScopeChange: (scope: TelemetryScope) => void;
}

const DOMAIN_ROWS: TelemetryDomain[] = ["local", "cloud", "llm_local", "llm_cloud", "unknown"];

export function TelemetryDomainHealth({ statsByDomain, scope, onScopeChange }: TelemetryDomainHealthProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Santé domaines</CardTitle>
        <CardDescription>Vision rapide des signaux par surface.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button
          type="button"
          size="sm"
          variant={scope === "all" ? "default" : "outline"}
          className="w-full justify-between"
          onClick={() => onScopeChange("all")}
        >
          <span>Tous domaines</span>
          <span className="text-xs">{Object.values(statsByDomain).reduce((sum, item) => sum + item.total, 0)}</span>
        </Button>

        {DOMAIN_ROWS.map((domain) => {
          const stats = statsByDomain[domain];
          const canFilter = domain !== "unknown";
          const isActive = canFilter ? scope === (domain as Exclude<TelemetryScope, "all">) : false;

          return (
            <div key={domain} className="rounded-md border bg-muted/20 p-2">
              <div className="flex items-center justify-between gap-2">
                {canFilter ? (
                  <Button
                    type="button"
                    size="sm"
                    variant={isActive ? "secondary" : "ghost"}
                    className="h-auto px-2 py-1 text-xs"
                    onClick={() => onScopeChange(domain as Exclude<TelemetryScope, "all">)}
                  >
                    {telemetryDomainLabel(domain)}
                  </Button>
                ) : (
                  <span className="text-xs font-medium">{telemetryDomainLabel(domain)}</span>
                )}

                <Badge variant="outline">{stats.total}</Badge>
              </div>

              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <StatCell label="Errors" value={String(stats.errors)} tone={stats.errors > 0 ? "error" : "default"} />
                <StatCell label="Warnings" value={String(stats.warnings)} tone={stats.warnings > 0 ? "warn" : "default"} />
                <StatCell label="Dernier" value={formatEventTimestamp(stats.latestTimestamp)} />
              </div>

              {stats.latestErrorType ? (
                <p className="mt-2 truncate text-[11px] text-destructive" title={stats.latestErrorType}>
                  Dernière erreur: {stats.latestErrorType}
                </p>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function StatCell({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "warn" | "error";
}) {
  const className =
    tone === "error"
      ? "text-destructive"
      : tone === "warn"
        ? "text-amber-400"
        : "text-foreground";

  return (
    <div className="rounded-sm bg-background/60 px-2 py-1">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`text-xs font-semibold ${className}`}>{value}</p>
    </div>
  );
}
