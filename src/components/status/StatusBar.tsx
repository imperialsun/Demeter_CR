import { useMemo } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAsrStore } from "@/store/asr-store";
import { Loader2, PauseCircle, Play } from "lucide-react";

interface StatusBarProps {
  onStop?: () => void;
  onStart?: () => void;
  onResetSession?: () => void | Promise<void>;
  startDisabled?: boolean;
  resetDisabled?: boolean;
  mode?: "upload" | "mic";
}

const STATUS_LABELS: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
  idle: { label: "En attente", tone: "secondary" },
  downloading: { label: "Téléchargement du modèle", tone: "secondary" },
  loading: { label: "Initialisation", tone: "secondary" },
  ready: { label: "Prêt", tone: "default" },
  transcribing: { label: "Transcription en cours", tone: "default" },
  stopping: { label: "Arrêt en cours", tone: "secondary" },
  error: { label: "Erreur", tone: "destructive" },
};

export function StatusBar({
  onStop,
  onStart,
  onResetSession,
  startDisabled,
  resetDisabled,
  mode = "upload",
}: StatusBarProps) {
  const {
    status,
    statusDetail,
    progress,
    isTranscribing,
    stopRequested,
    chunkPlan,
    chunkMetrics,
    segments,
    activeBackend,
    backendPreference,
    chunkStrategy,
    chunkDurationSec,
    overlapSec,
    audioMetadata,
  } = useAsrStore();

  const statusMeta = STATUS_LABELS[status] ?? STATUS_LABELS.idle;
  const percent = Math.round(progress * 100);
  const doneCount = useMemo(() => (mode === "mic" ? chunkMetrics.length : segments.length), [chunkMetrics.length, mode, segments.length]);
  const countLabel = mode === "mic" ? "chunks" : "segments";
  const lastChunkMetric = chunkMetrics.at(-1);
  const lastRealtimeFactor = lastChunkMetric?.realtimeFactor;
  const totalChunks = useMemo(() => {
    if (mode === "mic") {
      return chunkPlan.length;
    }
    const durationSec = audioMetadata?.durationSec ?? 0;
    if (!Number.isFinite(durationSec) || durationSec <= 0 || chunkDurationSec <= 0) {
      return chunkPlan.length;
    }
    const strategy = chunkStrategy === "silence" ? "overlap" : chunkStrategy;
    const step = strategy === "sequential" ? chunkDurationSec : Math.max(0.5, chunkDurationSec - overlapSec);
    let count = 0;
    for (let start = 0; start < durationSec; start += step) {
      const end = Math.min(start + chunkDurationSec, durationSec);
      count += 1;
      if (end >= durationSec) break;
    }
    return count;
  }, [audioMetadata?.durationSec, chunkDurationSec, overlapSec, chunkStrategy, chunkPlan.length, mode]);
  const backendDisplay = activeBackend ?? backendPreference;
  const backendBadgeVariant: "success" | "warning" = backendDisplay === "webgpu" ? "success" : "warning";
  const backendBadge = backendDisplay
    ? {
        variant: backendBadgeVariant,
        label: backendDisplay === "webgpu" ? "WebGPU" : "WASM",
      }
    : null;

  const { totalChunkDuration, processedChunkDuration, averageRealtimeFactor } = useMemo(() => {
    let totalChunkDuration = 0;
    if (mode === "mic") {
      totalChunkDuration = chunkPlan.reduce((acc, chunk) => acc + Math.max(0, chunk.end - chunk.start), 0);
    } else {
      const durationSec = audioMetadata?.durationSec ?? 0;
      if (Number.isFinite(durationSec) && durationSec > 0 && chunkDurationSec > 0) {
        const strategy = chunkStrategy === "silence" ? "overlap" : chunkStrategy;
        const step = strategy === "sequential" ? chunkDurationSec : Math.max(0.5, chunkDurationSec - overlapSec);
        for (let start = 0; start < durationSec; start += step) {
          const end = Math.min(start + chunkDurationSec, durationSec);
          totalChunkDuration += Math.max(0, end - start);
          if (end >= durationSec) break;
        }
      } else {
        totalChunkDuration = chunkPlan.reduce((acc, chunk) => acc + Math.max(0, chunk.end - chunk.start), 0);
      }
    }
    let processedChunkDuration = 0;
    let realtimeSum = 0;
    for (const metric of chunkMetrics) {
      processedChunkDuration += Math.max(0, metric.endSec - metric.startSec);
      realtimeSum += metric.realtimeFactor;
    }
    const averageRealtimeFactor = chunkMetrics.length > 0 ? realtimeSum / chunkMetrics.length : undefined;
    return { totalChunkDuration, processedChunkDuration, averageRealtimeFactor };
  }, [audioMetadata?.durationSec, chunkDurationSec, overlapSec, chunkStrategy, chunkPlan, chunkMetrics, mode]);
  const remainingChunkDuration = Math.max(0, totalChunkDuration - processedChunkDuration);
  const etaFactorPreference = lastRealtimeFactor ?? averageRealtimeFactor;
  const etaSeconds =
    remainingChunkDuration > 0 && typeof etaFactorPreference === "number"
      ? remainingChunkDuration * etaFactorPreference
      : undefined;
  const etaDisplay = typeof etaSeconds === "number" && etaSeconds > 0 ? formatEta(etaSeconds) : undefined;

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:flex-wrap">
        <div className="space-y-2 flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusMeta.tone === "destructive" ? "destructive" : statusMeta.tone}>
              {statusMeta.label}
            </Badge>
            {backendBadge ? (
              <Badge variant={backendBadge.variant}>{backendBadge.label}</Badge>
            ) : null}
            {statusDetail ? <span className="text-sm text-muted-foreground">{statusDetail}</span> : null}
          </div>
          <Progress value={percent} className="h-2 w-full" />
          <p className="text-xs text-muted-foreground">
            {doneCount}/{totalChunks || "?"} {countLabel} traités — {percent}%
          </p>
          {typeof lastRealtimeFactor === "number" ? (
            <p className="text-xs text-muted-foreground">
              Vitesse (dernier segment) : x{lastRealtimeFactor.toFixed(2)}
            </p>
          ) : null}
          {etaDisplay ? (
            <p className="text-xs text-muted-foreground">Estimation restante : {etaDisplay}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-3 md:shrink-0">
          {!isTranscribing && onStart ? (
            <Button
              size="sm"
              className="gap-2 whitespace-normal text-left leading-tight"
              onClick={onStart}
              disabled={startDisabled}
            >
              <Play className="h-4 w-4" />
              Lancer la transcription
            </Button>
          ) : null}
          {isTranscribing && onStop ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2 whitespace-normal text-left leading-tight"
              disabled={stopRequested}
              onClick={onStop}
            >
              {stopRequested ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <PauseCircle className="h-4 w-4" />
              )}
              {stopRequested ? "Arrêt en cours…" : "Stop (fin du chunk)"}
            </Button>
          ) : null}
          {mode === "upload" && onResetSession ? (
            <Button
              variant="outline"
              size="sm"
              className="whitespace-normal border-border bg-background/60 text-left leading-tight"
              onClick={() => {
                void onResetSession();
              }}
              disabled={Boolean(resetDisabled)}
            >
              Réinitialiser la session
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function formatEta(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
