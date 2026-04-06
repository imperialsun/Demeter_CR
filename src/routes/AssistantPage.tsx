import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AudioUploader } from "@/components/audio/AudioUploader";
import { CloudChunkCard } from "@/components/results/CloudChunkCard";
import { CloudChunkDetailsPanel } from "@/components/results/CloudChunkDetailsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { usePageScrollContainer } from "@/components/layout/page-scroll-container";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import { useLlmReports } from "@/hooks/useLlmReports";
import { useVirtualizedList } from "@/hooks/useVirtualizedList";
import { getCloudStatusMeta } from "@/lib/cloudStatusMeta";
import { buildTranscriptDocx, downloadDocxBlob, formatTranscriptDocxFilename } from "@/lib/docx/transcriptDocx";
import { isBackendMode } from "@/lib/runtime-config";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import { useAsrStore } from "@/store/asr-store";
import logger from "@/lib/logger";
import { cn } from "@/lib/utils";
import { Cloud, Download, FileAudio2, Info, Loader2, RotateCcw, Sparkles, WandSparkles } from "lucide-react";

export const ASSISTANT_JOKES = [
  "Les bits font une pause café, mais le pipeline reste appliqué.",
  "Le cloud relit ses notes. Les algorithmes aiment la relecture.",
  "Demeter aligne les octets avec un calme presque zen.",
  "Petit moment de calcul. Même les serveurs ont besoin d'une respiration.",
  "Les chunks prennent leurs marques. L'ordinateur garde le rythme.",
  "Le code travaille en silence, comme un bon radiologue du clavier.",
  "La machine ne dort pas, elle médite en binaire.",
  "Chaque segment cherche sa place, comme un dossier bien nommé.",
  "Les octets font la queue, très polis aujourd'hui.",
  "La transcription prend son temps, elle veut bien faire les choses.",
  "Le modèle ajuste sa cravate invisible.",
  "Le cloud a lu le manuel. Il hésite encore sur la page 42.",
  "On laisse les neurones numériques faire leur footing.",
  "Même les logs prennent un peu de hauteur.",
  "Les chunks se répartissent sans se marcher sur les pieds.",
  "Le serveur a dit \"encore un instant\" et il le pensait sincèrement.",
  "Les pointillés font semblant d'être mystérieux.",
  "Quand le pipeline respire, tout le monde respire.",
  "C'est le calme avant le verdict des rapports.",
  "Les mots attendent leur tour, très disciplinés.",
  "Le GPU sieste, le CPU raconte une blague.",
  "Un octet heureux vaut mieux que deux qui paniquent.",
  "Demeter vérifie ses lacets avant de courir.",
  "La file d'attente est parfaitement rangée, presque trop.",
  "La transcription aime les petits pas.",
  "Les chunks se coordonnent comme une équipe qui s'entend bien.",
  "Le cloud range ses dossiers par humeur.",
  "Chaque segment est traité avec respect et un peu de suspense.",
  "Ici, le bruit devient du texte, lentement mais sûrement.",
  "Les serveurs aiment les missions claires.",
  "Une blague par minute, un chunk à la fois.",
  "Le modèle ne fait pas grève, il affine.",
  "La magie n'est que de l'ordonnancement bien coiffé.",
  "Les données ont demandé un café, on a dit oui.",
  "Le pipeline ne panique jamais, il itère.",
  "Les fenêtres temporelles restent alignées, par principe.",
  "Les paquets de données prennent le train sans retard.",
  "Le moteur cloud tourne en sourdine, mais il a du style.",
  "On laisse l'algo dérouler son tapis rouge.",
  "La latence porte une petite écharpe.",
  "Le texte arrive en bottes de pluie, prêt pour le brouillard.",
  "Les timestamps sont à l'heure, pour une fois.",
  "Le moteur prépare la suite comme un chef de rang.",
  "Les segments se répartissent en silence religieux.",
  "Le modèle pense, donc il chunk.",
  "Le pipeline sait attendre sans s'impatienter.",
  "Les octets sont en file, mais la file est élégante.",
  "La machine a trouvé son tempo.",
  "Le cloud a pris sa décision, puis a vérifié deux fois.",
  "On transforme du son en sens, ce qui demande un peu de patience.",
  "Les rapports se préparent, la scène est presque prête.",
  "Le flux avance à pas feutrés.",
  "Même les métadonnées gardent le sourire.",
  "Les chunks font leur entrée, chacun à sa mesure.",
  "Le moteur ne fait pas de bruit, il fait le boulot.",
  "Les labels sont en répétition générale.",
  "L'horloge du pipeline avance sans se presser.",
  "Les segments prennent l'ascenseur, pas l'escalier.",
  "Le cloud garde le fil, même quand la nuit tombe.",
  "La fin approche, et elle a l'air plutôt organisée.",
];

export function buildRandomJokeOrder(length: number, rng: () => number = Math.random) {
  const order = Array.from({ length }, (_, index) => index);

  for (let index = order.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [order[index], order[swapIndex]] = [order[swapIndex]!, order[index]!];
  }

  return order;
}

const REPORT_FORMATS = [
  { key: "cri" as const, label: "CRI" },
  { key: "cro" as const, label: "CRO" },
  { key: "crs" as const, label: "CRS" },
];

function AssistantPage() {
  useBackendPermissions();
  const pageScrollContainerRef = usePageScrollContainer();

  const llmApiProvider = useAsrStore((state) => state.llmApiProvider);
  const setLlmApiProvider = useAsrStore((state) => state.setLlmApiProvider);
  const cloudDemeterDiarizationEnabled = useAsrStore((state) => state.cloudDemeterDiarizationEnabled);
  const setCloudDemeterDiarizationEnabled = useAsrStore((state) => state.setCloudDemeterDiarizationEnabled);
  const cloudEnableWordTimestamps = useAsrStore((state) => state.cloudEnableWordTimestamps);
  const cloudShowSegmentConfidence = useAsrStore((state) => state.cloudShowSegmentConfidence);
  const resetLlmApiSession = useAsrStore((state) => state.resetLlmApiSession);
  const llmApiStatusDetail = useAsrStore((state) => state.llmApiStatusDetail);

  const originalProviderRef = useRef(llmApiProvider);
  const originalDiarizationRef = useRef(cloudDemeterDiarizationEnabled);

  const {
    selectedFile,
    previewUrl,
    audioMetadata,
    chunkSummaries,
    status: cloudStatus,
    statusDetail: cloudStatusDetail,
    progress: cloudProgress,
    isTranscribing,
    isResettingSession,
    handleFileSelected: handleCloudFileSelected,
    startTranscription,
    resetTranscriptionSession,
    loadChunkSegments,
    loadAllSegmentsForExport,
    updateSegmentText,
    updateSegmentSpeaker,
  } = useCloudTranscription("demeter_sante", { forceDemeterBackendDirect: true });

  const {
    status: llmStatus,
    progress: llmProgress,
    results,
    generateAll,
    downloadDocx,
  } = useLlmReports();

  const [diarizationChoice, setDiarizationChoice] = useState<boolean | null>(null);
  const [activeChunkId, setActiveChunkId] = useState<string | null>(null);
  const [autoPlayRequest, setAutoPlayRequest] = useState<{ chunkId: string; requestId: number } | null>(null);
  const [waitingJokeOrder, setWaitingJokeOrder] = useState<number[]>([]);
  const [waitingJokeIndex, setWaitingJokeIndex] = useState(0);
  const [isResettingWorkflow, setIsResettingWorkflow] = useState(false);
  const [isTranscriptExporting, setIsTranscriptExporting] = useState(false);
  const [hasConfirmedDiarizationReview, setHasConfirmedDiarizationReview] = useState(false);
  const autoPlayRequestCounterRef = useRef(0);
  const hasTriggeredTranscriptionRef = useRef(false);
  const hasTriggeredGenerationRef = useRef(false);

  useEffect(() => {
    logger.info("[assistant][ui] page view", {
      route: "/assistant",
      mode: isBackendMode() ? "backend" : "standalone",
      provider: "demeter_sante",
    });
    return () => {
      logger.debug("[assistant][ui] page unmounted");
    };
  }, []);

  useEffect(() => {
    const handleVisibilityChange = () => {
      logger.debug("[assistant][ui] visibility change", {
        route: "/assistant",
        hidden: document.visibilityState === "hidden",
      });
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    setLlmApiProvider("demeter_sante");
    return () => {
      setLlmApiProvider(originalProviderRef.current);
      setCloudDemeterDiarizationEnabled(originalDiarizationRef.current);
    };
  }, [setCloudDemeterDiarizationEnabled, setLlmApiProvider]);

  useEffect(() => {
    hasTriggeredTranscriptionRef.current = false;
    hasTriggeredGenerationRef.current = false;
    setActiveChunkId(null);
    setAutoPlayRequest(null);
    setWaitingJokeIndex(0);
    setDiarizationChoice(null);
    setHasConfirmedDiarizationReview(false);
    setCloudDemeterDiarizationEnabled(originalDiarizationRef.current);
    if (!selectedFile) {
      setWaitingJokeOrder([]);
    }
  }, [selectedFile, setCloudDemeterDiarizationEnabled]);

  const handleAssistantFileSelected = useCallback(
    (file: File) => {
      logger.info("[assistant][ui] file selected", {
        name: file.name,
        sizeBytes: file.size,
        type: file.type,
      });
      resetLlmApiSession();
      hasTriggeredTranscriptionRef.current = false;
      hasTriggeredGenerationRef.current = false;
      setActiveChunkId(null);
      setAutoPlayRequest(null);
      setWaitingJokeOrder(buildRandomJokeOrder(ASSISTANT_JOKES.length));
      setDiarizationChoice(null);
      setWaitingJokeIndex(0);
      setHasConfirmedDiarizationReview(false);
      void handleCloudFileSelected(file);
    },
    [handleCloudFileSelected, resetLlmApiSession]
  );

  const handleDiarizationChoice = useCallback(
    (enabled: boolean) => {
      logger.info("[assistant][ui] diarization choice", { enabled });
      setDiarizationChoice(enabled);
      setCloudDemeterDiarizationEnabled(enabled);
    },
    [setCloudDemeterDiarizationEnabled]
  );

  const maybeStartTranscription = useCallback(() => {
    if (!selectedFile || !audioMetadata || diarizationChoice === null) {
      return;
    }
    if (hasTriggeredTranscriptionRef.current || cloudStatus !== "idle" || isTranscribing || isResettingSession) {
      return;
    }

    hasTriggeredTranscriptionRef.current = true;
    logger.info("[assistant][ui] auto transcription start", {
      fileName: selectedFile.name,
      diarization: diarizationChoice,
    });
    void startTranscription();
  }, [
    audioMetadata,
    cloudStatus,
    diarizationChoice,
    isResettingSession,
    isTranscribing,
    selectedFile,
    startTranscription,
  ]);

  useEffect(() => {
    maybeStartTranscription();
  }, [maybeStartTranscription]);

  const maybeStartGeneration = useCallback(() => {
    if (!selectedFile || diarizationChoice === null) {
      return;
    }
    if (diarizationChoice === true) {
      return;
    }
    if (!hasTriggeredTranscriptionRef.current || cloudStatus !== "done" || hasTriggeredGenerationRef.current) {
      return;
    }
    if (llmStatus !== "idle") {
      return;
    }

    hasTriggeredGenerationRef.current = true;
    logger.info("[assistant][ui] auto report generation start", {
      fileName: selectedFile.name,
      diarization: diarizationChoice,
    });
    void generateAll({ source: "transcription", transcriptMode: "cloud" });
  }, [cloudStatus, diarizationChoice, generateAll, llmStatus, selectedFile]);

  useEffect(() => {
    maybeStartGeneration();
  }, [maybeStartGeneration]);

  useEffect(() => {
    if (!isTranscribing && llmStatus !== "preparing" && llmStatus !== "generating" && llmStatus !== "formatting") {
      setWaitingJokeIndex(0);
      return;
    }

    if (waitingJokeOrder.length === 0) {
      return;
    }

    const timer = window.setInterval(() => {
      setWaitingJokeIndex((index) => (index + 1) % waitingJokeOrder.length);
    }, 4500);
    return () => window.clearInterval(timer);
  }, [isTranscribing, llmStatus, waitingJokeOrder.length]);

  useEffect(() => {
    if (!activeChunkId) {
      return;
    }
    if (!chunkSummaries.some((chunk) => chunk.chunkId === activeChunkId)) {
      setActiveChunkId(null);
      setAutoPlayRequest(null);
    }
  }, [activeChunkId, chunkSummaries]);

  const activeChunk = useMemo(
    () => chunkSummaries.find((chunk) => chunk.chunkId === activeChunkId) ?? null,
    [activeChunkId, chunkSummaries]
  );
  const activeChunkAutoPlayRequestId =
    activeChunk && autoPlayRequest?.chunkId === activeChunk.chunkId ? autoPlayRequest.requestId : null;
  const shouldUsePageScroll = Boolean(pageScrollContainerRef);
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
    fallbackHeight: 560,
    enabled: diarizationChoice === true && chunkSummaries.length > 0,
    scrollElementRef: pageScrollContainerRef ?? undefined,
  });

  const cloudStatusMeta = getCloudStatusMeta(cloudStatus);
  const llmStatusMeta = LLM_API_STATUS_META[llmStatus];
  const reportsReady =
    hasTriggeredGenerationRef.current &&
    llmStatus === "done" &&
    Boolean(results.cri && results.cro && results.crs);
  const cloudBusy = cloudStatus === "preprocessing" || cloudStatus === "uploading" || cloudStatus === "transcribing";
  const llmBusy = llmStatus === "preparing" || llmStatus === "generating" || llmStatus === "formatting";
  const hasError = cloudStatus === "error" || llmStatus === "error";
  const isWaitingForChoice = Boolean(selectedFile) && diarizationChoice === null;
  const isWaitingForReports = Boolean(selectedFile) && diarizationChoice !== null && cloudStatus === "done" && llmStatus === "idle";
  const isDiarizationReviewPending =
    Boolean(selectedFile) &&
    diarizationChoice === true &&
    cloudStatus === "done" &&
    !hasConfirmedDiarizationReview &&
    !hasError;
  const isProcessing =
    Boolean(selectedFile) &&
    diarizationChoice !== null &&
    !reportsReady &&
    !hasError &&
    !isDiarizationReviewPending &&
    (cloudBusy || llmBusy || isTranscribing || hasTriggeredTranscriptionRef.current || hasTriggeredGenerationRef.current);
  const progressValue = reportsReady
    ? 1
    : isDiarizationReviewPending
      ? 0.82
    : llmBusy
      ? 0.62 + llmProgress * 0.38
      : cloudBusy
        ? Math.min(0.6, cloudProgress * 0.6)
        : isWaitingForReports
          ? 0.72
        : isWaitingForChoice
          ? 0.1
          : 0;
  const statusLabel = !selectedFile
    ? "Prêt"
    : hasError
      ? "Erreur"
      : reportsReady
        ? "Rapports prêts"
        : isDiarizationReviewPending
          ? "Validation requise"
        : llmBusy
          ? llmStatusMeta.label
          : isWaitingForReports
            ? "Génération"
          : cloudBusy || hasTriggeredTranscriptionRef.current
            ? cloudStatusMeta.label
            : isWaitingForChoice
              ? "Question"
              : "En attente";
  const statusVariant = hasError
    ? "destructive"
    : reportsReady
      ? "success"
      : isDiarizationReviewPending
        ? "warning"
      : llmBusy
        ? llmStatusMeta.variant
        : cloudStatusMeta.variant;
  const statusDescription = !selectedFile
    ? "Déposez un fichier audio. Demeter s'occupe du reste."
    : hasError
      ? cloudStatusDetail || llmApiStatusDetail || "Une erreur a interrompu le flux."
      : reportsReady
        ? "La transcription brute et les trois comptes rendus sont prêts au téléchargement."
        : isDiarizationReviewPending
          ? "La transcription est prête. Vérifiez et modifiez les morceaux ci-dessous, puis cliquez pour continuer."
        : llmBusy
        ? llmApiStatusDetail || "Génération des rapports en cours."
        : isWaitingForReports
          ? "Demeter prépare les trois rapports."
        : cloudBusy || hasTriggeredTranscriptionRef.current
          ? cloudStatusDetail || "Transcription cloud en cours."
          : isWaitingForChoice
            ? "Choisissez si vous voulez afficher les morceaux audio détaillés."
            : "Préparation du flux assistant.";
  const currentJokeIndex =
    waitingJokeOrder.length > 0 ? waitingJokeOrder[waitingJokeIndex % waitingJokeOrder.length] ?? 0 : 0;
  const currentJoke = ASSISTANT_JOKES[currentJokeIndex] ?? ASSISTANT_JOKES[0];
  const canResetWorkflow = Boolean(selectedFile) && !isProcessing && !isResettingWorkflow;
  const hasReportDownloads = reportsReady;
  const showChunkReviewCard = isDiarizationReviewPending;

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

  const handleContinueAfterTranscriptReview = useCallback(() => {
    if (!selectedFile || diarizationChoice !== true || !isDiarizationReviewPending || hasTriggeredGenerationRef.current) {
      return;
    }

    logger.info("[assistant][ui] transcript review confirmed, starting report generation", {
      fileName: selectedFile.name,
    });
    setHasConfirmedDiarizationReview(true);
    setActiveChunkId(null);
    setAutoPlayRequest(null);
    setWaitingJokeIndex(0);
    hasTriggeredGenerationRef.current = true;
    void generateAll({ source: "transcription", transcriptMode: "cloud" });
  }, [diarizationChoice, generateAll, isDiarizationReviewPending, selectedFile]);

  const handleTranscriptDownload = useCallback(async () => {
    if (!selectedFile || isTranscriptExporting) {
      return;
    }

    logger.info("[assistant][ui] transcript download requested", {
      fileName: selectedFile.name,
    });
    setIsTranscriptExporting(true);

    try {
      const segments = await loadAllSegmentsForExport();
      const generatedAt = new Date().toISOString();
      const blob = await buildTranscriptDocx(segments, {
        sourceMode: "cloud",
        sourceLabel: selectedFile.name,
        generatedAt,
      });
      downloadDocxBlob(blob, formatTranscriptDocxFilename(new Date(generatedAt)));
    } catch (error) {
      logger.error("[assistant][ui] transcript download failed", {
        fileName: selectedFile.name,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsTranscriptExporting(false);
    }
  }, [isTranscriptExporting, loadAllSegmentsForExport, selectedFile]);

  const handleResetWorkflow = useCallback(async () => {
    if (!selectedFile || isResettingWorkflow || isProcessing) {
      return;
    }

    logger.info("[assistant][ui] workflow reset requested");
    setIsResettingWorkflow(true);
    hasTriggeredTranscriptionRef.current = false;
    hasTriggeredGenerationRef.current = false;
    setActiveChunkId(null);
    setAutoPlayRequest(null);
    setDiarizationChoice(null);
    setWaitingJokeOrder([]);
    setWaitingJokeIndex(0);
    setHasConfirmedDiarizationReview(false);
    resetLlmApiSession();

    try {
      await resetTranscriptionSession();
    } finally {
      setIsResettingWorkflow(false);
    }
  }, [isProcessing, isResettingWorkflow, resetLlmApiSession, resetTranscriptionSession, selectedFile]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="space-y-3">
        <Badge variant="outline" className="gap-2 rounded-full px-3 py-1 text-xs font-medium">
          <WandSparkles className="h-3.5 w-3.5" />
          Assistant cloud Demeter
        </Badge>
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Assistant</h1>
          <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
            Déposez un fichier audio, choisissez la diarization, puis laissez Demeter transcrire et générer les trois
            rapports. Le flux reste cloud-only, simple et sans détour.
          </p>
        </div>
      </header>

      <div className="flex flex-col gap-6">
        <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="text-xl">Statut</CardTitle>
                <CardDescription>{statusDescription}</CardDescription>
              </div>
              <Badge variant={statusVariant}>{statusLabel}</Badge>
            </div>

            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <WorkflowStep
                label="Fichier"
                done={Boolean(selectedFile)}
                active={!selectedFile}
              />
              <WorkflowStep
                label="Diarization"
                done={diarizationChoice !== null}
                active={isWaitingForChoice}
              />
              <WorkflowStep
                label="Transcription"
                done={cloudStatus === "done"}
                active={Boolean(selectedFile) && diarizationChoice !== null && !cloudBusy && !reportsReady && !hasError}
              />
              <WorkflowStep
                label="Rapports"
                done={reportsReady}
                active={llmBusy || (cloudStatus === "done" && hasTriggeredTranscriptionRef.current && !hasReportDownloads)}
              />
            </div>

            <Progress value={progressValue * 100} className="h-2" />
          </CardHeader>

          <CardContent className="space-y-4">
            {isDiarizationReviewPending ? (
              <div data-testid="assistant-status-body" className="space-y-4 rounded-[1.5rem] border bg-background/70 p-5">
                <p className="text-sm text-muted-foreground">
                  Relisez les morceaux ci-dessous. Les modifications sont sauvegardées automatiquement.
                </p>
                <div className="flex justify-center">
                  <Button type="button" className="gap-2" onClick={() => void handleContinueAfterTranscriptReview()}>
                    La transcription est ok continuer
                  </Button>
                </div>
              </div>
            ) : isProcessing ? (
              <div data-testid="assistant-status-body" className="space-y-5 rounded-[1.5rem] border bg-background/70 p-5">
                <div className="flex items-center justify-center gap-2">
                  {[0, 1, 2, 3].map((index) => (
                    <span
                      key={index}
                      className="h-3 w-3 rounded-full bg-primary/80 animate-pulse"
                      style={{
                        animationDelay: `${index * 120}ms`,
                      }}
                    />
                  ))}
                </div>
                <p className="text-center text-sm text-muted-foreground">{currentJoke}</p>
              </div>
            ) : reportsReady ? (
              <div
                data-testid="assistant-status-body"
                className="flex flex-wrap items-center justify-center gap-2 rounded-[1.5rem] border bg-background/70 p-4"
              >
                <Button
                  type="button"
                  className="gap-2"
                  variant="default"
                  onClick={() => {
                    void handleTranscriptDownload();
                  }}
                  disabled={isTranscriptExporting}
                >
                  {isTranscriptExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                  Télécharger la transcription (.docx)
                </Button>
                {REPORT_FORMATS.map((format) => (
                  <Button
                    key={format.key}
                    type="button"
                    className="gap-2"
                    variant="default"
                    onClick={() => {
                      void downloadDocx(format.key);
                    }}
                  >
                    <Download className="h-4 w-4" />
                    Télécharger {format.label}
                  </Button>
                ))}
              </div>
            ) : null}
          </CardContent>
        </Card>

        {showChunkReviewCard ? (
          <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
            <CardHeader className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="text-xl">Morceaux audio</CardTitle>
                  <CardDescription>
                    Modifiez les morceaux autant que nécessaire. Les comptes rendus démarrent après validation.
                  </CardDescription>
                </div>

                <TooltipProvider delayDuration={150}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground"
                        aria-label="Aide morceaux audio"
                      >
                        <Info className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-72 text-balance">
                      Chaque carte correspond à un morceau audio. Le détail reste modifiable tant que cette zone est
                      visible.
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {chunkSummaries.length ? (
                <div
                  ref={chunkListRef}
                  data-testid="assistant-chunk-list"
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
                          <CloudChunkCard
                            chunk={chunk}
                            isActive={isActive}
                            onOpen={handleOpenChunk}
                            onPlay={handlePlayChunk}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="rounded-[1.5rem] border border-dashed bg-background/60 px-6 py-10 text-sm text-muted-foreground">
                  Les morceaux audio apparaîtront ici dès que Demeter aura terminé la transcription avec diarization.
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="space-y-2">
            <CardTitle className="flex items-center gap-2 text-xl">
              <FileAudio2 className="h-5 w-5 text-primary" />
              Import
            </CardTitle>
            <CardDescription>
              Un seul fichier, une seule voie cloud. Rien de local, rien à choisir côté moteur.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <AudioUploader
              onFileSelected={handleAssistantFileSelected}
              metadata={audioMetadata}
              disabled={isProcessing || isResettingWorkflow}
              hideDropZoneWhenMetadata={Boolean(audioMetadata)}
              title="Déposez votre audio"
              description="Demeter gère toute la chaîne cloud. Vous choisissez seulement si vous voulez la diarization."
              formatsHint="Formats supportés : mp3, wav, m4a, ogg, webm."
            />

            {selectedFile ? (
              <div className="rounded-[1.5rem] border bg-background/70 p-4 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold">Diarization</h2>
                      <TooltipProvider delayDuration={150}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground"
                              aria-label="Aide diarization"
                            >
                              <Info className="h-4 w-4" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-72 text-balance">
                            Activez-la si vous voulez voir les morceaux audio en pleine page, comme dans
                            <span className="font-medium"> /cloudupload</span>.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Voulez-vous afficher les morceaux audio avec le détail complet des segments ?
                    </p>
                  </div>
                  <Badge variant={diarizationChoice === null ? "secondary" : diarizationChoice ? "success" : "outline"}>
                    {diarizationChoice === null ? "En attente" : diarizationChoice ? "Oui" : "Non"}
                  </Badge>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <Button
                    type="button"
                    size="lg"
                    className={cn(
                      "h-auto justify-start rounded-2xl px-4 py-4 text-left",
                      diarizationChoice === true ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
                    )}
                    onClick={() => {
                      handleDiarizationChoice(true);
                    }}
                    disabled={isProcessing || isResettingWorkflow || diarizationChoice !== null}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Cloud className="h-4 w-4" />
                        <span className="font-medium">Oui, avec morceaux</span>
                      </div>
                      <p className="text-xs font-normal text-primary-foreground/80">
                        J'affiche les morceaux audio et le détail plein écran.
                      </p>
                    </div>
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    className={cn(
                      "h-auto justify-start rounded-2xl px-4 py-4 text-left",
                      diarizationChoice === false ? "ring-2 ring-border ring-offset-2 ring-offset-background" : ""
                    )}
                    onClick={() => {
                      handleDiarizationChoice(false);
                    }}
                    disabled={isProcessing || isResettingWorkflow || diarizationChoice !== null}
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Sparkles className="h-4 w-4" />
                        <span className="font-medium">Non, version simple</span>
                      </div>
                      <p className="text-xs font-normal text-muted-foreground">
                        Je veux aller droit au but, sans affichage de chunks.
                      </p>
                    </div>
                  </Button>
                </div>
              </div>
            ) : null}

            {selectedFile ? (
              <div data-testid="assistant-import-footer-actions" className="flex flex-wrap justify-end gap-2 pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-2 text-muted-foreground"
                  onClick={() => void handleResetWorkflow()}
                  disabled={!canResetWorkflow}
                >
                  <RotateCcw className="h-4 w-4" />
                  Nouveau fichier
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
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
          segmentEditingDisabled={isResettingWorkflow || isResettingSession || isTranscribing}
          autoPlayRequestId={activeChunkAutoPlayRequestId}
          onAutoPlayRequestConsumed={handleAutoPlayRequestConsumed}
          onSegmentTextChange={(segmentIndex, text) => {
            void updateSegmentText(activeChunk.chunkId, segmentIndex, text);
          }}
          onSegmentSpeakerChange={(segmentIndex, speakerId) => {
            void updateSegmentSpeaker(activeChunk.chunkId, segmentIndex, speakerId);
          }}
          onClose={handleCloseChunk}
        />
      ) : null}
    </div>
  );
}

function WorkflowStep({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}) {
  return (
    <div
      className={cn(
        "min-w-0 overflow-hidden rounded-2xl border px-3 py-2 text-left transition",
        done ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-950 dark:text-emerald-50" : "",
        active && !done ? "border-primary/30 bg-primary/10 text-foreground" : "text-muted-foreground"
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px]",
            done ? "border-emerald-500/40 bg-emerald-500 text-white" : active ? "border-primary/40 bg-primary text-primary-foreground" : "border-border bg-background"
          )}
        >
          {done ? <span className="translate-y-px">✓</span> : <span className="translate-y-px">•</span>}
        </span>
        <span className="min-w-0 whitespace-normal break-normal font-medium leading-tight" title={label}>
          {label}
        </span>
      </div>
    </div>
  );
}

export default AssistantPage;
