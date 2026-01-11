import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAsrStore } from "@/store/asr-store";
import type { TelemetrySummary, TelemetryEvent } from "@/lib/telemetry";

interface Props {
  summary: TelemetrySummary;
}

export function PreprocessTelemetryPanel({ summary }: Props) {
  const autoTunePreprocess = useAsrStore((s) => s.autoTunePreprocess);
  const lastAutoTune = useAsrStore((s) => s.lastAutoTuneParams);
  const noiseFloorDb = useAsrStore((s) => s.denoiseNoiseFloorDb);
  const reductionDb = useAsrStore((s) => s.denoiseReductionDb);
  const smoothing = useAsrStore((s) => s.denoiseSmoothing);
  const calibrationSeconds = useAsrStore((s) => s.denoiseCalibrationSeconds);
  const preprocessingStatus = useAsrStore((s) => s.preprocessingStatus);
  const preprocessingProgress = useAsrStore((s) => s.preprocessingProgress);

  const preprocessEvents: TelemetryEvent[] = summary.events.filter(
    (e) => e.type.startsWith("PREPROCESS_") || e.type === "CALIBRATION_REQUESTED"
  );

  const preprocessAlerts = Object.entries(summary.alerts).filter(([k]) => k.startsWith("PREPROCESS_"));

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle>Prétraitement</CardTitle>
        <CardDescription>Événements et paramètres liés au prétraitement audio.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-3 text-sm">
          <div>
            <div className="flex items-center justify-between">
              <div className="text-xs text-muted-foreground">Statut</div>
              <Badge variant={preprocessingStatus === "done" ? "secondary" : preprocessingStatus === "calibrating" ? "warning" : "default"}>
                {preprocessingStatus}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-2">Progression</div>
            <div className="mt-2 flex items-center gap-3">
              <div className="flex-1">
                <Progress value={Math.round(preprocessingProgress * 100)} className="h-2 w-full" />
              </div>
              <div className="text-xs font-medium w-14 text-right">{Math.round(preprocessingProgress * 100)}%</div>
            </div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground">Auto‑Tune</div>
            <div className="mt-2 flex items-center gap-2">
              <Badge variant={autoTunePreprocess ? "secondary" : "default"}>
                {autoTunePreprocess ? "Activé" : "Désactivé"}
              </Badge>
              {lastAutoTune ? (
                <div className="text-xs text-muted-foreground">Dernier autotune appliqué</div>
              ) : (
                <div className="text-xs text-muted-foreground">Aucun autotune</div>
              )}
            </div>

            <div className="text-xs text-muted-foreground mt-3">Calibration</div>
            <div className="mt-1 font-medium">{calibrationSeconds}s</div>
          </div>

          <div>
            <div className="text-xs text-muted-foreground">Paramètres actifs</div>
            <div className="mt-2 space-y-1">
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Noise floor</span>
                <span className="font-medium">{noiseFloorDb} dB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Reduction</span>
                <span className="font-medium">{reductionDb} dB</span>
              </div>
              <div className="flex justify-between">
                <span className="text-xs text-muted-foreground">Smoothing</span>
                <span className="font-medium">{smoothing}</span>
              </div>
            </div>
          </div>
        </div>

        {lastAutoTune ? (
          <div className="mb-3 text-sm">
            <div className="text-xs text-muted-foreground">Dernier autotune</div>
            <div className="mt-2 grid grid-cols-3 gap-2">
              <div>
                <div className="text-xs text-muted-foreground">Noise floor</div>
                <div className="font-medium">{lastAutoTune.noiseFloorDb} dB</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Reduction</div>
                <div className="font-medium">{lastAutoTune.reductionDb} dB</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Smoothing</div>
                <div className="font-medium">{lastAutoTune.smoothing}</div>
              </div>
            </div>
          </div>
        ) : null}

        <div className="text-xs text-muted-foreground mb-2">Événements prétraitement</div>
        <ScrollArea className="h-40">
          <ul className="space-y-2 text-sm">
            {preprocessEvents.length ? (
              preprocessEvents.map((event, i) => (
                <li key={`${event.timestamp}-${i}-${event.type}`} className="rounded-md border bg-muted/40 p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{event.type}</span>
                    <span className="text-xs text-muted-foreground">{event.timestamp.toFixed(0)} ms</span>
                  </div>
                  {event.data ? (
                    <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(event.data, null, 2)}</pre>
                  ) : null}
                </li>
              ))
            ) : (
              <li className="text-center text-muted-foreground">Aucun événement de prétraitement.</li>
            )}
          </ul>
        </ScrollArea>

        {preprocessAlerts.length ? (
          <div className="mt-3 text-sm">
            <div className="text-xs text-muted-foreground">Alertes prétraitement</div>
            <div className="mt-2">
              {preprocessAlerts.map(([key, val]) => (
                <div key={key} className="rounded-md border bg-destructive/10 p-2 mb-2 text-sm">
                  <div className="font-medium">{key}</div>
                  <div className="text-xs text-muted-foreground">Comptes: {val.count}</div>
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(val.lastData ?? {}, null, 2)}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
