import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { exportLogEntries, type LogEntry } from "@/lib/logger";
import { Monitor, X } from "lucide-react";

const REFRESH_INTERVAL_MS = 500;
const MAX_VISIBLE_LOGS = 80;

const LEVEL_BADGE_VARIANTS: Record<LogEntry["level"], "default" | "secondary" | "destructive" | "outline" | "warning"> =
  {
    error: "destructive",
    warn: "warning",
    info: "default",
    debug: "outline",
  };

const ORIGIN_LABELS: Record<LogEntry["origin"], string> = {
  logger: "Logger",
  console: "Console",
  "browser-error": "Erreur navigateur",
  unhandledrejection: "Rejet non géré",
};

interface TopbarConsoleLogsPanelProps {
  open: boolean;
  onClose: () => void;
}

function formatTimestamp(timestamp: string) {
  return timestamp.slice(11, 23);
}

function formatContext(context: unknown) {
  if (typeof context === "string") {
    return context;
  }

  try {
    return JSON.stringify(context, null, 2);
  } catch {
    return String(context);
  }
}

function sameEntries(previous: LogEntry[], next: LogEntry[]) {
  if (previous.length !== next.length) {
    return false;
  }

  return previous.every((entry, index) => entry === next[index]);
}

export function TopbarConsoleLogsPanel({ open, onClose }: TopbarConsoleLogsPanelProps) {
  const [entries, setEntries] = useState<LogEntry[]>(() => exportLogEntries());
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const followBottomRef = useRef(true);

  useEffect(() => {
    if (!open) {
      return;
    }

    const refreshEntries = () => {
      const nextEntries = exportLogEntries();
      setEntries((current) => (sameEntries(current, nextEntries) ? current : nextEntries));
    };

    followBottomRef.current = true;
    refreshEntries();
    const intervalId = window.setInterval(refreshEntries, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !followBottomRef.current) {
      return;
    }

    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    viewport.scrollTop = viewport.scrollHeight;
  }, [entries, open]);

  if (!open) {
    return null;
  }

  const visibleEntries = entries.slice(-MAX_VISIBLE_LOGS);

  return (
    <section
      id="topbar-console-logs-panel"
      data-testid="topbar-console-logs-panel"
      className="border-t border-border/60 bg-muted/40 px-4 py-3"
      aria-label="Logs console"
      role="region"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1 border-border/60 bg-background/70 text-xs text-foreground">
              <Monitor className="h-3 w-3" />
              Logs console
            </Badge>
            <Badge variant="secondary" className="text-xs">
              {entries.length} logs
            </Badge>
            <Badge variant="outline" className="border-border/60 bg-background/70 text-xs text-foreground">
              Derniers {Math.min(entries.length, MAX_VISIBLE_LOGS)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Les derniers logs capturés par le buffer local, y compris `console.*` et les erreurs navigateur.
          </p>
        </div>

        <Button variant="ghost" size="sm" className="gap-2" onClick={onClose} aria-label="Masquer les logs console">
          <X className="h-4 w-4" />
          Fermer
        </Button>
      </div>

      <div
        ref={viewportRef}
        onScroll={() => {
          const viewport = viewportRef.current;
          if (!viewport) {
            return;
          }

          const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
          followBottomRef.current = distanceFromBottom < 24;
        }}
        className="mt-3 max-h-64 overflow-y-auto rounded-xl border border-border/60 bg-slate-950/95 p-3 text-slate-50 shadow-inner"
      >
        {visibleEntries.length === 0 ? (
          <p className="text-sm text-slate-300">Aucun log capturé pour le moment.</p>
        ) : (
          <div className="space-y-2">
            {visibleEntries.map((entry, index) => {
              const levelVariant = LEVEL_BADGE_VARIANTS[entry.level];
              const originLabel = ORIGIN_LABELS[entry.origin];
              const hasContext = typeof entry.context !== "undefined";

              return (
                <article
                  key={`${entry.timestamp}-${entry.level}-${entry.origin}-${index}`}
                  className={cn(
                    "rounded-lg border px-3 py-2",
                    entry.level === "error"
                      ? "border-rose-500/30 bg-rose-500/10"
                      : entry.level === "warn"
                        ? "border-amber-400/30 bg-amber-400/10"
                        : "border-white/10 bg-white/5"
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="font-medium text-slate-300">{formatTimestamp(entry.timestamp)}</span>
                    <Badge variant={levelVariant} className="h-5 px-2 text-[10px] uppercase tracking-wide">
                      {entry.level}
                    </Badge>
                    <Badge variant="outline" className="h-5 border-white/10 bg-white/5 px-2 text-[10px] text-slate-100">
                      {originLabel}
                    </Badge>
                    {entry.scopes.length > 0 ? (
                      <span className="truncate text-[11px] text-slate-400">
                        {entry.scopes.map((scope) => `[${scope}]`).join(" ")}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-50">{entry.message}</p>
                  {hasContext ? (
                    <pre className="mt-2 overflow-x-auto rounded-md bg-black/30 p-2 text-[11px] leading-5 text-slate-300">
                      {formatContext(entry.context)}
                    </pre>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}
