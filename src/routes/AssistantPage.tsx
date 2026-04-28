import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AudioUploader } from "@/components/audio/AudioUploader";
import { AssistantHelpPanel } from "@/components/assistant/AssistantHelpPanel";
import { CloudChunkCard } from "@/components/results/CloudChunkCard";
import { CloudChunkDetailsPanel } from "@/components/results/CloudChunkDetailsPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Progress } from "@/components/ui/progress";
import { TooltipButton } from "@/components/ui/tooltip-button";
import { usePageScrollContainer } from "@/components/layout/page-scroll-container";
import { ReportFormatResultsPanel } from "@/components/llm/ReportFormatResultsPanel";
import { ReportFormatSwitchesSection } from "@/components/llm/ReportFormatSwitchesSection";
import { ReportDetailLevelsSection } from "@/components/llm/ReportDetailLevelsSection";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useCloudTranscription } from "@/hooks/useCloudTranscription";
import { useLlmReports } from "@/hooks/useLlmReports";
import { useVirtualizedList } from "@/hooks/useVirtualizedList";
import { getCloudStatusMeta } from "@/lib/cloudStatusMeta";
import { buildTranscriptDocx, downloadDocxBlob, formatTranscriptDocxFilename } from "@/lib/docx/transcriptDocx";
import { isBackendMode } from "@/lib/runtime-config";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import { getSessionTranscriptText } from "@/lib/sessionTranscriptMemory";
import { useAsrStore } from "@/store/asr-store";
import logger from "@/lib/logger";
import { cn } from "@/lib/utils";
import { Cloud, Download, FileAudio2, Info, Loader2, RotateCcw, Sparkles, WandSparkles } from "lucide-react";
import { ASSISTANT_JOKES, buildRandomJokeOrder } from "@/routes/assistantPageContent";

const REPORT_FORMATS = [
  {
    key: "cri" as const,
    format: "CRI" as const,
    label: buildReportFormatLabel("CRI"),
    description: buildReportFormatDescription("CRI"),
  },
  {
    key: "cro" as const,
    format: "CRO" as const,
    label: buildReportFormatLabel("CRO"),
    description: buildReportFormatDescription("CRO"),
  },
  {
    key: "crs" as const,
    format: "CRS" as const,
    label: buildReportFormatLabel("CRS"),
    description: buildReportFormatDescription("CRS"),
  },
  {
    key: "crn" as const,
    format: "CRN" as const,
    label: buildReportFormatLabel("CRN"),
    description: buildReportFormatDescription("CRN"),
  },
];

const REPORT_INPUT_RETRY_COUNT = 20;
const REPORT_INPUT_RETRY_DELAY_MS = 250;

function waitForReportInputRetry() {
  return new Promise((resolve) => window.setTimeout(resolve, REPORT_INPUT_RETRY_DELAY_MS));
}

function WorkflowResetButton({
  position,
  onClick,
  disabled,
}: {
  position: "top" | "bottom";
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      data-testid={`assistant-reset-workflow-${position}`}
      variant="destructive"
      size="sm"
      className="gap-2"
      onClick={onClick}
      disabled={disabled}
    >
      <RotateCcw className="h-4 w-4" />
      Nouvelle transcription
    </Button>
  );
}

function AssistantPage() {
  useBackendPermissions();
  const pageScrollContainerRef = usePageScrollContainer();

  const llmApiReportDetailLevels = useAsrStore((state) => state.llmApiReportDetailLevels);
  const llmApiReportEnabledFormats = useAsrStore((state) => state.llmApiReportEnabledFormats);
  const setLlmApiReportDetailLevel = useAsrStore((state) => state.setLlmApiReportDetailLevel);
  const setLlmApiReportEnabledFormat = useAsrStore((state) => state.setLlmApiReportEnabledFormat);
  const setCloudDemeterDiarizationEnabled = useAsrStore((state) => state.setCloudDemeterDiarizationEnabled);
  const cloudEnableWordTimestamps = useAsrStore((state) => state.cloudEnableWordTimestamps);
  const cloudShowSegmentConfidence = useAsrStore((state) => state.cloudShowSegmentConfidence);
  const resetLlmApiSession = useAsrStore((state) => state.resetLlmApiSession);
  const llmApiStatusDetail = useAsrStore((state) => state.llmApiStatusDetail);
  const assistantWorkflow = useAsrStore((state) => state.assistantWorkflow);
  const setAssistantWorkflow = useAsrStore((state) => state.setAssistantWorkflow);
  const resetAssistantWorkflow = useAsrStore((state) => state.resetAssistantWorkflow);

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
    applyChunkSpeakerAssignments,
  } = useCloudTranscription("demeter_sante", { forceDemeterBackendDirect: true });

  const {
    status: llmStatus,
    progress: llmProgress,
    results,
    generateAll,
    downloadDocx,
  } = useLlmReports({ providerOverride: "demeter_sante" });

  const { diarizationChoice, activeChunkId, hasTriggeredTranscription, hasTriggeredGeneration, hasConfirmedDiarizationReview } =
    assistantWorkflow;
  const [isHelpOpen, setIsHelpOpen] = useState(true);
  const [autoPlayRequest, setAutoPlayRequest] = useState<{ chunkId: string; requestId: number } | null>(null);
  const [waitingJokeOrder, setWaitingJokeOrder] = useState<number[]>([]);
  const [waitingJokeIndex, setWaitingJokeIndex] = useState(0);
  const [isResettingWorkflow, setIsResettingWorkflow] = useState(false);
  const [isResetConfirmationOpen, setIsResetConfirmationOpen] = useState(false);
  const [isTranscriptExporting, setIsTranscriptExporting] = useState(false);
  const autoPlayRequestCounterRef = useRef(0);

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

  const handleAssistantFileSelected = useCallback(
    (file: File) => {
      logger.info("[assistant][ui] file selected", {
        name: file.name,
        sizeBytes: file.size,
        type: file.type,
      });
      resetLlmApiSession();
      resetAssistantWorkflow();
      setAutoPlayRequest(null);
      setWaitingJokeOrder(buildRandomJokeOrder(ASSISTANT_JOKES.length));
      setWaitingJokeIndex(0);
      void handleCloudFileSelected(file);
    },
    [handleCloudFileSelected, resetAssistantWorkflow, resetLlmApiSession]
  );

  const handleDiarizationChoice = useCallback(
    (enabled: boolean) => {
      logger.info("[assistant][ui] diarization choice", { enabled });
      setAssistantWorkflow({ diarizationChoice: enabled });
      setCloudDemeterDiarizationEnabled(enabled);
    },
    [setAssistantWorkflow, setCloudDemeterDiarizationEnabled]
  );

  const maybeStartTranscription = useCallback(() => {
    if (!selectedFile || !audioMetadata || diarizationChoice === null) {
      return;
    }
    if (hasTriggeredTranscription || cloudStatus !== "idle" || isTranscribing || isResettingSession) {
      return;
    }

    setAssistantWorkflow({ hasTriggeredTranscription: true });
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
    hasTriggeredTranscription,
    setAssistantWorkflow,
    startTranscription,
  ]);

  useEffect(() => {
    maybeStartTranscription();
  }, [maybeStartTranscription]);

  const buildAssistantReportInput = useCallback(async () => {
    for (let attempt = 0; attempt <= REPORT_INPUT_RETRY_COUNT; attempt += 1) {
      const memoryText = getSessionTranscriptText(useAsrStore.getState().sessionTranscriptMemories.cloud).trim();
      if (memoryText) {
        logger.warn("[assistant][ui] no exportable transcript segments before report generation, using session memory", {
          attempt,
          textLength: memoryText.length,
        });
        return { source: "transcription" as const, transcriptMode: "cloud" as const, sourceText: memoryText };
      }

      if (attempt < REPORT_INPUT_RETRY_COUNT) {
        await waitForReportInputRetry();
      }
    }

    throw new Error("La transcription n'est pas encore disponible pour générer les comptes rendus.");
  }, []);

  const maybeStartGeneration = useCallback(() => {
    if (!selectedFile || diarizationChoice === null) {
      return;
    }
    if (diarizationChoice === true) {
      return;
    }
    if (!hasTriggeredTranscription || cloudStatus !== "done" || hasTriggeredGeneration) {
      return;
    }
    if (llmStatus !== "idle") {
      return;
    }

    setAssistantWorkflow({ hasTriggeredGeneration: true });
    logger.info("[assistant][ui] auto report generation start", {
      fileName: selectedFile.name,
      diarization: diarizationChoice,
    });
    void (async () => {
      try {
        const input = await buildAssistantReportInput();
        await generateAll(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[assistant][ui] auto report generation failed before LLM run", {
          fileName: selectedFile.name,
          message,
        });
        useAsrStore.getState().setLlmApiStatus("error", message);
        setAssistantWorkflow({ hasTriggeredGeneration: false });
      }
    })();
  }, [
    buildAssistantReportInput,
    cloudStatus,
    diarizationChoice,
    generateAll,
    hasTriggeredGeneration,
    hasTriggeredTranscription,
    llmStatus,
    selectedFile,
    setAssistantWorkflow,
  ]);

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
      setAssistantWorkflow({ activeChunkId: null });
      setAutoPlayRequest(null);
    }
  }, [activeChunkId, chunkSummaries, setAssistantWorkflow]);

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
  const activeReportFormats = REPORT_FORMATS.filter((format) => llmApiReportEnabledFormats[format.format]);
  const reportsReady =
    hasTriggeredGeneration &&
    llmStatus === "done" &&
    activeReportFormats.every((format) => Boolean(results[format.key]));
  const hasAnyReportResult = activeReportFormats.some((format) => Boolean(results[format.key]));
  const cloudBusy =
    cloudStatus === "preprocessing" ||
    cloudStatus === "uploading" ||
    cloudStatus === "queued" ||
    cloudStatus === "transcribing";
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
    (cloudBusy || llmBusy || isTranscribing || hasTriggeredTranscription || hasTriggeredGeneration);
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
        ? "Comptes rendus prêts"
        : isDiarizationReviewPending
          ? "Relecture des morceaux"
        : llmBusy
          ? llmStatusMeta.label
        : isWaitingForReports
            ? "Préparation des comptes rendus"
          : cloudBusy || hasTriggeredTranscription
            ? cloudStatusMeta.label
            : isWaitingForChoice
              ? "Choix de la diarisation"
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
    ? "Déposez un fichier audio pour démarrer."
    : hasError
      ? cloudStatusDetail || llmApiStatusDetail || "Le traitement a rencontré une erreur."
      : reportsReady
        ? "La transcription complète et les comptes rendus sont prêts au téléchargement."
        : isDiarizationReviewPending
          ? "La transcription est prête. Vérifiez les morceaux ci-dessous, puis validez pour lancer les comptes rendus."
        : llmBusy
        ? llmApiStatusDetail || "Les comptes rendus sont en cours de génération."
        : isWaitingForReports
          ? "La transcription est terminée. Demeter prépare les comptes rendus."
        : cloudBusy || hasTriggeredTranscription
          ? cloudStatusDetail || "La transcription cloud est en cours."
          : isWaitingForChoice
            ? "Choisissez si vous voulez voir les morceaux audio et relire les intervenants."
            : "L'assistant est prêt.";
  const currentJokeIndex =
    waitingJokeOrder.length > 0 ? waitingJokeOrder[waitingJokeIndex % waitingJokeOrder.length] ?? 0 : 0;
  const currentJoke = ASSISTANT_JOKES[currentJokeIndex] ?? ASSISTANT_JOKES[0];
  const showResetWorkflowAction = reportsReady && !isResettingWorkflow;
  const hasReportDownloads = hasAnyReportResult;
  const showChunkReviewCard = isDiarizationReviewPending;
  const isImportCollapsed = Boolean(selectedFile) && (isProcessing || isDiarizationReviewPending || reportsReady);
  const showReportResultsPanel = Boolean(selectedFile) && (cloudStatus === "done" || llmBusy || hasTriggeredGeneration || hasAnyReportResult);

  const handleOpenChunk = useCallback((chunkId: string) => {
    setAssistantWorkflow({ activeChunkId: chunkId });
    setAutoPlayRequest(null);
  }, [setAssistantWorkflow]);

  const handlePlayChunk = useCallback((chunkId: string) => {
    autoPlayRequestCounterRef.current += 1;
    setAssistantWorkflow({ activeChunkId: chunkId });
    setAutoPlayRequest({ chunkId, requestId: autoPlayRequestCounterRef.current });
  }, [setAssistantWorkflow]);

  const handleCloseChunk = useCallback(() => {
    setAssistantWorkflow({ activeChunkId: null });
    setAutoPlayRequest(null);
  }, [setAssistantWorkflow]);

  const handleAutoPlayRequestConsumed = useCallback(() => {
    setAutoPlayRequest(null);
  }, []);

  const handleContinueAfterTranscriptReview = useCallback(() => {
    if (!selectedFile || diarizationChoice !== true || !isDiarizationReviewPending || hasTriggeredGeneration) {
      return;
    }

    logger.info("[assistant][ui] transcript review confirmed, starting report generation", {
      fileName: selectedFile.name,
    });
    setAssistantWorkflow({
      hasConfirmedDiarizationReview: true,
      activeChunkId: null,
      hasTriggeredGeneration: true,
    });
    setAutoPlayRequest(null);
    setWaitingJokeIndex(0);
    void (async () => {
      try {
        const input = await buildAssistantReportInput();
        await generateAll(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[assistant][ui] reviewed report generation failed before LLM run", {
          fileName: selectedFile.name,
          message,
        });
        useAsrStore.getState().setLlmApiStatus("error", message);
        setAssistantWorkflow({ hasTriggeredGeneration: false });
      }
    })();
  }, [
    buildAssistantReportInput,
    diarizationChoice,
    generateAll,
    hasTriggeredGeneration,
    isDiarizationReviewPending,
    selectedFile,
    setAssistantWorkflow,
  ]);

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
    resetAssistantWorkflow();
    setAutoPlayRequest(null);
    setWaitingJokeOrder([]);
    setWaitingJokeIndex(0);
    resetLlmApiSession();

    try {
      await resetTranscriptionSession();
    } finally {
      setIsResettingWorkflow(false);
    }
  }, [isProcessing, isResettingWorkflow, resetAssistantWorkflow, resetLlmApiSession, resetTranscriptionSession, selectedFile]);

  const handleOpenResetConfirmation = useCallback(() => {
    if (!showResetWorkflowAction) {
      return;
    }
    logger.info("[assistant][ui] workflow reset confirmation opened");
    setIsResetConfirmationOpen(true);
  }, [showResetWorkflowAction]);

  const handleConfirmResetWorkflow = useCallback(() => {
    if (!showResetWorkflowAction || isResettingWorkflow) {
      return;
    }

    logger.info("[assistant][ui] workflow reset confirmed");
    setIsResetConfirmationOpen(false);
    void (async () => {
      try {
        await handleResetWorkflow();
        const scrollContainer = pageScrollContainerRef?.current;
        if (scrollContainer) {
          scrollContainer.scrollTop = 0;
        }
      } catch (error) {
        logger.error("[assistant][ui] workflow reset failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }, [handleResetWorkflow, isResettingWorkflow, pageScrollContainerRef, showResetWorkflowAction]);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
      <header className="space-y-3">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-3">
            <Badge variant="outline" className="gap-2 rounded-full px-3 py-1 text-xs font-medium">
              <WandSparkles className="h-3.5 w-3.5" />
              Assistant cloud Demeter
            </Badge>
            <div className="space-y-2">
              <h1 className="text-3xl font-semibold tracking-tight">Assistant</h1>
              <p className="max-w-3xl text-sm text-muted-foreground sm:text-base">
                Déposez un fichier audio, choisissez la diarisation, puis laissez Demeter transcrire et générer les
                comptes rendus. Le flux reste cloud-only, simple et sans détour.
              </p>
            </div>
          </div>
          {showResetWorkflowAction ? (
            <div className="flex sm:pt-1">
              <WorkflowResetButton position="top" onClick={handleOpenResetConfirmation} />
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex flex-col gap-6">
        <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="text-xl">Aide</CardTitle>
                <CardDescription>Les étapes sont expliquées avant le lancement pour éviter le jargon.</CardDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-2 text-muted-foreground"
                aria-expanded={isHelpOpen}
                aria-controls="assistant-help-panel"
                onClick={() => setIsHelpOpen((value) => !value)}
              >
                <Info className="h-4 w-4" />
                {isHelpOpen ? "Masquer l’aide" : "Afficher l’aide"}
              </Button>
            </div>
          </CardHeader>
          <CardContent>{isHelpOpen ? <AssistantHelpPanel /> : <HelpCollapsedState />}</CardContent>
        </Card>

        <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="space-y-3">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <CardTitle className="flex items-center gap-2 text-xl">
                  <FileAudio2 className="h-5 w-5 text-primary" />
                  Import
                </CardTitle>
                <CardDescription>
                  Le fichier audio se charge ici. La diarisation reste optionnelle et l’import se replie
                  automatiquement dès que le traitement démarre.
                </CardDescription>
              </div>
              <Badge variant={selectedFile ? (isImportCollapsed ? "success" : "secondary") : "outline"}>
                {selectedFile ? (isImportCollapsed ? "Replié" : "En attente") : "À faire"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <AudioUploader
              onFileSelected={handleAssistantFileSelected}
              metadata={audioMetadata}
              disabled={isImportCollapsed || isProcessing || isResettingWorkflow}
              hideDropZoneWhenMetadata={Boolean(audioMetadata)}
              title={isImportCollapsed ? "Fichier en cours" : "Déposez votre audio"}
              description={
                isImportCollapsed
                  ? "La transcription a démarré. Ce résumé compact reste visible pendant le traitement."
                  : "Demeter gère toute la chaîne cloud. Vous choisissez seulement si vous voulez la diarisation."
              }
              formatsHint="Formats supportés : mp3, wav, m4a, ogg, webm."
            />

            <ReportDetailLevelsSection
              values={llmApiReportDetailLevels}
              onChange={setLlmApiReportDetailLevel}
              className="mt-2"
              defaultCollapsed
            />

            <ReportFormatSwitchesSection
              values={llmApiReportEnabledFormats}
              onChange={setLlmApiReportEnabledFormat}
              className="mt-4"
            />

            {selectedFile && !isImportCollapsed ? (
              <>
                <div className="rounded-[1.5rem] border bg-background/70 p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold">Diarisation</h2>
                        <TooltipButton
                          tooltip="La diarisation sépare automatiquement les personnes qui parlent. Activez-la si vous voulez relire les morceaux audio avant les comptes rendus."
                          tooltipSide="top"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-muted-foreground"
                          aria-label="Aide diarisation"
                        >
                          <Info className="h-4 w-4" />
                        </TooltipButton>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Voulez-vous afficher les morceaux audio pour relire les intervenants et corriger le texte avant
                        la suite ?
                      </p>
                    </div>
                    <Badge variant={diarizationChoice === null ? "secondary" : diarizationChoice ? "success" : "outline"}>
                      {diarizationChoice === null ? "En attente" : diarizationChoice ? "Oui, avec morceaux" : "Non, version simple"}
                    </Badge>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <TooltipButton
                      tooltip="Affiche les morceaux audio détaillés pour relire les segments et corriger les intervenants avant les comptes rendus."
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
                          J’affiche les morceaux audio et le détail plein écran.
                        </p>
                      </div>
                    </TooltipButton>

                    <TooltipButton
                      tooltip="Passe directement à la transcription simple et aux comptes rendus, sans affichage des morceaux audio."
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
                          J’avance plus vite, sans affichage détaillé des morceaux.
                        </p>
                      </div>
                    </TooltipButton>
                  </div>
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>

        {showChunkReviewCard ? (
          <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
            <CardHeader className="space-y-2">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <CardTitle className="text-xl">Relecture des morceaux</CardTitle>
                  <CardDescription>
                    Ajustez les intervenants ou les segments si besoin. Les comptes rendus s’appuient sur cette version.
                  </CardDescription>
                </div>

                  <TooltipButton
                    tooltip="Chaque carte correspond à une partie de l’audio. Ouvrez-la pour relire les segments et les intervenants."
                    tooltipSide="left"
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 text-muted-foreground"
                    aria-label="Aide relecture des morceaux"
                  >
                    <Info className="h-4 w-4" />
                  </TooltipButton>
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
                  Les morceaux audio apparaîtront ici dès que Demeter aura terminé la transcription avec diarisation.
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        <Card className="overflow-hidden rounded-[2rem] border bg-card/80 shadow-sm backdrop-blur">
          <CardHeader className="space-y-2">
            <CardTitle className="text-xl">Statut</CardTitle>
            <CardDescription>{statusDescription}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={statusVariant}>{statusLabel}</Badge>
              <Badge variant="outline">{Math.round(progressValue * 100)}%</Badge>
              {selectedFile ? <Badge variant="outline">{selectedFile.name}</Badge> : null}
            </div>

            <div className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2 xl:grid-cols-4">
              <WorkflowStep label="Fichier audio" done={Boolean(selectedFile)} active={!selectedFile} />
              <WorkflowStep label="Diarisation" done={diarizationChoice !== null} active={isWaitingForChoice} />
              <WorkflowStep
                label="Transcription"
                done={cloudStatus === "done"}
                active={Boolean(selectedFile) && diarizationChoice !== null && !cloudBusy && !reportsReady && !hasError}
              />
              <WorkflowStep
                label="Comptes rendus"
                done={reportsReady}
                active={llmBusy || (cloudStatus === "done" && hasTriggeredTranscription && !hasReportDownloads)}
              />
            </div>

            <Progress value={progressValue * 100} className="h-2" />

            {isDiarizationReviewPending ? (
              <div data-testid="assistant-status-body" className="space-y-4 rounded-[1.5rem] border bg-background/70 p-5">
                <p className="text-sm text-muted-foreground">
                  Relisez les morceaux ci-dessous. Les modifications sont sauvegardées automatiquement.
                </p>
                <div className="flex justify-center">
                  <TooltipButton
                    tooltip="Validez la relecture pour lancer les comptes rendus avec les derniers intervenants et les dernières corrections."
                    type="button"
                    className="gap-2"
                    onClick={() => void handleContinueAfterTranscriptReview()}
                  >
                    Valider la transcription
                  </TooltipButton>
                </div>
              </div>
            ) : isProcessing && !hasAnyReportResult ? (
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
            ) : showReportResultsPanel ? (
              <div data-testid="assistant-status-body" className="space-y-4 rounded-[1.5rem] border bg-background/70 p-4">
                {cloudStatus === "done" ? (
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <TooltipButton
                      tooltip="Télécharge la transcription complète au format DOCX avec les intervenants déjà appliqués."
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
                    </TooltipButton>
                  </div>
                ) : null}

                <ReportFormatResultsPanel
                  results={results}
                  enabledFormats={llmApiReportEnabledFormats}
                  onDownload={(format) => {
                    void downloadDocx(format);
                  }}
                  emptyMessage="Les comptes rendus apparaîtront ici au fil de leur réception."
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        {showResetWorkflowAction ? (
          <div className="flex justify-end">
            <WorkflowResetButton position="bottom" onClick={handleOpenResetConfirmation} />
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={isResetConfirmationOpen}
        title="Remettre l'assistant à zéro ?"
        description="Vous êtes sur le point de lancer une nouvelle transcription. Le travail en cours sera perdu et vous ne pourrez pas revenir en arrière."
        cancelLabel="Annuler"
        confirmLabel="OK"
        onCancel={() => setIsResetConfirmationOpen(false)}
        onConfirm={handleConfirmResetWorkflow}
      />

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
          onSpeakerAssignmentsApplied={(assignments) => {
            void applyChunkSpeakerAssignments(activeChunk.chunkId, assignments);
          }}
          onClose={handleCloseChunk}
        />
      ) : null}
    </div>
  );
}

function HelpCollapsedState() {
  return (
    <div className="rounded-[1.5rem] border border-dashed bg-background/60 p-4 text-sm text-muted-foreground">
      L’aide est masquée. Rouvrez-la si vous avez besoin d’un rappel sur l’import, la diarisation ou les comptes
      rendus.
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
