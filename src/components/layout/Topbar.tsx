import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAsrStore, MODEL_PRESETS, type CloudTranscriptionStatus } from "@/store/asr-store";
import { cn } from "@/lib/utils";
import { ActivitySquare, Cloud, Cog, Loader2, LogOut, RotateCw } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "@/components/ui/use-toast";
import { useEffect, useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { initializeBackendSupport, resetWebGpuSupportCache } from "@/lib/backend-support";
import { exportLogEntries } from "@/lib/logger";
import { setAuthenticated } from "@/lib/auth";
import { useModelCompatibilityTest, type ModelTestStatus } from "@/hooks/useModelCompatibilityTest";
import { getEnvMode, isProdEnv } from "@/lib/env";

const STATUS_LABELS: Record<string, string> = {
  idle: "Inactif",
  downloading: "Téléchargement modèle",
  loading: "Initialisation",
  ready: "Prêt",
  transcribing: "Transcription en cours",
  stopping: "Arrêt en cours…",
  error: "Erreur",
};

const CLOUD_STATUS_META: Record<CloudTranscriptionStatus, { label: string; variant: "default" | "secondary" | "destructive" | "success" | "warning" }> = {
  idle: { label: "En attente", variant: "secondary" },
  preprocessing: { label: "Prétraitement", variant: "warning" },
  uploading: { label: "Envoi cloud", variant: "warning" },
  transcribing: { label: "Transcription", variant: "default" },
  stopping: { label: "Arrêt", variant: "secondary" },
  done: { label: "Terminé", variant: "success" },
  error: { label: "Erreur", variant: "destructive" },
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

export function Topbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    activePreset,
    backendPreference,
    activeBackend,
    status,
    statusDetail,
    cloudStatus,
    cloudStatusDetail,
    wasmThreads,
    preprocessingMode,
    telemetryCollector,
  } = useAsrStore();

  const { abortTranscription } = useTranscriptionController();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const debugConfidence = useAsrStore((s) => s.debugConfidence);
  const setDebugConfidence = useAsrStore((s) => s.setDebugConfidence);

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
  const showDebugActions = !isProdEnv();
  const envMode = getEnvMode();
  const isCloudRoute = location.pathname === "/cloudupload";
  const cloudStatusMeta = CLOUD_STATUS_META[cloudStatus];
  const statusLabel = isCloudRoute ? cloudStatusMeta.label : STATUS_LABELS[status] ?? status;
  const statusDetailLabel = isCloudRoute ? cloudStatusDetail : statusDetail;

  useEffect(() => {
    console.info("Topbar debug controls visibility", { showDebugActions, mode: envMode });
    telemetryCollector?.logEvent?.("TOPBAR_DEBUG_CONTROLS_VISIBILITY", {
      showDebugActions,
      mode: envMode,
    });
  }, [envMode, showDebugActions, telemetryCollector]);

  return (
    <>
    <header className="flex min-h-16 items-center justify-between border-b px-4 py-3">
      {isCloudRoute ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">Cloud</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={cloudStatusMeta.variant}>{cloudStatusMeta.label}</Badge>
            <Badge variant="outline" className="gap-1">
              <Cloud className="h-3 w-3" /> Cloud
            </Badge>
          </div>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">Backend</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={backendBadgeVariant}>
              {backendBadgeLabel}
            </Badge>
            {showPreferenceBadge ? (
              <Badge variant="outline" className="capitalize">
                {`Préférence : ${backendPreference}`}
              </Badge>
            ) : null}
            {/* Multithread indicator for WASM */}
            {backendDisplay === "wasm" ? (
              <Badge variant={wasmThreads && wasmThreads > 1 ? 'success' : 'warning'}>
                {wasmThreads && wasmThreads > 1 ? `multithread (${wasmThreads})` : 'single-thread'}
              </Badge>
            ) : null}
            {/* Preprocessing mode badge */}
            <Badge variant={preprocessingMode === 'full' ? 'success' : 'warning'} className="capitalize">
              {preprocessingMode === 'full' ? 'Complet' : 'Rapide'}
            </Badge>
            <Badge variant="secondary">{presetLabel}</Badge>
            {/* model badge removed per request */}
          </div>
        </div>
      )}
      <div className="flex items-center gap-3">
        <div className={cn("flex flex-col text-right")}> 
          <span className="text-sm font-medium leading-tight">
            {statusLabel}
          </span>
          {statusDetailLabel ? (
            <span className="text-xs text-muted-foreground">{statusDetailLabel}</span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Aller aux paramètres"
          onClick={() => navigate(location.pathname === "/settings" ? "/localupload" : "/settings")}
        >
          {location.pathname === "/settings" ? (
            <ActivitySquare className="h-4 w-4" />
          ) : (
            <Cog className="h-4 w-4" />
          )}
        </Button>
        <>
          {showDebugActions ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={async () => {
                const snapshot = useAsrStore.getState();
                const telemetry = snapshot.telemetryCollector?.exportSummary() ?? snapshot.telemetrySummary ?? null;
                const payload = {
                  exportedAt: new Date().toISOString(),
                  session: {
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
                  },
                  telemetry,
                  logs: exportLogEntries(),
                };
                const text = JSON.stringify(payload, null, 2);
                try {
                  await navigator.clipboard.writeText(text);
                  toast("Logs copiés dans le presse-papiers.");
                } catch (error) {
                  void error;
                  if (typeof window !== "undefined") {
                    window.prompt("Copiez les logs ci-dessous :", text);
                  }
                }
              }}
            >
              Exporter logs
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => runTest()}
            disabled={modelTestState.running}
          >
            {modelTestState.running ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            Tester les modèles
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => {
              setAuthenticated(false);
              toast("Déconnecté.");
              navigate("/login", { replace: true });
            }}
          >
            <LogOut className="h-4 w-4" />
            Déconnexion
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="gap-2"
            onClick={() => setConfirmOpen(true)}
          >
            <RotateCw className="h-4 w-4" />
            Réinitialiser
          </Button>

        {showDebugActions ? (
          <>
            {/* Debug toggle for confidence breakdown (hidden in production) */}
            <Button
              size="sm"
              variant={debugConfidence ? 'destructive' : 'outline'}
              onClick={() => setDebugConfidence(!debugConfidence)}
              className="gap-2"
            >
              {debugConfidence ? 'Debug conf : ON' : 'Debug conf : OFF'}
            </Button>
          </>
        ) : null}

          <ConfirmDialog
            open={confirmOpen}
            title="Réinitialiser l'application"
            description="Êtes-vous sûr ? Cette action réinitialisera l'application aux paramètres par défaut et supprimera la session en cours."
            onCancel={() => setConfirmOpen(false)}
            onConfirm={async () => {
              setConfirmOpen(false);
              // abort transcription if it's running
              await Promise.resolve(abortTranscription());
              const reset = useAsrStore.getState().resetApp;
              if (typeof reset === "function") {
                reset();
                // Reset cached detection and re-run backend support checks like on startup
                resetWebGpuSupportCache();
                initializeBackendSupport().then((supported) => {
                  toast(
                    supported ? "WebGPU disponible sur ce périphérique." : "WebGPU non disponible; WASM sélectionné si disponible."
                  );
                  // Show multithread status if detected (only show positive info to avoid noisy toasts)
                  const threads = useAsrStore.getState().wasmThreads;
                  if (typeof threads === 'number' && threads > 1) {
                    toast(`Mode multithread WASM actif (${threads} threads)`);
                  }
                });

                toast("Application réinitialisée aux paramètres par défaut.");
              }
            }}
          />
        </>
      </div>
    </header>
      {modelTestState.running || modelTestState.summaryOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 backdrop-blur-sm">
          <div className="absolute inset-0 opacity-30">
            <div className="absolute left-0 top-0 h-full w-full animate-pulse bg-gradient-to-br from-emerald-500/20 via-sky-500/10 to-amber-400/20" />
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
              Le test charge chaque modèle et lance une mini transcription. Les modèles trop lourds sont bloqués dans le menu.
            </p>
          </div>
        </div>
      ) : null}
    </>
  );
}
