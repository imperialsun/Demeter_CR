import { TelemetryPanel } from "@/components/telemetry/TelemetryPanel";
import { useAsrStore } from "@/store/asr-store";

function TelemetryPage() {
  const summary = useAsrStore((state) => state.telemetrySummary);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Télémetrie</h2>
        <p className="text-muted-foreground">
          Inspectez les métriques de performance, la consommation mémoire et exportez les journaux de benchmark.
        </p>
      </header>
      <TelemetryPanel summary={summary} />
    </div>
  );
}

export default TelemetryPage;
