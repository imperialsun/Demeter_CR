import { useEffect, useMemo, useState } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { AudioPlayer } from "@/components/audio/AudioPlayer";
import { ResultsTable } from "@/components/results/ResultsTable";
import { ExportButtons } from "@/components/results/ExportButtons";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useAsrStore } from "@/store/asr-store";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import logger from "@/lib/logger";
import { Loader2, PauseCircle, Play, Cloud, ChevronDown, ChevronUp } from "lucide-react";

const CLOUD_HF_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Hugging Face.";
const CLOUD_MISTRAL_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Mistral.";

function CloudUploadPage() {
  const [isContextOpen, setIsContextOpen] = useState(false);
  const [provider, setProvider] = useState<"gradio" | "whisper" | "mistral">("gradio");
  const isWhisper = provider === "whisper";
  const isMistral = provider === "mistral";
  const usesContext = provider === "gradio";
  const telemetry = useAsrStore((state) => state.telemetryCollector);
  const cloudContextPreset = useAsrStore((state) => state.cloudContextPreset);
  const cloudHfToken = useAsrStore((state) => state.cloudHfToken);
  const setCloudHfToken = useAsrStore((state) => state.setCloudHfToken);
  const cloudMistralApiKey = useAsrStore((state) => state.cloudMistralApiKey);
  const setCloudMistralApiKey = useAsrStore((state) => state.setCloudMistralApiKey);
  const cloudShowSegments = useAsrStore((state) => state.cloudShowSegments);
  const cloudShowExportVtt = useAsrStore((state) => state.cloudShowExportVtt);
  const cloudShowExportSrt = useAsrStore((state) => state.cloudShowExportSrt);
  const cloudShowExportJson = useAsrStore((state) => state.cloudShowExportJson);
  const cloudShowExportTelemetry = useAsrStore((state) => state.cloudShowExportTelemetry);
  const cloudEnableWordTimestamps = useAsrStore((state) => state.cloudEnableWordTimestamps);
  const cloudShowSegmentConfidence = useAsrStore((state) => state.cloudShowSegmentConfidence);
  const {
    selectedFile,
    previewFile,
    previewUrl,
    audioMetadata,
    segments,
    telemetrySummary,
    status,
    statusDetail,
    progress,
    isTranscribing,
    stopRequested,
    sessionContext,
    setSessionContext,
    combinedContext,
    handleFileSelected,
    startTranscription,
    stopTranscription,
  } = useCloudTranscription(provider);

  useEffect(() => {
    logger.info("Cloud upload page view", { route: "/cloudupload", mode: "cloud" });
    telemetry?.logEvent?.("CLOUD_UPLOAD_PAGE_VIEW", { route: "/cloudupload", mode: "cloud" });
  }, [telemetry]);

  const statusMeta = useMemo(() => {
    switch (status) {
      case "preprocessing":
        return { label: "Prétraitement", tone: "secondary" as const };
      case "uploading":
        return { label: "Envoi cloud", tone: "secondary" as const };
      case "transcribing":
        return { label: "Transcription", tone: "default" as const };
      case "stopping":
        return { label: "Arrêt en cours", tone: "secondary" as const };
      case "done":
        return { label: "Terminé", tone: "default" as const };
      case "error":
        return { label: "Erreur", tone: "destructive" as const };
      default:
        return { label: "En attente", tone: "secondary" as const };
    }
  }, [status]);
  const isWhisperTokenMissing = isWhisper && cloudHfToken.trim().length === 0;
  const isMistralTokenMissing = isMistral && cloudMistralApiKey.trim().length === 0;
  const percent = Math.round(progress * 100);
  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Transcription cloud</h2>
        <p className="text-muted-foreground">
          Importez un fichier audio, prétraitez-le localement puis lancez la transcription via le service cloud.
        </p>
        <p className="text-sm font-medium text-amber-600">
          L'audio est prétraité localement avant d'être envoyé au cloud pour la transcription.
        </p>
      </header>

      <div className="max-w-sm space-y-2">
        <Label htmlFor="cloud-provider">Provider</Label>
        <Select
          value={provider}
          onValueChange={(value) => {
            const next = value === "whisper" || value === "mistral" ? value : "gradio";
            setProvider(next);
            logger.info("[cloud] provider changed", { provider: next });
            telemetry?.logEvent?.("CLOUD_PROVIDER_CHANGE", { provider: next });
          }}
        >
          <SelectTrigger id="cloud-provider">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="gradio">Gradio</SelectItem>
            <SelectItem value="whisper">Whisper</SelectItem>
            <SelectItem value="mistral">Mistral</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isWhisper || isMistral ? (
        <Card>
          <CardHeader>
            <CardTitle>{isWhisper ? "Token Hugging Face" : "Token API Mistral"}</CardTitle>
            <CardDescription>
              {isWhisper
                ? "Ajoutez votre token HF pour utiliser l'API Whisper."
                : "Ajoutez votre token Mistral pour utiliser le modèle Voxtral."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="cloud-provider-token-session">{isWhisper ? "Token HF" : "Token Mistral"}</Label>
            <Input
              id="cloud-provider-token-session"
              type="password"
              value={isWhisper ? cloudHfToken : cloudMistralApiKey}
              onChange={(event) => {
                if (isWhisper) {
                  setCloudHfToken(event.target.value);
                } else {
                  setCloudMistralApiKey(event.target.value);
                }
              }}
              placeholder={isWhisper ? "hf_..." : "...."}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">
              {isWhisper
                ? "Stocké localement. Aucun token n'est envoyé ailleurs que vers l'API Hugging Face."
                : "Stocké localement. Aucun token n'est envoyé ailleurs que vers l'API Mistral."}
            </p>
            {isWhisperTokenMissing ? (
              <p className="text-xs text-destructive">{CLOUD_HF_TOKEN_REQUIRED_MESSAGE}</p>
            ) : null}
            {isMistralTokenMissing ? (
              <p className="text-xs text-destructive">{CLOUD_MISTRAL_TOKEN_REQUIRED_MESSAGE}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {usesContext ? (
        <Card>
          <CardHeader>
            <CardTitle>Contexte</CardTitle>
            <CardDescription>Ajoutez des termes importants pour améliorer la reconnaissance.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <button
              type="button"
              className="flex w-full items-center justify-between rounded-md border bg-muted/10 px-3 py-2 text-sm"
              onClick={() => setIsContextOpen((value) => !value)}
              aria-expanded={isContextOpen}
            >
              <span className="font-medium">
                {isContextOpen ? "Masquer le contexte" : "Afficher le contexte"}
              </span>
              {isContextOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </button>
            {isContextOpen ? (
              <>
                <Label htmlFor="cloud-context-session">Contexte de session (prioritaire)</Label>
                <Textarea
                  id="cloud-context-session"
                  rows={4}
                  value={sessionContext}
                  onChange={(event) => setSessionContext(event.target.value)}
                  placeholder="Noms propres, jargon, acronymes..."
                />
                <div className="text-xs text-muted-foreground">
                  Prérempli depuis les réglages: {cloudContextPreset?.trim() ? cloudContextPreset : "—"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Contexte envoyé: {combinedContext?.trim() ? "Personnalisé" : "Aucun"}
                </div>
              </>
            ) : (
              <div className="text-xs text-muted-foreground">
                Contexte {combinedContext?.trim() ? "prêt à être envoyé" : "vide"}.
              </div>
            )}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[360px,1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Statut transcription</CardTitle>
              <CardDescription>Suivez les étapes de la transcription cloud.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <Badge variant={statusMeta.tone === "destructive" ? "destructive" : statusMeta.tone}>
                  {statusMeta.label}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <Cloud className="h-3 w-3" /> {isWhisper ? "Whisper" : isMistral ? "Mistral" : "Gradio"}
                </Badge>
                {statusDetail ? <span className="text-sm text-muted-foreground">{statusDetail}</span> : null}
              </div>
              <Progress value={percent} className="h-2 w-full" />
              <p className="text-xs text-muted-foreground">{percent}%</p>
              <div className="flex items-center gap-3">
                {!isTranscribing ? (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={startTranscription}
                    disabled={!selectedFile}
                  >
                    <Play className="h-4 w-4" />
                    Lancer la transcription
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={stopTranscription}
                    disabled={stopRequested}
                  >
                    {stopRequested ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
                    {stopRequested ? "Arrêt en cours…" : "Stop"}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <AudioUploader
            onFileSelected={handleFileSelected}
            metadata={audioMetadata}
            disabled={isTranscribing}
            description="Glissez-déposez un fichier audio. Il est prétraité localement puis envoyé au cloud."
          />
        </div>

        <div className="space-y-4">
          <AudioPlayer file={previewFile} metadata={audioMetadata} previewUrl={previewUrl} segments={segments} />

          {cloudShowSegments ? (
            segments.length ? (
              <ResultsTable
                segments={segments}
                enableWordTimestamps={cloudEnableWordTimestamps}
                showSegmentConfidence={cloudShowSegmentConfidence}
              />
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Les segments apparaîtront ici dès que la transcription aura démarré.
                </CardContent>
              </Card>
            )
          ) : null}

          <ExportButtons
            segments={segments}
            telemetry={telemetrySummary ?? undefined}
            showVtt={cloudShowExportVtt}
            showSrt={cloudShowExportSrt}
            showJson={cloudShowExportJson}
            showTelemetry={cloudShowExportTelemetry}
            mode="cloud"
          />
        </div>
      </div>
    </div>
  );
}

export default CloudUploadPage;
