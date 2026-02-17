import { TelemetryPanel } from "@/components/telemetry/TelemetryPanel";
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
import { useCallback } from "react";
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
        onScopeChange={(nextScope) => setViewParam("scope", nextScope, "all")}
        onTabChange={(nextTab) => setViewParam("tab", nextTab, "overview")}
        onSeverityChange={(nextSeverity) => setViewParam("severity", nextSeverity, "all")}
        onLiveModeChange={(nextLiveMode) => setViewParam("live", nextLiveMode, "on")}
        onResetFilters={resetViewParams}
      />
    </div>
  );
}

export default TelemetryPage;
