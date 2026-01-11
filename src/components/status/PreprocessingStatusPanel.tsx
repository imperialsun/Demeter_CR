import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAsrStore } from "@/store/asr-store";
import { SliderField } from "@/components/ui/SliderField";
import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export function PreprocessingStatusPanel() {
  const { preprocessingStatus, preprocessingProgress } = useAsrStore();

  const labelMap: Record<string, { label: string; variant: "default" | "secondary" | "success" | "warning" | "violet" }> = {
    idle: { label: "Inactif", variant: "secondary" },
    calibrating: { label: "Calibration…", variant: "violet" },
    processing: { label: "Prétraitement", variant: "violet" },
    done: { label: "Terminée", variant: "success" },
  };
  const meta = labelMap[preprocessingStatus] ?? labelMap.idle;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Préprocessing</h3>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <div className="text-xs text-muted-foreground">{Math.round(preprocessingProgress * 100)}%</div>
        </div>
        <Progress value={Math.round(preprocessingProgress * 100)} className="h-2" />
        <p className="text-xs text-muted-foreground">Affiche la progression du prétraitement (calibration + traitement).</p>


        {/* Collapsible manual params section: collapsed by default, sliders always disabled in Upload */}
        <ManualParamsCollapsible />
      </CardContent>
    </Card>
  );
}

function ManualParamsCollapsible() {
  const [open, setOpen] = useState(false);
  const disabled = true; // always disabled in Upload per request

  return (
    <div className="mt-3">
      <button
        className="flex w-full items-center justify-between rounded-md border bg-muted/10 px-3 py-2 text-sm"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <span className="font-medium">Détails</span>
        </div>
        <div className="flex items-center gap-2">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <SliderField
            id="pre-noise-floor"
            label="Noise floor (dB)"
            min={-50}
            max={-5}
            step={1}
            value={useAsrStore.getState().denoiseNoiseFloorDb}
            onChange={(v) => useAsrStore.getState().setDenoiseParams({ denoiseNoiseFloorDb: v })}
            disabled={disabled}
          />
          <SliderField
            id="pre-reduction-db"
            label="Réduction (dB)"
            min={0}
            max={24}
            step={1}
            value={useAsrStore.getState().denoiseReductionDb}
            onChange={(v) => useAsrStore.getState().setDenoiseParams({ denoiseReductionDb: v })}
            disabled={disabled}
          />
          <SliderField
            id="pre-smoothing"
            label="Lissage"
            min={0}
            max={0.99}
            step={0.01}
            value={useAsrStore.getState().denoiseSmoothing}
            onChange={(v) => useAsrStore.getState().setDenoiseParams({ denoiseSmoothing: v })}
            disabled={disabled}
          />
        </div>
      ) : null}
    </div>
  );
}