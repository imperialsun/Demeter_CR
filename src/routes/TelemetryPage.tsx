import { TelemetryPanel } from "@/components/telemetry/TelemetryPanel";
import logger from "@/lib/logger";
import {
  normalizeTelemetryLiveMode,
  normalizeTelemetryScope,
  normalizeTelemetrySeverity,
  normalizeTelemetryTab,
  type TelemetryLiveMode,
  type TelemetryScope,
  type TelemetrySeverityFilter,
  type TelemetryDetailTab,
} from "@/lib/telemetryView";
import { useAsrStore } from "@/store/asr-store";
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";

function TelemetryPage() {
  const summary = useAsrStore((state) => state.telemetrySummary);
  const [searchParams, setSearchParams] = useSearchParams();

  const scope = normalizeTelemetryScope(searchParams.get("scope"));
  const tab = normalizeTelemetryTab(searchParams.get("tab"));
  const severity = normalizeTelemetrySeverity(searchParams.get("severity"));
  const liveMode = normalizeTelemetryLiveMode(searchParams.get("live"));

  const setViewParam = useCallback(
    (
      key: "scope" | "tab" | "severity" | "live",
      value: TelemetryScope | TelemetryDetailTab | TelemetrySeverityFilter | TelemetryLiveMode,
      defaultValue: TelemetryScope | TelemetryDetailTab | TelemetrySeverityFilter | TelemetryLiveMode
    ) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (value === defaultValue) {
            next.delete(key);
          } else {
            next.set(key, value);
          }
          return next;
        },
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const resetViewParams = useCallback(() => {
    logger.info("[route][telemetry] reset filters");
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("scope");
        next.delete("tab");
        next.delete("severity");
        next.delete("live");
        return next;
      },
      { replace: true }
    );
  }, [setSearchParams]);

  useEffect(() => {
    logger.info("[route][telemetry] page mounted", {
      scope,
      tab,
      severity,
      liveMode,
      eventCount: summary?.events.length ?? 0,
    });
    return () => {
      logger.debug("[route][telemetry] page unmounted");
    };
  }, [liveMode, scope, severity, summary?.events.length, tab]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Télémetrie</h2>
        <p className="text-muted-foreground">
          Cockpit live: filtrez les événements par domaine, suivez la session en temps réel et inspectez les détails
          techniques.
        </p>
      </header>
      <TelemetryPanel
        summary={summary}
        scope={scope}
        tab={tab}
        severity={severity}
        liveMode={liveMode}
        onScopeChange={(nextScope) => {
          logger.debug("[route][telemetry] scope updated", { from: scope, to: nextScope });
          setViewParam("scope", nextScope, "all");
        }}
        onTabChange={(nextTab) => {
          logger.debug("[route][telemetry] tab updated", { from: tab, to: nextTab });
          setViewParam("tab", nextTab, "overview");
        }}
        onSeverityChange={(nextSeverity) => {
          logger.debug("[route][telemetry] severity updated", { from: severity, to: nextSeverity });
          setViewParam("severity", nextSeverity, "all");
        }}
        onLiveModeChange={(nextLiveMode) => {
          logger.debug("[route][telemetry] live mode updated", { from: liveMode, to: nextLiveMode });
          setViewParam("live", nextLiveMode, "on");
        }}
        onResetFilters={resetViewParams}
      />
    </div>
  );
}

export default TelemetryPage;
