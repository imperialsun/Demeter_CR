import { useCallback } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { StatusBar } from "@/components/status/StatusBar";
import { SegmentationStatusPanel } from "@/components/status/SegmentationStatusPanel";
import { PreprocessingStatusPanel } from "@/components/status/PreprocessingStatusPanel";
import { ResultsTable } from "@/components/results/ResultsTable";
import { ExportButtons } from "@/components/results/ExportButtons";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODEL_PRESETS, useAsrStore } from "@/store/asr-store";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { probeAudioMetadata } from "@/lib/audio";
import { toast } from "@/components/ui/use-toast";
import { Badge } from "@/components/ui/badge";
import { overallConfidenceVariant } from "@/lib/utils";
import logger from "@/lib/logger";

function UploadPage() {
  // Keep the selected file in the global store so pre-listen survives navigation
  const selectedFile = useAsrStore((state) => state.uploadedFile);
  const setUploadedFile = useAsrStore((state) => state.setUploadedFile);
  const segments = useAsrStore((state) => state.segments);
  const showSegments = useAsrStore((state) => state.showSegments);
  const telemetrySummary = useAsrStore((state) => state.telemetrySummary);
  const audioMetadata = useAsrStore((state) => state.audioMetadata);
  const registerAudioSource = useAsrStore((state) => state.registerAudioSource);
  const resetSession = useAsrStore((state) => state.resetSession);
  const setStatus = useAsrStore((state) => state.setStatus);
  const activePreset = useAsrStore((state) => state.activePreset);
  const setPreset = useAsrStore((state) => state.setPreset);
  const preprocessingMode = useAsrStore((state) => state.preprocessingMode);
  const memoryMode = useAsrStore((state) => state.memoryMode);
  // Read transcription confidence unconditionally to respect Hooks rules
  const transcriptionConfidence = useAsrStore((s) => s.transcriptionConfidence);
  const transcriptionConfidenceSource = useAsrStore((s) => s.transcriptionConfidenceSource);
  const { startUploadTranscription, stopTranscription, isTranscribing } = useTranscriptionController();

  const handleFileSelected = useCallback(
    (file: File) => {
      logger.info("handleFileSelected called", { fileName: file?.name });
      // Reset session first, then store the uploaded file to ensure the file remains available
      try {
        resetSession();
        setUploadedFile(file);
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
    [registerAudioSource, resetSession, setStatus, setUploadedFile]
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

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Upload</h2>
        <p className="text-muted-foreground">
          Importez un fichier audio, ajustez Whisper et suivez la transcription chunk par chunk sans quitter Chrome.
        </p>
      </header>

        <div className="space-y-3">
          <div className="grid gap-2">
            <Label>Modèle Whisper</Label>
            <Select value={activePreset} onValueChange={(value) => setPreset(value as typeof activePreset)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choisir un modèle" />
              </SelectTrigger>
              <SelectContent>
                {Object.values(MODEL_PRESETS).map((preset) => (
                  <SelectItem key={preset.key} value={preset.key}>
                    <div className="flex flex-col">
                      <span className="font-medium">{preset.label}</span>
                      <span className="text-xs text-muted-foreground">{preset.description}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <StatusBar
            onStop={stopTranscription}
            onStart={handleManualStart}
            startDisabled={!selectedFile || isTranscribing}
          />
        </div>

      <div className="grid gap-6 xl:grid-cols-[360px,1fr]">
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
          <AudioPlayer file={selectedFile} metadata={audioMetadata} />

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
                <ResultsTable segments={segments} />
              </>
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Les segments apparaîtront ici dès que la transcription aura démarré.
                </CardContent>
              </Card>
            )
          )}
          <ExportButtons segments={segments} telemetry={telemetrySummary ?? undefined} />
        </div>
      </div>
    </div>
  );
}

export default UploadPage;
