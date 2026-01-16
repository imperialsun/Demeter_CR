import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useAsrStore } from "@/store/asr-store";

export function SegmentationStatusPanel() {
  const { segmentationStatus, segmentationProgress } = useAsrStore();

  const labelMap: Record<string, { label: string; variant: "default" | "secondary" | "success" | "warning" | "violet" }> = {
    idle: { label: "Inactif", variant: "secondary" },
    segmenting: { label: "Découpage…", variant: "violet" },
    done: { label: "Terminée", variant: "success" },
    error: { label: "Erreur", variant: "warning" },
  };
  const meta = labelMap[segmentationStatus] ?? labelMap.idle;
  const percent = Math.round(segmentationProgress * 100);

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium">Pré-segmentation</h3>
            <Badge variant={meta.variant}>{meta.label}</Badge>
          </div>
          <div className="text-xs text-muted-foreground">{percent}%</div>
        </div>
        <Progress value={percent} className="h-2" />
        <p className="text-xs text-muted-foreground">
          Prépare les segments compressés avant le prétraitement et la transcription.
        </p>
      </CardContent>
    </Card>
  );
}
