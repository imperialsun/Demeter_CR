import { useCallback, useEffect, useState } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { StatusBar } from "@/components/status/StatusBar";
import { SegmentationStatusPanel } from "@/components/status/SegmentationStatusPanel";
import { PreprocessingStatusPanel } from "@/components/status/PreprocessingStatusPanel";
import { ResultsTable } from "@/components/results/ResultsTable";
import { ExportButtons } from "@/components/results/ExportButtons";
import { Card, CardContent } from "@/components/ui/card";
import { ForegroundAlertDialog } from "@/components/ui/ForegroundAlertDialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODEL_PRESETS, useAsrStore } from "@/store/asr-store";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { probeAudioMetadata } from "@/lib/audio";
import { toast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { overallConfidenceVariant } from "@/lib/utils";
import logger from "@/lib/logger";
import { ChevronDown, ChevronUp } from "lucide-react";

function LocalUploadPage() {
  // Keep the selected file in the global store so pre-listen survives navigation
  const selectedFile = useAsrStore((state) => state.uploadedFile);
  const previewUrl = useAsrStore((state) => state.previewUrl);
  const setUploadedFile = useAsrStore((state) => state.setUploadedFile);
  const setPreviewUrl = useAsrStore((state) => state.setPreviewUrl);
  const segments = useAsrStore((state) => state.segments);
  const status = useAsrStore((state) => state.status);
  const showSegments = useAsrStore((state) => state.showSegments);
  const telemetrySummary = useAsrStore((state) => state.telemetrySummary);
  const setTelemetrySummary = useAsrStore((state) => state.setTelemetrySummary);
  const audioMetadata = useAsrStore((state) => state.audioMetadata);
  const registerAudioSource = useAsrStore((state) => state.registerAudioSource);
  const resetSession = useAsrStore((state) => state.resetSession);
  const clearSessionTranscriptMemory = useAsrStore((state) => state.clearSessionTranscriptMemory);
  const setStatus = useAsrStore((state) => state.setStatus);
  const activePreset = useAsrStore((state) => state.activePreset);
  const setPreset = useAsrStore((state) => state.setPreset);
  const blockedPresets = useAsrStore((state) => state.blockedPresets);
  const preprocessingMode = useAsrStore((state) => state.preprocessingMode);
  const memoryMode = useAsrStore((state) => state.memoryMode);
  const telemetry = useAsrStore((state) => state.telemetryCollector);
  const localUploadModelSizeAlert = useAsrStore((state) => state.localUploadModelSizeAlert);
  const clearLocalUploadModelSizeAlert = useAsrStore((state) => state.clearLocalUploadModelSizeAlert);
  // Read transcription confidence unconditionally to respect Hooks rules
  const transcriptionConfidence = useAsrStore((s) => s.transcriptionConfidence);
  const transcriptionConfidenceSource = useAsrStore((s) => s.transcriptionConfidenceSource);
  const { startUploadTranscription, stopTranscription, abortTranscription, isTranscribing } = useTranscriptionController();
  const presetOptions = Object.values(MODEL_PRESETS);
  const blockedPresetSet = new Set(blockedPresets);
  const [privacyNoteOpen, setPrivacyNoteOpen] = useState(false);
  const [isResettingSession, setIsResettingSession] = useState(false);

  useEffect(() => {
    logger.debug("[local-upload][ui] page view", { route: "/localupload", mode: "local" });
    telemetry?.logEvent?.("LOCAL_UPLOAD_PAGE_VIEW", { route: "/localupload", mode: "local" });
  }, [telemetry]);

  const togglePrivacyNote = useCallback(() => {
    setPrivacyNoteOpen((value) => {
      const next = !value;
      logger.debug("[local-upload][ui] privacy note toggled", { open: next });
      telemetry?.logEvent?.("LOCAL_UPLOAD_PRIVACY_NOTE_TOGGLE", { open: next });
      return next;
    });
  }, [telemetry]);

  const handleFileSelected = useCallback(
    (file: File) => {
      logger.debug("[local-upload][ui] file selection received", { fileName: file?.name });
      // Reset session first, then store the uploaded file to ensure the file remains available
      try {
        if (previewUrl) {
          try {
            URL.revokeObjectURL(previewUrl);
          } catch (err) {
            void err;
          }
          setPreviewUrl(null);
        }
        resetSession();
        setUploadedFile(file);
        setPreviewUrl(URL.createObjectURL(file));
        setStatus("idle", "Fichier chargé, prêt à lancer");
      } catch (error) {
        logger.error("Erreur lors de l'initialisation de la session pour le fichier", error);
        return;
      }

      void (async () => {
        try {
          const metadata = await probeAudioMetadata(file);
          const source = { id: crypto.randomUUID(), label: file.name, type: "file" as const };
          registerAudioSource(source, metadata);
        } catch (error) {
          logger.error("Impossible de lire les métadonnées audio", error);
          setStatus("error", "Impossible d'analyser le fichier audio");
        }
      })();
    },
    [previewUrl, registerAudioSource, resetSession, setPreviewUrl, setStatus, setUploadedFile]
  );

  const handleManualStart = useCallback(async () => {
    if (!selectedFile) return;
    try {
      await startUploadTranscription(selectedFile);
    } catch (error) {
      logger.error("Erreur lors du démarrage manuel de la transcription", error);
      toast((error as Error)?.message ?? "Erreur inconnue lors du démarrage de la transcription");
    }
  }, [selectedFile, startUploadTranscription]);

  const handleResetLocalSession = useCallback(async () => {
    if (isResettingSession) return;
    setIsResettingSession(true);
    try {
      if (isTranscribing) {
        abortTranscription({ waitForStop: false });
      }
      if (previewUrl) {
        try {
          URL.revokeObjectURL(previewUrl);
        } catch (err) {
          void err;
        }
      }
      setPreviewUrl(null);
      setUploadedFile(null);
      setTelemetrySummary(null);
      clearSessionTranscriptMemory("upload");
      resetSession();
      setStatus("idle", "Session réinitialisée");
    } catch (error) {
      logger.error("Erreur lors de la réinitialisation de la session locale", error);
      toast((error as Error)?.message ?? "Impossible de réinitialiser la session locale");
    } finally {
      setIsResettingSession(false);
    }
  }, [
    abortTranscription,
    isResettingSession,
    isTranscribing,
    previewUrl,
    clearSessionTranscriptMemory,
    resetSession,
    setPreviewUrl,
    setStatus,
    setTelemetrySummary,
    setUploadedFile,
  ]);

  return (
    <>
      <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Transcription locale</h2>
        <p className="text-muted-foreground">
          Importez un fichier audio, ajustez Whisper et suivez la transcription morceau par morceau sans quitter Chrome.
        </p>
        <p className="text-sm font-medium text-emerald-600">
          Traitement 100% local sur ce poste : aucun fichier audio ni transcription n'est transmis au cloud.
        </p>
        <div className="pt-2">
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-md border bg-muted/20 px-3 py-2 text-sm"
            onClick={togglePrivacyNote}
            aria-expanded={privacyNoteOpen}
          >
            <span className="font-medium">Note de confidentialité</span>
            {privacyNoteOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {privacyNoteOpen ? (
            <div className="mt-3 space-y-2 rounded-md border bg-background/60 px-3 py-3 text-sm text-muted-foreground">
              <p>
                Cette partie fonctionne entièrement dans votre navigateur. Les fichiers audio et les transcriptions
                restent sur ce poste et ne sont jamais envoyés vers un serveur externe.
              </p>
              <p>
                Les seuls accès réseau concernent le téléchargement des modèles Whisper (si absents du cache). Une fois
                chargés, les traitements se font localement en mémoire, ce qui garantit le niveau de confidentialité le
                plus élevé possible.
              </p>
            </div>
          ) : null}
        </div>
      </header>

        <div className="space-y-3">
          <div className="grid gap-2">
            <Label>Modèle Whisper</Label>
            <Select value={activePreset} onValueChange={(value) => setPreset(value as typeof activePreset)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choisir un modèle" />
              </SelectTrigger>
              <SelectContent>
                {presetOptions.map((preset) => {
                  const isBlocked = blockedPresetSet.has(preset.key);
                  return (
                    <SelectItem key={preset.key} value={preset.key} disabled={isBlocked}>
                      <div className="flex flex-col">
                        <span className="font-medium">{preset.label}</span>
                        <span className="text-xs text-muted-foreground">{preset.description}</span>
                        {isBlocked ? (
                          <span className="text-xs text-destructive">Trop lourd pour ce poste (test)</span>
                        ) : null}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <StatusBar
            onStop={stopTranscription}
            onStart={handleManualStart}
            onResetSession={handleResetLocalSession}
            startDisabled={!selectedFile || isTranscribing}
            resetDisabled={isResettingSession}
          />
        </div>

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          {memoryMode === "progressive" ? <SegmentationStatusPanel /> : null}
          {preprocessingMode === "full" ? <PreprocessingStatusPanel /> : null}
          <AudioUploader
            onFileSelected={handleFileSelected}
            metadata={audioMetadata}
            disabled={isTranscribing}
          />
        </div>

        <div className="space-y-4">
          <AudioPlayer file={selectedFile} metadata={audioMetadata} previewUrl={previewUrl} segments={segments} />
          <ExportButtons
            segments={segments}
            telemetry={telemetrySummary ?? undefined}
            showDocx={status === "ready" && segments.length > 0}
          />

          {showSegments && (
            segments.length ? (
              <>
                <div className="flex items-center justify-between">
                  <div />
                  <div className="flex items-center gap-2">
                    <div className="text-sm text-muted-foreground">Indice de confiance globale :</div>
                    <Badge variant={overallConfidenceVariant(transcriptionConfidence)}>{typeof transcriptionConfidence === 'number' ? `${Math.round((transcriptionConfidence ?? 0)*100)}%` : '—'}</Badge>
                    {transcriptionConfidenceSource === 'estimated' ? <span className="text-xs text-muted-foreground ml-2">(estimée)</span> : null}
                  </div>
                </div>
                <ResultsTable segments={segments} mode="upload" />
              </>
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Les segments apparaîtront ici dès que la transcription aura démarré.
                </CardContent>
              </Card>
            )
          )}
        </div>
      </div>
      </div>
      <ForegroundAlertDialog
        open={Boolean(localUploadModelSizeAlert)}
        title={localUploadModelSizeAlert?.title ?? "Alerte modele local"}
        description={localUploadModelSizeAlert?.description ?? ""}
        severity={localUploadModelSizeAlert?.severity ?? "warning"}
        onClose={clearLocalUploadModelSizeAlert}
      />
    </>
  );
}

export default LocalUploadPage;
