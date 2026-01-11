import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAsrStore } from "@/store/asr-store";

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
      </CardContent>
    </Card>
  );
}
