import { useCallback, useState } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { StatusBar } from "@/components/status/StatusBar";
import { ResultsTable } from "@/components/results/ResultsTable";
import { ExportButtons } from "@/components/results/ExportButtons";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MODEL_PRESETS, useAsrStore } from "@/store/asr-store";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { probeAudioMetadata } from "@/lib/audio";
import { toast } from "@/components/ui/use-toast";

function UploadPage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const segments = useAsrStore((state) => state.segments);
  const showSegments = useAsrStore((state) => state.showSegments);
  const telemetrySummary = useAsrStore((state) => state.telemetrySummary);
  const audioMetadata = useAsrStore((state) => state.audioMetadata);
  const registerAudioSource = useAsrStore((state) => state.registerAudioSource);
  const resetSession = useAsrStore((state) => state.resetSession);
  const setStatus = useAsrStore((state) => state.setStatus);
  const activePreset = useAsrStore((state) => state.activePreset);
  const setPreset = useAsrStore((state) => state.setPreset);
  const { startUploadTranscription, stopTranscription, isTranscribing } = useTranscriptionController();

  const handleFileSelected = useCallback(
    (file: File) => {
      setSelectedFile(file);
      resetSession();
      setStatus("idle", "Fichier chargé, prêt à lancer");
      void (async () => {
        try {
          const metadata = await probeAudioMetadata(file);
          const source = { id: crypto.randomUUID(), label: file.name, type: "file" as const };
          registerAudioSource(source, metadata);
        } catch (error) {
          console.error("Impossible de lire les métadonnées audio", error);
          setStatus("error", "Impossible d'analyser le fichier audio");
        }
      })();
    },
    [registerAudioSource, resetSession, setStatus]
  );

  const handleManualStart = useCallback(async () => {
    if (!selectedFile) return;
    try {
      await startUploadTranscription(selectedFile);
    } catch (error) {
      console.error("Erreur lors du démarrage manuel de la transcription", error);
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
              <ResultsTable segments={segments} />
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
