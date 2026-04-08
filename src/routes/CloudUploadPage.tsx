import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioUploader } from "@/components/audio/AudioUploader";
import { ExportButtons } from "@/components/results/ExportButtons";
import { CloudChunkCard } from "@/components/results/CloudChunkCard";
import { CloudChunkDetailsPanel } from "@/components/results/CloudChunkDetailsPanel";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { usePageScrollContainer } from "@/components/layout/page-scroll-container";
import { useAsrStore } from "@/store/asr-store";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import { useVirtualizedList } from "@/hooks/useVirtualizedList";
import { canUseCloudProvider } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { SESSION_ONLY_SECRET_NOTICE } from "@/lib/secret-storage-copy";
import { AlertTriangle, Loader2, PauseCircle, Play, Cloud } from "lucide-react";
import { isBackendMode } from "@/lib/runtime-config";

const CLOUD_HF_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Hugging Face.";
const CLOUD_MISTRAL_TOKEN_REQUIRED_MESSAGE = "Ce module ne peut pas fonctionner sans cle API Mistral.";
const CLOUD_PROVIDER_FORBIDDEN_MESSAGE = "Accès refusé par vos permissions backend.";

type CloudProviderId = "whisper" | "mistral" | "demeter_sante";

function formatMebibytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function readBrowserMemorySnapshot() {
  if (typeof performance === "undefined" || !("memory" in performance)) {
    return null;
  }
  const { memory } = performance as unknown as {
    memory: { usedJSHeapSize: number; totalJSHeapSize: number };
  };
  return {
    usedJSHeapSizeMb: Math.round(memory.usedJSHeapSize / (1024 * 1024)),
    totalJSHeapSizeMb: Math.round(memory.totalJSHeapSize / (1024 * 1024)),
  };
}

function CloudUploadPage() {
  useBackendPermissions();
  const pageScrollContainerRef = usePageScrollContainer();
  const backendMode = isBackendMode();
  const canUseWhisper = canUseCloudProvider("whisper");
  const canUseMistral = canUseCloudProvider("mistral");
  const canUseDemeter = canUseCloudProvider("demeter_sante");
  const shouldUsePageScroll = Boolean(pageScrollContainerRef);
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
    previewUrl,
    audioMetadata,
    chunkSummaries,
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
    loadChunkSegments,
    loadAllSegmentsForExport,
    updateSegmentText,
    updateSegmentSpeaker,
    applyChunkSpeakerAssignments,
  } = useCloudTranscription(provider);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [autoPlayRequest, setAutoPlayRequest] = useState<{ chunkId: string; requestId: number } | null>(null);
  const autoPlayRequestCounterRef = useRef(0);
  const initialProviderRef = useRef(provider);
  const hasRecordedResultsSnapshotRef = useRef(false);
  const lastOpenedChunkIdRef = useRef<string | null>(null);

  useEffect(() => {
    logger.debug("[cloud][ui] page view", {
      route: "/cloudupload",
      mode: "cloud",
      provider: initialProviderRef.current,
    });
    telemetry?.logEvent?.("CLOUD_UPLOAD_PAGE_VIEW", { route: "/cloudupload", mode: "cloud" });
  }, [telemetry]);

  const totalSegmentCount = useMemo(
    () => chunkSummaries.reduce((count, chunk) => count + chunk.segmentCount, 0),
    [chunkSummaries]
  );
  const activeChunk = useMemo(
    () => chunkSummaries.find((chunk) => chunk.chunkId === activeChunkId) ?? null,
    [activeChunkId, chunkSummaries]
  );
  const activeChunkAutoPlayRequestId =
    activeChunk && autoPlayRequest?.chunkId === activeChunk.chunkId ? autoPlayRequest.requestId : null;

  const {
    parentRef: chunkListRef,
    virtualItems: chunkVirtualItems,
    totalSize: chunkVirtualTotalSize,
    scrollMargin: chunkScrollMargin,
    measureElement: measureChunkElement,
  } = useVirtualizedList({
    items: chunkSummaries,
    estimateSize: () => 196,
    getItemKey: (chunk) => chunk.chunkId,
    overscan: 2,
    fallbackHeight: 640,
    scrollElementRef: shouldUsePageScroll ? pageScrollContainerRef ?? undefined : undefined,
  });

  const handleOpenChunk = useCallback((chunkId: string) => {
    setActiveChunkId(chunkId);
    setAutoPlayRequest(null);
  }, []);

  const handlePlayChunk = useCallback((chunkId: string) => {
    autoPlayRequestCounterRef.current += 1;
    setActiveChunkId(chunkId);
    setAutoPlayRequest({ chunkId, requestId: autoPlayRequestCounterRef.current });
  }, []);

  const handleCloseChunk = useCallback(() => {
    setActiveChunkId(null);
    setAutoPlayRequest(null);
  }, []);

  const handleAutoPlayRequestConsumed = useCallback(() => {
    setAutoPlayRequest(null);
  }, []);

  useEffect(() => {
    if (!cloudShowSegments) {
      setActiveChunkId(null);
      setAutoPlayRequest(null);
    }
  }, [cloudShowSegments]);

  useEffect(() => {
    if (!chunkSummaries.length) {
      if (activeChunkId !== null) {
        setActiveChunkId(null);
      }
      setAutoPlayRequest(null);
      hasRecordedResultsSnapshotRef.current = false;
      lastOpenedChunkIdRef.current = null;
      return;
    }

    if (activeChunkId && !chunkSummaries.some((chunk) => chunk.chunkId === activeChunkId)) {
      setActiveChunkId(null);
      setAutoPlayRequest(null);
    }
  }, [activeChunkId, chunkSummaries]);

  useEffect(() => {
    if (!chunkSummaries.length) {
      hasRecordedResultsSnapshotRef.current = false;
      return;
    }
    if (!hasRecordedResultsSnapshotRef.current) {
      hasRecordedResultsSnapshotRef.current = true;
      const memorySnapshot = readBrowserMemorySnapshot();
      logger.info("[cloud][ui] results rendered", {
        route: "/cloudupload",
        provider,
        chunkCount: chunkSummaries.length,
        segmentCount: totalSegmentCount,
        memorySnapshot,
      });
      telemetry?.snapshotMemory?.("CLOUD_RESULTS_RENDERED");
      telemetry?.logEvent?.("RAM_USAGE", {
        context: "cloud_results_rendered",
        chunkCount: chunkSummaries.length,
        segmentCount: totalSegmentCount,
        memorySnapshot,
      });
    }
  }, [chunkSummaries.length, provider, telemetry, totalSegmentCount]);

  useEffect(() => {
    if (!activeChunk) {
      if (lastOpenedChunkIdRef.current) {
        const memorySnapshot = readBrowserMemorySnapshot();
        logger.info("[cloud][ui] chunk detail closed", {
          route: "/cloudupload",
          chunkId: lastOpenedChunkIdRef.current,
          memorySnapshot,
        });
        telemetry?.snapshotMemory?.(`CLOUD_CHUNK_CLOSE_${lastOpenedChunkIdRef.current}`);
        telemetry?.logEvent?.("RAM_USAGE", {
          context: "cloud_chunk_close",
          chunkId: lastOpenedChunkIdRef.current,
          chunkCount: chunkSummaries.length,
          memorySnapshot,
        });
        lastOpenedChunkIdRef.current = null;
      }
      return;
    }

    if (lastOpenedChunkIdRef.current === activeChunk.chunkId) {
      return;
    }

    if (lastOpenedChunkIdRef.current) {
      const memorySnapshot = readBrowserMemorySnapshot();
      logger.info("[cloud][ui] chunk detail closed", {
        route: "/cloudupload",
        chunkId: lastOpenedChunkIdRef.current,
        memorySnapshot,
      });
      telemetry?.snapshotMemory?.(`CLOUD_CHUNK_CLOSE_${lastOpenedChunkIdRef.current}`);
      telemetry?.logEvent?.("RAM_USAGE", {
        context: "cloud_chunk_close",
        chunkId: lastOpenedChunkIdRef.current,
        chunkCount: chunkSummaries.length,
        memorySnapshot,
      });
    }

    lastOpenedChunkIdRef.current = activeChunk.chunkId;
    const memorySnapshot = readBrowserMemorySnapshot();
    logger.info("[cloud][ui] chunk detail opened", {
      route: "/cloudupload",
      chunkId: activeChunk.chunkId,
      chunkCount: chunkSummaries.length,
      segmentCount: activeChunk.segmentCount,
      wordTimestampsEnabled: cloudEnableWordTimestamps,
      showSegmentConfidence: cloudShowSegmentConfidence,
      memorySnapshot,
    });
    telemetry?.snapshotMemory?.(`CLOUD_CHUNK_OPEN_${activeChunk.chunkId}`);
    telemetry?.logEvent?.("RAM_USAGE", {
      context: "cloud_chunk_open",
      chunkId: activeChunk.chunkId,
      chunkCount: chunkSummaries.length,
      segmentCount: activeChunk.segmentCount,
      memorySnapshot,
    });
  }, [
    activeChunk,
    chunkSummaries.length,
    cloudEnableWordTimestamps,
    cloudShowSegmentConfidence,
    telemetry,
  ]);

  useEffect(() => {
    if (status !== "preprocessing") {
      return;
    }
    setActiveChunkId(null);
    setAutoPlayRequest(null);
    hasRecordedResultsSnapshotRef.current = false;
    lastOpenedChunkIdRef.current = null;
  }, [status]);

  const statusMeta = useMemo(() => {
    switch (status) {
      case "preprocessing":
        return { label: "Préparation", tone: "secondary" as const };
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
  const canStartTranscription =
    hasAllowedProvider && isCurrentProviderAllowed && !isWhisperTokenMissing && !isMistralTokenMissing;
  const percent = Math.round(progress * 100);
  const showLocalPreparationWarning = status === "preprocessing";

  return (
    <div className="space-y-8">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Transcription cloud</h2>
        <p className="text-muted-foreground">
          Importez un fichier audio, choisissez un mode basse RAM ou un traitement complet, puis lancez la transcription via le service cloud.
        </p>
        <p className="text-sm font-medium text-amber-600">
          Les fichiers courts préparent les segments localement avant l'envoi. Au-delà de 2 heures, le backend prend directement le relais sans prétraitement local.
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
              {showLocalPreparationWarning ? (
                <div className="rounded-xl border border-amber-500/70 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 shadow-sm dark:text-amber-100">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                    <div className="space-y-1">
                      <p className="font-semibold">Traitement local en cours</p>
                      <p className="leading-snug">
                        Gardez cet onglet ouvert jusqu'à la fin pour éviter toute interruption.
                      </p>
                      <p className="text-xs leading-snug text-amber-800/90 dark:text-amber-200/90">
                        Chrome peut ralentir les tâches en arrière-plan.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
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
            description="Glissez-déposez un fichier audio. Rapide réduit la RAM en envoyant le segment quasi brut ; Complet prétraite localement avant l'envoi. Au-delà de 2 heures, l'envoi passe directement par le backend."
          />
        </div>

        <div className="space-y-4">
          <ExportButtons
            segmentCount={totalSegmentCount}
            loadSegments={loadAllSegmentsForExport}
            telemetry={telemetrySummary ?? undefined}
            showVtt={cloudShowExportVtt}
            showSrt={cloudShowExportSrt}
            showJson={cloudShowExportJson}
            showTelemetry={cloudShowExportTelemetry}
            showDocx={status === "done" && totalSegmentCount > 0}
            mode="cloud"
          />

          {cloudShowSegments ? (
            chunkSummaries.length ? (
              <div
                ref={chunkListRef}
                data-testid="cloud-chunk-list"
                className={shouldUsePageScroll ? undefined : "h-[min(72vh,48rem)] overflow-auto"}
              >
                <div className="relative min-w-full" style={{ height: chunkVirtualTotalSize }}>
                  {chunkVirtualItems.map((virtualRow) => {
                    const chunk = chunkSummaries[virtualRow.index];
                    if (!chunk) {
                      return null;
                    }
                    const isActive = activeChunkId === chunk.chunkId;
                    return (
                      <div
                        key={chunk.chunkId}
                        ref={measureChunkElement}
                        data-index={virtualRow.index}
                        className="absolute left-0 top-0 w-full px-4 py-4"
                        style={{ transform: `translateY(${virtualRow.start - chunkScrollMargin}px)` }}
                      >
                        <CloudChunkCard chunk={chunk} isActive={isActive} onOpen={handleOpenChunk} onPlay={handlePlayChunk} />
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <Card>
                <CardContent className="py-10 text-center text-sm text-muted-foreground">
                  Les morceaux apparaîtront ici dès que la transcription aura démarré. Un seul lecteur et un seul
                  panneau détaillé sont montés à la fois pour limiter la mémoire.
                </CardContent>
              </Card>
            )
          ) : null}
        </div>
      </div>

      {activeChunk ? (
        <CloudChunkDetailsPanel
          key={activeChunk.chunkId}
          chunk={activeChunk}
          loadChunkSegments={loadChunkSegments}
          file={selectedFile}
          previewUrl={previewUrl}
          metadata={audioMetadata}
          enableWordTimestamps={cloudEnableWordTimestamps}
          showSegmentConfidence={cloudShowSegmentConfidence}
          segmentEditingDisabled={isResettingSession || isTranscribing}
          autoPlayRequestId={activeChunkAutoPlayRequestId}
          onAutoPlayRequestConsumed={handleAutoPlayRequestConsumed}
          onSegmentTextChange={(segmentIndex, text) => {
            void updateSegmentText(activeChunk.chunkId, segmentIndex, text);
          }}
          onSegmentSpeakerChange={(segmentIndex, speakerId) => {
            void updateSegmentSpeaker(activeChunk.chunkId, segmentIndex, speakerId);
          }}
          onSpeakerAssignmentsApplied={(assignments) => {
            void applyChunkSpeakerAssignments(activeChunk.chunkId, assignments);
          }}
          onClose={handleCloseChunk}
        />
      ) : null}
    </div>
  );
}

export default CloudUploadPage;
