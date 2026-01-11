import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAsrStore, resolveModelId, MODEL_PRESETS } from "@/store/asr-store";
import { cn } from "@/lib/utils";
import { ActivitySquare, Cog, RotateCw } from "lucide-react";
import { useNavigate, useLocation } from "react-router-dom";
import { toast } from "@/components/ui/use-toast";
import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useTranscriptionController } from "@/hooks/useTranscriptionController";
import { initializeBackendSupport, resetWebGpuSupportCache } from "@/lib/backend-support";

const STATUS_LABELS: Record<string, string> = {
  idle: "Inactif",
  downloading: "Téléchargement modèle",
  loading: "Initialisation",
  ready: "Prêt",
  transcribing: "Transcription en cours",
  stopping: "Arrêt en cours…",
  error: "Erreur",
};

export function Topbar() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    activePreset,
    customModelId,
    backendPreference,
    activeBackend,
    status,
    statusDetail,
    wasmThreads,
  } =
    useAsrStore();

  const { abortTranscription } = useTranscriptionController();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const modelId = resolveModelId(activePreset, customModelId);
  const presetLabel =
    activePreset === "custom"
      ? "Modèle personnalisé"
      : MODEL_PRESETS[activePreset].label;
  const backendDisplay = activeBackend ?? backendPreference;
  const backendBadgeVariant: "success" | "warning" = backendDisplay === "webgpu" ? "success" : "warning";
  const backendBadgeLabel = backendDisplay === "webgpu" ? "WebGPU" : "WASM";
  const showPreferenceBadge = activeBackend && activeBackend !== backendPreference;

  return (
    <header className="flex h-16 items-center justify-between border-b px-4">
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
          <Badge variant="secondary">{presetLabel}</Badge>
          <Badge variant="default">{modelId}</Badge>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className={cn("flex flex-col text-right")}> 
          <span className="text-sm font-medium leading-tight">
            {STATUS_LABELS[status] ?? status}
          </span>
          {statusDetail ? (
            <span className="text-xs text-muted-foreground">{statusDetail}</span>
          ) : null}
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Aller aux paramètres"
          onClick={() => navigate(location.pathname === "/settings" ? "/upload" : "/settings")}
        >
          {location.pathname === "/settings" ? (
            <ActivitySquare className="h-4 w-4" />
          ) : (
            <Cog className="h-4 w-4" />
          )}
        </Button>
        <>
          <Button
            variant="destructive"
            size="sm"
            className="gap-2"
            onClick={() => setConfirmOpen(true)}
          >
            <RotateCw className="h-4 w-4" />
            Réinitialiser
          </Button>

          <ConfirmDialog
            open={confirmOpen}
            title="Réinitialiser l'application"
            description="Êtes-vous sûr ? Cette action réinitialisera l'application aux paramètres par défaut et supprimera la session en cours."
            onCancel={() => setConfirmOpen(false)}
            onConfirm={() => {
              setConfirmOpen(false);
              // abort transcription if it's running
              abortTranscription();
              const reset = useAsrStore.getState().resetApp;
              if (typeof reset === "function") {
                reset();
                // Reset cached detection and re-run backend support checks like on startup
                resetWebGpuSupportCache();
                initializeBackendSupport().then((supported) => {
                  toast(
                    supported ? "WebGPU disponible sur ce périphérique." : "WebGPU non disponible; WASM sélectionné si disponible."
                  );
                });

                toast("Application réinitialisée aux paramètres par défaut.");
              }
            }}
          />
        </>
      </div>
    </header>
  );
}
