import { useEffect, useMemo, useState } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { ExportButtons } from "@/components/results/ExportButtons";
import { CloudChunkCard } from "@/components/results/CloudChunkCard";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAsrStore } from "@/store/asr-store";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import { canUseCloudProvider } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { SESSION_ONLY_SECRET_NOTICE } from "@/lib/secret-storage-copy";
import { Loader2, PauseCircle, Play, Cloud } from "lucide-react";
import { isBackendMode } from "@/lib/runtime-config";
import { groupCloudTranscriptionSegments } from "@/lib/cloud/transcriptionChunks";

const CLOUD_HF_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Hugging Face.";
const CLOUD_MISTRAL_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Mistral.";
const CLOUD_PROVIDER_FORBIDDEN_MESSAGE = "Accès refusé par vos permissions backend.";

type CloudProviderId = "whisper" | "mistral" | "demeter_sante";

function formatMebibytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function CloudUploadPage() {
  useBackendPermissions();
  const backendMode = isBackendMode();
  const canUseWhisper = canUseCloudProvider("whisper");
  const canUseMistral = canUseCloudProvider("mistral");
  const canUseDemeter = canUseCloudProvider("demeter_sante");
  const allowedProviders = useMemo<CloudProviderId[]>(() => {
    const providers: CloudProviderId[] = [];
    if (canUseWhisper) providers.push("whisper");
    if (canUseMistral) providers.push("mistral");
    if (backendMode && canUseDemeter) providers.push("demeter_sante");
    return providers;
  }, [backendMode, canUseDemeter, canUseMistral, canUseWhisper]);
  const preferredProvider: CloudProviderId =
    backendMode && canUseDemeter ? "demeter_sante" : allowedProviders[0] ?? "whisper";
  const [selectedProvider, setSelectedProvider] = useState<CloudProviderId>(preferredProvider);
  const hasAllowedProvider = allowedProviders.length > 0;
  const isCurrentProviderAllowed = allowedProviders.includes(selectedProvider);
  const providerSelectValue = isCurrentProviderAllowed ? selectedProvider : "__unauthorized__";
  const activeProvider = isCurrentProviderAllowed ? selectedProvider : null;
  const provider: CloudProviderId = selectedProvider;
  const isWhisper = activeProvider === "whisper";
  const isMistral = activeProvider === "mistral";
  const isDemeter = activeProvider === "demeter_sante";
  const telemetry = useAsrStore((state) => state.telemetryCollector);
  const hfApiToken = useAsrStore((state) => state.hfApiToken);
  const setHfApiToken = useAsrStore((state) => state.setHfApiToken);
  const mistralApiKey = useAsrStore((state) => state.mistralApiKey);
  const setMistralApiKey = useAsrStore((state) => state.setMistralApiKey);
  const cloudMistralDiarizationEnabled = useAsrStore((state) => state.cloudMistralDiarizationEnabled);
  const setCloudMistralDiarizationEnabled = useAsrStore((state) => state.setCloudMistralDiarizationEnabled);
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
    preparedUpload,
    isTranscribing,
    isResettingSession,
    stopRequested,
    handleFileSelected,
    startTranscription,
    stopTranscription,
    resetTranscriptionSession,
    updateSegmentText,
  } = useCloudTranscription(provider);

  useEffect(() => {
    logger.debug("[cloud][ui] page view", { route: "/cloudupload", mode: "cloud" });
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
  const isWhisperTokenMissing = isWhisper && hfApiToken.trim().length === 0;
  const isMistralTokenMissing = isMistral && mistralApiKey.trim().length === 0;
  const canStartTranscription = hasAllowedProvider && isCurrentProviderAllowed && !isWhisperTokenMissing && !isMistralTokenMissing;
  const percent = Math.round(progress * 100);
  const chunkGroups = useMemo(() => groupCloudTranscriptionSegments(segments), [segments]);
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

      {hasAllowedProvider ? (
        <div className="max-w-sm space-y-2">
          <Label htmlFor="cloud-provider">Provider</Label>
          <Select
            value={providerSelectValue}
            onValueChange={(value) => {
              if (value === "__unauthorized__") return;
              const next: CloudProviderId =
                value === "whisper" || value === "mistral" || value === "demeter_sante" ? value : "whisper";
              if (!canUseCloudProvider(next)) {
                return;
              }
              setSelectedProvider(next);
              logger.info("[cloud] provider changed", { provider: next });
              telemetry?.logEvent?.("CLOUD_PROVIDER_CHANGE", { provider: next });
            }}
          >
            <SelectTrigger id="cloud-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {!isCurrentProviderAllowed ? (
                <SelectItem value="__unauthorized__" disabled>
                  Sélectionnez un provider autorisé
                </SelectItem>
              ) : null}
              {canUseWhisper ? <SelectItem value="whisper">Whisper</SelectItem> : null}
              {canUseMistral ? <SelectItem value="mistral">Mistral</SelectItem> : null}
              {backendMode && canUseDemeter ? <SelectItem value="demeter_sante">Demeter Santé</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <div className="max-w-sm rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          Aucun provider cloud n'est autorisé par le backend.
        </div>
      )}

      {!isCurrentProviderAllowed && hasAllowedProvider ? (
        <div className="max-w-sm rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive">
          {CLOUD_PROVIDER_FORBIDDEN_MESSAGE}
        </div>
      ) : null}

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
              value={isWhisper ? hfApiToken : mistralApiKey}
              onChange={(event) => {
                if (isWhisper) {
                  setHfApiToken(event.target.value);
                } else {
                  setMistralApiKey(event.target.value);
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
            <p className="text-xs text-muted-foreground">{SESSION_ONLY_SECRET_NOTICE}</p>
            {isMistral ? (
              <div className="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Diarization</p>
                  <p className="text-xs text-muted-foreground">
                    Identifie les intervenants (speaker labels) dans la transcription Mistral.
                  </p>
                </div>
                <Switch
                  aria-label="Diarization"
                  className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                  checked={cloudMistralDiarizationEnabled}
                  onCheckedChange={(checked) => {
                    setCloudMistralDiarizationEnabled(checked);
                    logger.info("[cloud][ui] mistral diarization toggled", { enabled: checked });
                  }}
                />
              </div>
            ) : null}
            {isWhisperTokenMissing ? (
              <p className="text-xs text-destructive">{CLOUD_HF_TOKEN_REQUIRED_MESSAGE}</p>
            ) : null}
            {isMistralTokenMissing ? (
              <p className="text-xs text-destructive">{CLOUD_MISTRAL_TOKEN_REQUIRED_MESSAGE}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Statut transcription</CardTitle>
              <CardDescription>Suivez les étapes de la transcription cloud.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-start gap-2">
                <Badge variant={statusMeta.tone === "destructive" ? "destructive" : statusMeta.tone}>
                  {statusMeta.label}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <Cloud className="h-3 w-3" />{" "}
                  {isWhisper
                    ? "Whisper"
                    : isMistral
                      ? "Mistral"
                      : isDemeter
                        ? "Demeter Santé"
                        : "Provider non autorisé"}
                </Badge>
                {statusDetail ? <span className="min-w-0 break-words text-sm text-muted-foreground">{statusDetail}</span> : null}
              </div>
              <Progress value={percent} className="h-2 w-full" />
              <p className="text-xs text-muted-foreground">{percent}%</p>
              {preparedUpload ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Dernier fichier préparé avant envoi</p>
                  <p>
                    {preparedUpload.provider === "demeter_sante"
                      ? "Demeter Santé"
                      : preparedUpload.provider === "mistral"
                        ? "Mistral"
                        : "Whisper"}
                    {` · chunk ${preparedUpload.chunkIndex}/${preparedUpload.totalChunks}`}
                  </p>
                  <p className="min-w-0 break-all text-foreground [overflow-wrap:anywhere]">{preparedUpload.fileName}</p>
                  <p className="min-w-0 break-all [overflow-wrap:anywhere]">
                    {formatMebibytes(preparedUpload.sizeBytes)} · {preparedUpload.sizeBytes} octets
                  </p>
                </div>
              ) : null}
              {!hasAllowedProvider ? (
                <p className="text-xs text-muted-foreground">
                  Cette fonctionnalité cloud est désactivée pour votre compte backend.
                </p>
              ) : null}
              {hasAllowedProvider && !isCurrentProviderAllowed ? (
                <p className="text-xs text-destructive">{CLOUD_PROVIDER_FORBIDDEN_MESSAGE}</p>
              ) : null}
              <div className="flex flex-wrap items-stretch gap-2">
                {!isTranscribing ? (
                  <Button
                    size="sm"
                    className="w-full gap-2 sm:w-auto"
                    onClick={startTranscription}
                    disabled={!selectedFile || isResettingSession || !canStartTranscription}
                  >
                    <Play className="h-4 w-4" />
                    Lancer la transcription
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full gap-2 sm:w-auto"
                    onClick={stopTranscription}
                    disabled={stopRequested || isResettingSession}
                  >
                    {stopRequested ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
                    {stopRequested ? "Arrêt en cours…" : "Stop"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full gap-2 border-border bg-background/60 sm:w-auto"
                  onClick={() => {
                    void resetTranscriptionSession();
                  }}
                  disabled={isResettingSession}
                >
                  {isResettingSession ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {isResettingSession ? "Réinitialisation..." : "Réinitialiser la session"}
                </Button>
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
          <ExportButtons
            segments={segments}
            telemetry={telemetrySummary ?? undefined}
            showVtt={cloudShowExportVtt}
            showSrt={cloudShowExportSrt}
            showJson={cloudShowExportJson}
            showTelemetry={cloudShowExportTelemetry}
            mode="cloud"
          />

          {cloudShowSegments ? (
            chunkGroups.length ? (
              <div className="space-y-4">
                {chunkGroups.map((chunk) => (
                  <CloudChunkCard
                    key={chunk.chunkId}
                    chunk={chunk}
                    file={previewFile}
                    previewUrl={previewUrl}
                    metadata={audioMetadata}
                    enableWordTimestamps={cloudEnableWordTimestamps}
                    showSegmentConfidence={cloudShowSegmentConfidence}
                    onSegmentTextChange={updateSegmentText}
                    segmentEditingDisabled={isResettingSession || isTranscribing}
                  />
                ))}
              </div>
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Les morceaux apparaîtront ici dès que la transcription aura démarré.
                </CardContent>
              </Card>
            )
          ) : null}

        </div>
      </div>
    </div>
  );
}

export default CloudUploadPage;
