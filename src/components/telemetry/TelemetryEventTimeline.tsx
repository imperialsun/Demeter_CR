import { useEffect } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { TelemetryLiveMode, TelemetryViewEvent } from "@/lib/telemetryView";
import { formatEventTimestamp, telemetryDomainLabel } from "@/lib/telemetryView";
import { useVirtualizedList } from "@/hooks/useVirtualizedList";

interface TelemetryEventTimelineProps {
  events: TelemetryViewEvent[];
  selectedEventKey: string | null;
  liveMode: TelemetryLiveMode;
  onSelectEvent: (eventKey: string) => void;
  compact?: boolean;
}

export function TelemetryEventTimeline({
  events,
  selectedEventKey,
  liveMode,
  onSelectEvent,
  compact = false,
}: TelemetryEventTimelineProps) {
  const {
    parentRef: containerRef,
    virtualItems,
    totalSize,
    measureElement,
  } = useVirtualizedList({
    items: events,
    estimateSize: (index) => {
      const entry = events[index];
      if (!entry) {
        return compact ? 84 : 108;
      }
      const hasPreview = Boolean(entry.event.data);
      return compact ? (hasPreview ? 100 : 84) : (hasPreview ? 132 : 108);
    },
    getItemKey: (entry) => entry.key,
    overscan: 2,
    fallbackHeight: compact ? 288 : 480,
  });

  useEffect(() => {
    if (liveMode !== "on") return;
    const node = containerRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [events.length, liveMode, containerRef]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline événements</CardTitle>
        <CardDescription>Flux chronologique filtré en temps réel.</CardDescription>
      </CardHeader>
      <CardContent>
        <div
          ref={containerRef}
          data-testid="telemetry-timeline-scroll"
          className={compact ? "max-h-[18rem] overflow-y-auto pr-1" : "max-h-[34rem] overflow-y-auto pr-1"}
        >
          {events.length ? (
            <div className="relative w-full" style={{ height: totalSize }}>
              {virtualItems.map((virtualRow) => {
                const entry = events[virtualRow.index];
                if (!entry) {
                  return null;
                }
                const preview = entry.event.data ? JSON.stringify(entry.event.data).slice(0, compact ? 100 : 180) : null;
                const isSelected = selectedEventKey === entry.key;
                return (
                  <button
                    key={entry.key}
                    ref={measureElement}
                    data-index={virtualRow.index}
                    type="button"
                    className={`absolute left-0 top-0 w-full rounded-md border p-2 text-left transition-colors ${
                      isSelected ? "border-primary bg-primary/10" : "bg-muted/30 hover:bg-muted/50"
                    }`}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                    onClick={() => onSelectEvent(entry.key)}
                  >
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">{entry.event.type}</span>
                      <Badge variant={domainBadgeVariant(entry.domain)}>{telemetryDomainLabel(entry.domain)}</Badge>
                      <Badge variant={severityBadgeVariant(entry.severity)}>{entry.severity}</Badge>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {formatEventTimestamp(entry.event.timestamp)}
                      </span>
                    </div>
                    {preview ? (
                      <p className="mt-1 break-all text-[11px] text-muted-foreground">{preview}</p>
                    ) : (
                      <p className="mt-1 text-[11px] text-muted-foreground">Sans payload.</p>
                    )}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucun événement pour ces filtres.</p>
          )}
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
