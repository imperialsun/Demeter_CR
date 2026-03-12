import { Mic, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMicTranscription } from "@/hooks/useMicTranscription";
import { useAsrStore } from "@/store/asr-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { StatusBar } from "@/components/status/StatusBar";
import { ResultsTable } from "@/components/results/ResultsTable";
import { ExportButtons } from "@/components/results/ExportButtons";
import { toast } from "@/components/ui/use-toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import logger from "@/lib/logger";

const STATUS_LABELS: Record<string, { label: string; tone: "default" | "secondary" | "destructive" }> = {
  idle: { label: "En attente", tone: "secondary" },
  downloading: { label: "Téléchargement du modèle", tone: "secondary" },
  loading: { label: "Initialisation", tone: "secondary" },
  ready: { label: "Prêt", tone: "default" },
  transcribing: { label: "Transcription en cours", tone: "default" },
  stopping: { label: "Finalisation", tone: "secondary" },
  error: { label: "Erreur", tone: "destructive" },
};

function formatTimer(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

function MicPage() {
  const {
    isRecording,
    isStopping,
    pendingCount,
    recordingSeconds,
    audioLevel,
    hasRecording,
    isCalibratingNoise,
    noiseCalibrated,
    startRecording,
    stopRecording,
    prepareRecordingWav,
    prepareRecordingMp3,
    calibrateSilenceThreshold,
  } = useMicTranscription();
  const segments = useAsrStore((state) => state.segments);
  const telemetrySummary = useAsrStore((state) => state.telemetrySummary);
  const status = useAsrStore((state) => state.status);
  const statusDetail = useAsrStore((state) => state.statusDetail);
  const activeBackend = useAsrStore((state) => state.activeBackend);
  const backendPreference = useAsrStore((state) => state.backendPreference);
  const micBackendPreference = useAsrStore((state) => state.micBackendPreference);
  const micShowExportVtt = useAsrStore((state) => state.micShowExportVtt);
  const micShowExportSrt = useAsrStore((state) => state.micShowExportSrt);
  const micShowExportJson = useAsrStore((state) => state.micShowExportJson);
  const micShowExportTelemetry = useAsrStore((state) => state.micShowExportTelemetry);
  const resetCounter = useAsrStore((state) => state.resetCounter);

  const statusMeta = STATUS_LABELS[status] ?? STATUS_LABELS.idle;
  // Match Topbar: show active backend if present, otherwise show the global preference.
  // (Mic preference can differ; it's used when creating the mic pipeline.)
  const backend = activeBackend ?? backendPreference;
  const backendBadge: { variant: "success" | "warning"; label: string } | null = backend
    ? {
        variant: backend === "webgpu" ? "success" : "warning",
        label: backend === "webgpu" ? "WebGPU" : "WASM",
      }
    : null;

  const canExport = useMemo(() => !isRecording && segments.length > 0, [isRecording, segments.length]);
  const [mp3Url, setMp3Url] = useState<string | null>(null);
  const [wavUrl, setWavUrl] = useState<string | null>(null);
  const [isPreparingMp3, setIsPreparingMp3] = useState(false);
  const showStatusBar = hasRecording && !isRecording;

  const recordingButtonStyle = isRecording
    ? {
        transform: `scale(${1 + audioLevel * 0.08})`,
        boxShadow: `0 0 ${10 + audioLevel * 30}px rgba(239,68,68,${0.2 + audioLevel * 0.6})`,
      }
    : undefined;

  const recordingDisabledReason =
    !isRecording && !noiseCalibrated
      ? "Faites silence et initialisez le bruit de fond de la pièce en cliquant sur « Initialiser bruit » ci-dessous."
      : null;

  useEffect(() => {
    logger.debug("[mic][ui] page mounted", {
      backendPreference,
      micBackendPreference,
      activeBackend: activeBackend ?? null,
      segmentsCount: segments.length,
    });
    return () => {
      logger.debug("[mic][ui] page unmounted");
    };
  }, [activeBackend, backendPreference, micBackendPreference, segments.length]);

  useEffect(() => {
    return () => {
      if (mp3Url) {
        URL.revokeObjectURL(mp3Url);
      }
      if (wavUrl) {
        URL.revokeObjectURL(wavUrl);
      }
    };
  }, [mp3Url, wavUrl]);

  useEffect(() => {
    setIsPreparingMp3(false);
    setMp3Url((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
    setWavUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return null;
    });
  }, [resetCounter]);

  useEffect(() => {
    if (isRecording && mp3Url) {
      URL.revokeObjectURL(mp3Url);
      setMp3Url(null);
    }
    if (isRecording && wavUrl) {
      URL.revokeObjectURL(wavUrl);
      setWavUrl(null);
    }
  }, [isRecording, mp3Url, wavUrl]);

  useEffect(() => {
    if (!hasRecording || isRecording) return;
    if (wavUrl) return;
    try {
      const blob = prepareRecordingWav();
      const url = URL.createObjectURL(blob);
      setWavUrl(url);
    } catch (err) {
      void err;
    }
  }, [hasRecording, isRecording, prepareRecordingWav, wavUrl]);

  const handlePrepareMp3 = async () => {
    if (!hasRecording || isPreparingMp3) return;
    logger.info("[mic][ui] prepare mp3 requested", {
      hasRecording,
      isRecording,
      pendingCount,
    });
    setIsPreparingMp3(true);
    try {
      const blob = await prepareRecordingMp3();
      const url = URL.createObjectURL(blob);
      setMp3Url((previous) => {
        if (previous) {
          URL.revokeObjectURL(previous);
        }
        return url;
      });
      logger.info("[mic][ui] prepare mp3 success", { sizeBytes: blob.size });
      toast("MP3 prêt. Cliquez sur Télécharger pour récupérer l'audio.");
    } catch (error) {
      const message = (error as Error)?.message ?? "Impossible de générer le MP3.";
      logger.error("[mic][ui] prepare mp3 failed", { message });
      toast(message);
    } finally {
      setIsPreparingMp3(false);
    }
  };

  const handleRecordingToggle = () => {
    if (isRecording) {
      logger.info("[mic][ui] stop recording requested", {
        pendingCount,
        recordingSeconds,
      });
      stopRecording();
      return;
    }
    logger.info("[mic][ui] start recording requested", {
      noiseCalibrated,
      pendingCount,
    });
    startRecording();
  };

  const handleCalibrateNoise = () => {
    logger.info("[mic][ui] noise calibration requested", {
      isCalibratingNoise,
      noiseCalibrated,
    });
    calibrateSilenceThreshold();
  };

  const handleStopAfterChunk = () => {
    logger.info("[mic][ui] stop after chunk requested", { pendingCount });
    const state = useAsrStore.getState();
    state.setStatus("stopping", "Arrêt après le chunk courant");
    state.requestStop();
  };

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Micro en direct</h2>
        <p className="text-muted-foreground">
          Lancez l'enregistrement et transcrivez au fil des silences. Arrêtez pour télécharger le résultat.
        </p>
      </header>

      {showStatusBar ? (
        <div className="sticky top-2 z-50 w-full">
          <StatusBar mode="mic" onStop={handleStopAfterChunk} />
        </div>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          {showStatusBar ? (
            <>
              <Card>
                <CardContent className="mt-2 space-y-3 p-6 text-center">
                  <div className="space-y-2 text-sm">
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Badge variant={statusMeta.tone === "destructive" ? "destructive" : statusMeta.tone}>
                        {statusMeta.label}
                      </Badge>
                      {backendBadge ? <Badge variant={backendBadge.variant}>{backendBadge.label}</Badge> : null}
                      {activeBackend && activeBackend !== micBackendPreference ? (
                        <Badge variant="outline" className="capitalize">
                          {`Préférence : ${micBackendPreference}`}
                        </Badge>
                      ) : null}
                    </div>
                    {statusDetail ? <div className="text-xs text-muted-foreground">{statusDetail}</div> : null}
                    <div className="text-xs text-muted-foreground">Durée : {formatTimer(recordingSeconds)}</div>
                    {pendingCount > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {pendingCount} chunk{pendingCount > 1 ? "s" : ""} en attente de transcription
                      </div>
                    ) : null}
                  </div>

                  {wavUrl ? (
                    <div className="w-full space-y-2">
                      <div className="text-xs text-muted-foreground text-center">Réécouter l'enregistrement</div>
                      <audio controls className="w-full" src={wavUrl} aria-label="Lecture enregistrement micro" />
                    </div>
                  ) : null}

                  <div className="flex flex-col items-center gap-2 text-sm">
                    <Button onClick={handlePrepareMp3} disabled={isPreparingMp3}>
                      {isPreparingMp3 ? "Préparation du MP3…" : "Préparer MP3"}
                    </Button>
                    {mp3Url ? (
                      <Button variant="outline" asChild>
                        <a href={mp3Url} download="micro-enregistrement.mp3">
                          Télécharger MP3
                        </a>
                      </Button>
                    ) : (
                      <div className="text-xs text-muted-foreground">
                        {isPreparingMp3 ? "Génération en cours…" : "Préparez un MP3 pour le télécharger."}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            </>
          ) : (
            <Card>
              <CardContent className="space-y-4 p-6 text-center">
                {recordingDisabledReason ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="mx-auto inline-block">
                          <Button
                            onClick={handleRecordingToggle}
                            disabled={isStopping || (!isRecording && !noiseCalibrated)}
                            aria-pressed={isRecording}
                            variant={isRecording ? "destructive" : "default"}
                            className="flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-full text-lg shadow-lg transition-transform duration-200 ease-out"
                            style={recordingButtonStyle}
                          >
                            {isRecording ? <Square className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
                            <span>{isRecording ? "Arrêter" : "Démarrer"}</span>
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{recordingDisabledReason}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <Button
                    onClick={handleRecordingToggle}
                    disabled={isStopping || (!isRecording && !noiseCalibrated)}
                    aria-pressed={isRecording}
                    variant={isRecording ? "destructive" : "default"}
                    className="mx-auto flex h-40 w-40 flex-col items-center justify-center gap-2 rounded-full text-lg shadow-lg transition-transform duration-200 ease-out"
                    style={recordingButtonStyle}
                  >
                    {isRecording ? <Square className="h-8 w-8" /> : <Mic className="h-8 w-8" />}
                    <span>{isRecording ? "Arrêter" : "Démarrer"}</span>
                  </Button>
                )}

                <div className="flex justify-center">
                  <Button
                    variant={noiseCalibrated ? "default" : "outline"}
                    onClick={handleCalibrateNoise}
                    disabled={isStopping || isCalibratingNoise}
                    className={
                      noiseCalibrated ? "ring-2 ring-emerald-400 ring-offset-2 ring-offset-background" : undefined
                    }
                  >
                    {isCalibratingNoise ? "Calibration bruit…" : "Initialiser bruit"}
                  </Button>
                </div>

                <div className="space-y-1 text-sm">
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Badge variant={statusMeta.tone === "destructive" ? "destructive" : statusMeta.tone}>
                      {statusMeta.label}
                    </Badge>
                    {backendBadge ? <Badge variant={backendBadge.variant}>{backendBadge.label}</Badge> : null}
                    {activeBackend && activeBackend !== micBackendPreference ? (
                      <Badge variant="outline" className="capitalize">
                        {`Préférence : ${micBackendPreference}`}
                      </Badge>
                    ) : null}
                  </div>
                  {statusDetail ? <div className="text-xs text-muted-foreground">{statusDetail}</div> : null}
                  {isRecording ? (
                    <div className="flex items-center justify-center gap-2 text-red-600">
                      <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                      Enregistrement en cours — {formatTimer(recordingSeconds)}
                    </div>
                  ) : (
                    <div className="text-xs text-muted-foreground">Durée : {formatTimer(recordingSeconds)}</div>
                  )}
                </div>

                {pendingCount > 0 ? (
                  <div className="text-xs text-muted-foreground">
                    {pendingCount} chunk{pendingCount > 1 ? "s" : ""} en attente de transcription
                  </div>
                ) : null}

                {!hasRecording ? <div className="text-xs text-muted-foreground">Enregistrez pour générer un MP3.</div> : null}
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          {segments.length ? (
            <ResultsTable segments={segments} mode="mic" />
          ) : (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                Les segments apparaîtront ici pendant l'enregistrement.
              </CardContent>
            </Card>
          )}

          {canExport ? (
            <ExportButtons
              segments={segments}
              telemetry={telemetrySummary ?? undefined}
              showVtt={micShowExportVtt}
              showSrt={micShowExportSrt}
              showJson={micShowExportJson}
              showTelemetry={micShowExportTelemetry}
              mode="mic"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default MicPage;
