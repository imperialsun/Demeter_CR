import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useAsrStore, MODEL_PRESETS, serializePersistedSettings } from "@/store/asr-store";
import { cn } from "@/lib/utils";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "@/components/ui/use-toast";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ChangePasswordDialog } from "@/components/layout/ChangePasswordDialog";
import { TopbarConsoleLogsPanel } from "@/components/layout/TopbarConsoleLogsPanel";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { canAccessFeature, getFirstAuthorizedRoute } from "@/lib/backend-permissions";
import { initializeBackendSupport, resetWebGpuSupportCache } from "@/lib/backend-support";
import logger, { exportDiagnosticLogBundle, type LogLevel } from "@/lib/logger";
import { setAuthenticated } from "@/lib/auth";
import { backendChangePassword, backendLogout } from "@/lib/backend-auth";
import { getBackendSession } from "@/lib/backend-session";
import { isBackendMode } from "@/lib/runtime-config";
import { useModelCompatibilityTest, type ModelTestStatus } from "@/hooks/useModelCompatibilityTest";
import { getEnvMode } from "@/lib/env";
import { findSuggestedReportModel, formatTokenCount } from "@/lib/llm/modelCatalog";
import { LLM_API_STATUS_META } from "@/lib/llm/llmStatusMeta";
import { getCloudStatusMeta } from "@/lib/cloudStatusMeta";
import { resolveActiveLlmPipelineConfig } from "@/lib/llm/providerSettings";
import { getLocalLlmModelProfile } from "@/lib/llm/localModelCatalog";
import { downloadBlob } from "@/lib/export";
import { getDocumentVisibilitySnapshot, useDocumentVisibility } from "@/lib/documentVisibility";
import {
  ActivitySquare,
  Bot,
  Check,
  ChevronDown,
  Cloud,
  Cog,
  Download,
  EllipsisVertical,
  EyeOff,
  KeyRound,
  Loader2,
  LogOut,
  Monitor,
  RotateCw,
} from "lucide-react";

const STATUS_LABELS: Record<string, string> = {
  idle: "Inactif",
  downloading: "Téléchargement modèle",
  loading: "Initialisation",
  ready: "Prêt",
  transcribing: "Transcription en cours",
  stopping: "Arrêt en cours…",
  error: "Erreur",
};

const MODEL_TEST_STATUS_META: Record<ModelTestStatus, { label: string; variant: "default" | "secondary" | "destructive" | "success" | "warning" }> = {
  pending: { label: "En attente", variant: "secondary" },
  testing: { label: "En cours", variant: "warning" },
  ok: { label: "OK", variant: "success" },
  too_large: { label: "Trop gros", variant: "destructive" },
  error: { label: "Erreur", variant: "destructive" },
  skipped: { label: "Non teste", variant: "secondary" },
  unavailable: { label: "Non disponible", variant: "warning" },
};

const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  error: "Erreur",
  warn: "Warn",
  info: "Info",
  debug: "Debug",
};

const LOG_LEVEL_OPTIONS: Array<{ value: LogLevel; label: string }> = [
  { value: "error", label: LOG_LEVEL_LABELS.error },
  { value: "warn", label: LOG_LEVEL_LABELS.warn },
  { value: "info", label: LOG_LEVEL_LABELS.info },
  { value: "debug", label: LOG_LEVEL_LABELS.debug },
];

function buildDiagnosticLogSessionSnapshot(snapshot: ReturnType<typeof useAsrStore.getState>, route: string) {
  return {
    route,
    hasHydrated: snapshot.hasHydrated,
    status: snapshot.status,
    statusDetail: snapshot.statusDetail,
    activePreset: snapshot.activePreset,
    customModelId: snapshot.customModelId,
    backendPreference: snapshot.backendPreference,
    activeBackend: snapshot.activeBackend,
    memoryMode: snapshot.memoryMode,
    segmentationMode: snapshot.segmentationMode,
    chunkStrategy: snapshot.chunkStrategy,
    preprocessingMode: snapshot.preprocessingMode,
    isTranscribing: snapshot.isTranscribing,
    progress: snapshot.progress,
    audioSource: snapshot.audioSource,
    audioMetadata: snapshot.audioMetadata,
    segmentCount: snapshot.segments.length,
    chunkPlanCount: snapshot.chunkPlan.length,
    cloudRunExportHeader: snapshot.runExportHeaders.cloud ?? null,
    browserVisibility: getDocumentVisibilitySnapshot(),
    logLevel: snapshot.logLevel,
    webGpuSupported: snapshot.webGpuSupported,
    wasmAvailable: snapshot.wasmAvailable,
    blockedPresets: snapshot.blockedPresets,
    cloudStatus: snapshot.cloudStatus,
    cloudStatusDetail: snapshot.cloudStatusDetail,
    llmApiStatus: snapshot.llmApiStatus,
    llmApiStatusDetail: snapshot.llmApiStatusDetail,
    llmApiProvider: snapshot.llmApiProvider,
    llmLocalStatus: snapshot.llmLocalStatus,
    llmLocalStatusDetail: snapshot.llmLocalStatusDetail,
    llmLocalModelProfile: snapshot.llmLocalModelProfile,
    wasmThreads: snapshot.wasmThreads,
    telemetryCollectorActive: Boolean(snapshot.telemetryCollector),
    telemetrySummaryAvailable: Boolean(snapshot.telemetrySummary),
  };
}

function buildDiagnosticLogFilename(exportedAt: string) {
  return `demeter-logs-${exportedAt.replace(/[:.]/g, "-")}.json`;
}

type TopbarLogsMenuProps = {
  logLevel: LogLevel;
  onLogLevelChange: (value: LogLevel) => void;
  onExportLogs: () => void;
};

function TopbarLogsMenu({ logLevel, onLogLevelChange, onExportLogs }: TopbarLogsMenuProps) {
  const selectedLabel = LOG_LEVEL_OPTIONS.find((option) => option.value === logLevel)?.label ?? logLevel;

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <DropdownMenu.Root>
          <TooltipTrigger asChild>
            <DropdownMenu.Trigger asChild>
              <Button
                aria-label="Actions de logs"
                className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                size="icon"
                variant="ghost"
              >
                <EllipsisVertical className="h-4 w-4" />
              </Button>
            </DropdownMenu.Trigger>
          </TooltipTrigger>
          <TooltipContent side="bottom">Logs · {selectedLabel}</TooltipContent>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={8}
              className="z-[65] min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
            >
              <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
                Niveau de logs
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup value={logLevel} onValueChange={(value) => onLogLevelChange(value as LogLevel)}>
                {LOG_LEVEL_OPTIONS.map((option) => (
                  <DropdownMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    className="relative flex cursor-pointer select-none items-center rounded-sm py-2 pl-8 pr-2 text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
                  >
                    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                      <DropdownMenu.ItemIndicator>
                        <Check className="h-4 w-4" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                    {option.label}
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                onSelect={() => {
                  onExportLogs();
                }}
              >
                <Download className="h-4 w-4" />
                Télécharger logs
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </Tooltip>
    </TooltipProvider>
  );
}

export function Topbar() {
  const navigate = useNavigate();
  const location = useLocation();
  useBackendPermissions();
  const {
    activePreset,
    backendPreference,
    activeBackend,
    status,
    statusDetail,
    cloudStatus,
    cloudStatusDetail,
    llmApiStatus,
    llmApiStatusDetail,
    llmApiProvider,
    llmApiHfModelId,
    llmApiHfTemperature,
    llmApiHfMaxTokens,
    llmApiMistralModelId,
    llmApiMistralTemperature,
    llmApiMistralMaxTokens,
    llmLocalModelProfile,
    llmLocalStatus,
    llmLocalStatusDetail,
    wasmThreads,
    preprocessingMode,
    telemetryCollector,
  } = useAsrStore();

  const { abortTranscription } = useTranscriptionController();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [consoleLogsOpen, setConsoleLogsOpen] = useState(false);

  const logLevel = useAsrStore((s) => s.logLevel);
  const setLogLevel = useAsrStore((s) => s.setLogLevel);
  const visibilitySnapshot = useDocumentVisibility();
  const lastVisibilityVersionRef = useRef(visibilitySnapshot.version);
  const lastBackgroundTelemetryKeyRef = useRef<string | null>(null);

  const presetLabel =
    activePreset === "custom"
      ? "Modèle personnalisé"
      : MODEL_PRESETS[activePreset].label;
  const backendDisplay = activeBackend ?? backendPreference;
  const backendBadgeVariant: "success" | "warning" = backendDisplay === "webgpu" ? "success" : "warning";
  const backendBadgeLabel = backendDisplay === "webgpu" ? "WebGPU" : "WASM";
  const showPreferenceBadge = activeBackend && activeBackend !== backendPreference;
  const { state: modelTestState, runTest, stopTest, closeSummary, summary } = useModelCompatibilityTest();
  const currentModelLabel = modelTestState.currentPreset ? MODEL_PRESETS[modelTestState.currentPreset].label : null;
  const currentBackendLabel = modelTestState.currentBackend ? modelTestState.currentBackend.toUpperCase() : null;
  const progressPercent =
    typeof modelTestState.progress === "number"
      ? Math.round(Math.max(0, Math.min(1, modelTestState.progress)) * 100)
      : 0;
  const backendKeys = ["webgpu", "wasm"] as const;
  const showDebugActions = true;
  const backendMode = isBackendMode();
  const connectedEmail = backendMode ? (getBackendSession()?.user.email ?? "").trim() : "";
  const showAccountMenu = backendMode && connectedEmail.length > 0;
  const canOpenConsoleLogs = canAccessFeature("feature.telemetry");
  const normalizedPathname = location.pathname.replace(/\/+$/, "") || "/";
  const isLocalUploadRoute = normalizedPathname === "/localupload";
  const canOpenSettings = canAccessFeature("feature.settings");
  const isCloudRoute = location.pathname === "/cloudupload" || location.pathname === "/assistant";
  const isLlmRoute = location.pathname === "/llmapi";
  const isLlmLocalRoute = location.pathname === "/llmlocal";
  const activeLlmPipelineConfig = resolveActiveLlmPipelineConfig(
    {
      llmApiHfModelId,
      llmApiHfTemperature,
      llmApiHfMaxTokens,
      llmApiMistralModelId,
      llmApiMistralTemperature,
      llmApiMistralMaxTokens,
    },
    llmApiProvider
  );
  const cloudStatusMeta = getCloudStatusMeta(cloudStatus);
  const llmStatusMeta = LLM_API_STATUS_META[llmApiStatus];
  const llmLocalStatusMeta = LLM_API_STATUS_META[llmLocalStatus];
  const llmModelId = activeLlmPipelineConfig.modelId.trim();
  const llmSuggestedModel = findSuggestedReportModel(llmModelId);
  const llmModelLabel = llmSuggestedModel?.label ?? (llmModelId || "Modele non defini");
  const llmProviderLabel =
    llmApiProvider === "mistral" ? "Mistral API" : llmApiProvider === "demeter_sante" ? "Demeter Santé" : "HF API";
  const llmLocalProfile = getLocalLlmModelProfile(llmLocalModelProfile);
  const statusLabel = isCloudRoute
    ? cloudStatusMeta.label
    : isLlmRoute
      ? llmStatusMeta.label
      : isLlmLocalRoute
        ? llmLocalStatusMeta.label
      : STATUS_LABELS[status] ?? status;
  const statusDetailLabel = isCloudRoute
    ? cloudStatusDetail
    : isLlmRoute
      ? llmApiStatusDetail
      : isLlmLocalRoute
        ? llmLocalStatusDetail
      : statusDetail;
  const hasLongRunningWork =
    status === "downloading" ||
    status === "loading" ||
    status === "transcribing" ||
    status === "stopping" ||
    cloudStatus === "preprocessing" ||
    cloudStatus === "uploading" ||
    cloudStatus === "transcribing" ||
    cloudStatus === "stopping" ||
    llmApiStatus === "preparing" ||
    llmApiStatus === "generating" ||
    llmApiStatus === "formatting" ||
    llmLocalStatus === "preparing" ||
    llmLocalStatus === "generating" ||
    llmLocalStatus === "formatting";
  const backgroundBadge = visibilitySnapshot.hidden ? (
    <Badge variant="warning" className="gap-1">
      <EyeOff className="h-3 w-3" />
      Arrière-plan
    </Badge>
  ) : null;

  useEffect(() => {
    if (canOpenConsoleLogs || !consoleLogsOpen) {
      return;
    }

    setConsoleLogsOpen(false);
  }, [canOpenConsoleLogs, consoleLogsOpen]);

  useEffect(() => {
    logger.debug("[topbar] debug controls visibility", { showDebugActions, mode: getEnvMode() });
    telemetryCollector?.logEvent?.("TOPBAR_DEBUG_CONTROLS_VISIBILITY", {
      showDebugActions,
      mode: getEnvMode(),
    });
  }, [showDebugActions, telemetryCollector]);

  useEffect(() => {
    logger.debug("[topbar] status snapshot updated", {
      route: location.pathname,
      statusLabel,
      statusDetail: statusDetailLabel ?? null,
      logLevel,
    });
  }, [location.pathname, logLevel, statusDetailLabel, statusLabel]);

  useEffect(() => {
    if (visibilitySnapshot.version === lastVisibilityVersionRef.current) {
      return;
    }

    lastVisibilityVersionRef.current = visibilitySnapshot.version;
    telemetryCollector?.logEvent("VISIBILITY_CHANGE", {
      route: location.pathname,
      visibilityState: visibilitySnapshot.visibilityState,
      hidden: visibilitySnapshot.hidden,
      pageHidden: visibilitySnapshot.pageHidden,
      eventType: visibilitySnapshot.eventType,
      persisted: visibilitySnapshot.persisted,
    });
  }, [
    location.pathname,
    telemetryCollector,
    visibilitySnapshot.eventType,
    visibilitySnapshot.hidden,
    visibilitySnapshot.pageHidden,
    visibilitySnapshot.persisted,
    visibilitySnapshot.version,
    visibilitySnapshot.visibilityState,
  ]);

  useEffect(() => {
    if (!visibilitySnapshot.hidden || !hasLongRunningWork) {
      lastBackgroundTelemetryKeyRef.current = null;
      return;
    }

    const telemetryKey = `${visibilitySnapshot.version}`;
    if (lastBackgroundTelemetryKeyRef.current === telemetryKey) {
      return;
    }
    lastBackgroundTelemetryKeyRef.current = telemetryKey;

    telemetryCollector?.logEvent("BACKGROUND_RUN_CONTINUED", {
      route: location.pathname,
      visibilityState: visibilitySnapshot.visibilityState,
      hidden: visibilitySnapshot.hidden,
      pageHidden: visibilitySnapshot.pageHidden,
      status,
      cloudStatus,
      llmApiStatus,
      llmLocalStatus,
    });
  }, [
    cloudStatus,
    hasLongRunningWork,
    llmApiStatus,
    llmLocalStatus,
    location.pathname,
    status,
    telemetryCollector,
    visibilitySnapshot.hidden,
    visibilitySnapshot.pageHidden,
    visibilitySnapshot.version,
    visibilitySnapshot.visibilityState,
  ]);

  const handleLogLevelChange = (value: string) => {
    logger.info("[topbar] log level changed", { from: logLevel, to: value });
    setLogLevel(value as LogLevel);
  };

  const handleExportLogs = () => {
    const snapshot = useAsrStore.getState();
    const telemetry = snapshot.telemetryCollector?.exportSummary() ?? snapshot.telemetrySummary ?? null;
    logger.info("[topbar] diagnostic log export requested", {
      route: location.pathname,
      logLevel: snapshot.logLevel,
      telemetryAvailable: Boolean(telemetry),
      hydrated: snapshot.hasHydrated,
    });
    const bundle = exportDiagnosticLogBundle({
      session: buildDiagnosticLogSessionSnapshot(snapshot, location.pathname),
      settings: serializePersistedSettings(snapshot),
      telemetry,
    });
    const filename = buildDiagnosticLogFilename(bundle.exportedAt);
    logger.info("[topbar] diagnostic log export prepared", {
      route: location.pathname,
      entryCount: bundle.logs.length,
      filename,
      persistenceStatus: bundle.diagnostics.persistenceStatus,
    });
    downloadBlob(JSON.stringify(bundle, null, 2), filename, "application/json");
    toast("Fichier de logs téléchargé.");
  };

  const handleLogout = async () => {
    logger.info("[topbar] logout requested", { backendMode });
    if (backendMode) {
      await backendLogout();
    } else {
      setAuthenticated(false);
    }
    toast("Déconnecté.");
    logger.info("[topbar] logout completed");
    navigate("/login", { replace: true });
  };

  const handlePasswordChange = async (currentPassword: string, password: string) => {
    logger.info("[topbar] password change requested");
    await backendChangePassword(currentPassword, password);
    toast("Mot de passe modifié.");
    await backendLogout();
    navigate("/login", { replace: true });
  };

  const handleResetApp = async () => {
    logger.warn("[topbar] app reset confirmed");
    setConfirmOpen(false);
    await Promise.resolve(abortTranscription());
    const reset = useAsrStore.getState().resetApp;
    if (typeof reset === "function") {
      reset();
      resetWebGpuSupportCache();
      initializeBackendSupport().then((supported) => {
        logger.info("[topbar] backend support reinitialized after reset", { supported });
        toast(
          supported ? "WebGPU disponible sur ce périphérique." : "WebGPU non disponible; WASM sélectionné si disponible."
        );
        const threads = useAsrStore.getState().wasmThreads;
        if (typeof threads === "number" && threads > 1) {
          toast(`Mode multithread WASM actif (${threads} threads)`);
        }
      });

      logger.info("[topbar] app reset completed");
      toast("Application réinitialisée aux paramètres par défaut.");
    }
  };

  return (
    <>
      <div className="border-b">
        <header className="flex min-h-16 items-center justify-between px-4 py-3">
          {isCloudRoute ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Cloud</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={cloudStatusMeta.variant}>{cloudStatusMeta.label}</Badge>
                {backgroundBadge}
                <Badge variant="outline" className="gap-1">
                  <Cloud className="h-3 w-3" /> Cloud
                </Badge>
              </div>
            </div>
          ) : isLlmRoute ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">LLM Cloud</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={llmStatusMeta.variant}>{llmStatusMeta.label}</Badge>
                {backgroundBadge}
                <Badge variant="outline" className="gap-1">
                  <Cloud className="h-3 w-3" /> {llmProviderLabel}
                </Badge>
                <Badge variant="secondary">{llmModelLabel}</Badge>
                <Badge variant="outline">{`Max ${formatTokenCount(activeLlmPipelineConfig.maxTokens)}`}</Badge>
              </div>
            </div>
          ) : isLlmLocalRoute ? (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Backend</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={backendBadgeVariant}>{backendBadgeLabel}</Badge>
                {backgroundBadge}
                {showPreferenceBadge ? (
                  <Badge variant="outline" className="capitalize">
                    {`Préférence : ${backendPreference}`}
                  </Badge>
                ) : null}
                {backendDisplay === "wasm" ? (
                  <Badge variant={wasmThreads && wasmThreads > 1 ? "success" : "warning"}>
                    {wasmThreads && wasmThreads > 1 ? `multithread (${wasmThreads})` : "single-thread"}
                  </Badge>
                ) : null}
                <Badge variant="outline" className="gap-1">
                  <Bot className="h-3 w-3" /> Local navigateur
                </Badge>
                <Badge variant="secondary">{llmLocalProfile.label}</Badge>
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="text-sm font-medium text-muted-foreground">Backend</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={backendBadgeVariant}>{backendBadgeLabel}</Badge>
                {backgroundBadge}
                {showPreferenceBadge ? (
                  <Badge variant="outline" className="capitalize">
                    {`Préférence : ${backendPreference}`}
                  </Badge>
                ) : null}
                {/* Multithread indicator for WASM */}
                {backendDisplay === "wasm" ? (
                  <Badge variant={wasmThreads && wasmThreads > 1 ? "success" : "warning"}>
                    {wasmThreads && wasmThreads > 1 ? `multithread (${wasmThreads})` : "single-thread"}
                  </Badge>
                ) : null}
                {/* Preprocessing mode badge */}
                <Badge variant={preprocessingMode === "full" ? "success" : "warning"} className="capitalize">
                  {preprocessingMode === "full" ? "Complet" : "Rapide"}
                </Badge>
                <Badge variant="secondary">{presetLabel}</Badge>
                {/* model badge removed per request */}
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <div className={cn("flex flex-col text-right")}>
              <span className="text-sm font-medium leading-tight">{statusLabel}</span>
              {statusDetailLabel ? <span className="text-xs text-muted-foreground">{statusDetailLabel}</span> : null}
            </div>
            {showAccountMenu ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <Button
                    className="max-w-52 justify-between gap-2 sm:max-w-64"
                    size="sm"
                    title={connectedEmail}
                    variant="outline"
                  >
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">{connectedEmail}</span>
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  </Button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    sideOffset={8}
                    className="z-[65] min-w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg outline-none"
                  >
                    <DropdownMenu.Label className="px-2 py-1.5 text-xs text-muted-foreground">
                      {connectedEmail}
                    </DropdownMenu.Label>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                      onSelect={() => {
                        setChangePasswordOpen(true);
                      }}
                    >
                      <KeyRound className="h-4 w-4" />
                      Changer le mot de passe
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
                      onSelect={() => {
                        void handleLogout();
                      }}
                    >
                      <LogOut className="h-4 w-4" />
                      Déconnexion
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
            {canOpenSettings ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Aller aux paramètres"
                onClick={() => navigate(location.pathname === "/settings" ? getFirstAuthorizedRoute() : "/settings")}
              >
                {location.pathname === "/settings" ? (
                  <ActivitySquare className="h-4 w-4" />
                ) : (
                  <Cog className="h-4 w-4" />
                )}
              </Button>
            ) : null}
            {canOpenConsoleLogs ? (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={consoleLogsOpen ? "secondary" : "ghost"}
                      size="icon"
                      className={cn(
                        "shrink-0",
                        consoleLogsOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                      aria-label="Afficher les logs console"
                      aria-controls="topbar-console-logs-panel"
                      aria-expanded={consoleLogsOpen}
                      onClick={() => {
                        setConsoleLogsOpen((value) => !value);
                      }}
                    >
                      <Monitor className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Logs console</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <>
              {showDebugActions ? (
                <TopbarLogsMenu
                  logLevel={logLevel}
                  onLogLevelChange={handleLogLevelChange}
                  onExportLogs={handleExportLogs}
                />
              ) : null}
              {isLocalUploadRoute ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => {
                    logger.info("[topbar] model compatibility test requested");
                    runTest();
                  }}
                  disabled={modelTestState.running}
                >
                  {modelTestState.running ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Tester les modèles
                </Button>
              ) : null}
              <Button
                variant="destructive"
                size="sm"
                className="gap-2"
                onClick={() => {
                  logger.warn("[topbar] app reset requested");
                  setConfirmOpen(true);
                }}
              >
                <RotateCw className="h-4 w-4" />
                Réinitialiser
              </Button>
              <ConfirmDialog
                open={confirmOpen}
                title="Réinitialiser l'application"
                description="Êtes-vous sûr ? Cette action réinitialisera l'application aux paramètres par défaut et supprimera la session en cours."
                onCancel={() => {
                  logger.debug("[topbar] app reset cancelled");
                  setConfirmOpen(false);
                }}
                onConfirm={handleResetApp}
              />
            </>
          </div>
        </header>
        {canOpenConsoleLogs && consoleLogsOpen ? (
          <TopbarConsoleLogsPanel
            open={consoleLogsOpen}
            onClose={() => {
              setConsoleLogsOpen(false);
            }}
          />
        ) : null}
      </div>
      <ChangePasswordDialog
        open={changePasswordOpen}
        onClose={() => {
          setChangePasswordOpen(false);
        }}
        onSubmit={handlePasswordChange}
      />
      {modelTestState.running || modelTestState.summaryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-xs">
          <div className="absolute inset-0 opacity-30">
            <div className="absolute left-0 top-0 h-full w-full animate-pulse bg-linear-to-br from-emerald-500/20 via-sky-500/10 to-amber-400/20" />
          </div>
          <div className="relative mx-4 w-full max-w-4xl rounded-xl border bg-card/95 p-6 shadow-xl">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border bg-muted/60">
                  {modelTestState.running ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Loader2 className="h-6 w-6" />
                  )}
                </div>
                <div>
                  <h3 className="text-lg font-semibold">
                    {modelTestState.running ? "Test de compatibilité des modèles" : "Récapitulatif du test"}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {currentModelLabel
                      ? `Etape ${modelTestState.step}/${modelTestState.total} — ${currentModelLabel}${currentBackendLabel ? ` (${currentBackendLabel})` : ""}`
                      : modelTestState.running
                        ? "Initialisation du test"
                        : "Test terminé — veuillez valider pour fermer"}
                  </p>
                  {modelTestState.progressLabel ? (
                    <p className="text-xs text-muted-foreground">{modelTestState.progressLabel}</p>
                  ) : null}
                  {!modelTestState.running ? (
                    <p className="text-xs text-muted-foreground">
                      OK: {summary.ok} • Bloqués: {summary.blockedCount} • Erreurs: {summary.errors}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="flex flex-col items-end text-right text-xs text-muted-foreground">
                <span>Progression globale</span>
                <span className="text-lg font-semibold text-foreground">{progressPercent}%</span>
                {modelTestState.running ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={stopTest}
                    disabled={modelTestState.stopRequested}
                  >
                    {modelTestState.stopRequested ? "Arrêt demandé" : "Stopper le test"}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={closeSummary}
                  >
                    Valider et fermer
                  </Button>
                )}
              </div>
            </div>
            <div className="mt-4">
              <Progress value={progressPercent} className="h-2" />
            </div>
            <div className="mt-4 grid gap-2 md:grid-cols-2">
              {modelTestState.results.map((result) => (
                <div
                  key={result.preset}
                  className="flex items-center justify-between gap-3 rounded-lg border bg-background/70 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{result.label}</p>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {backendKeys.map((backend, index) => {
                        const entry = result.backends[backend];
                        const meta = MODEL_TEST_STATUS_META[entry.status];
                        const detailParts = [
                          meta.label,
                          typeof entry.durationMs === "number" ? `${(entry.durationMs / 1000).toFixed(1)}s` : null,
                          entry.message ?? null,
                        ]
                          .filter(Boolean)
                          .join(" • ");
                        return (
                          <span key={backend} className={index === 0 ? "mr-2" : ""}>
                            {backend.toUpperCase()}: {detailParts}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {backendKeys.map((backend) => {
                      const entry = result.backends[backend];
                      const meta = MODEL_TEST_STATUS_META[entry.status];
                      return (
                        <Badge key={backend} variant={meta.variant} className="uppercase text-[10px]">
                          {backend}:{meta.label}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Le test charge chaque modèle, essaie plusieurs quantizations par backend, puis lance une mini transcription. Les modèles trop lourds sont bloqués dans le menu.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
