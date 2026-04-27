import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import type { ReportFormat } from "@/lib/llm/reportSchema";
import { cn } from "@/lib/utils";

const REPORT_FORMATS: ReportFormat[] = ["CRI", "CRO", "CRS", "CRN"];

interface ReportFormatSwitchesSectionProps {
  values: Record<ReportFormat, boolean>;
  onChange: (format: ReportFormat, value: boolean) => void;
  title?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
}

export function ReportFormatSwitchesSection({
  values,
  onChange,
  title = "Formats de compte rendu",
  description = "Active ou désactive la génération de chaque format avant de lancer le traitement.",
  className,
  disabled = false,
}: ReportFormatSwitchesSectionProps) {
  return (
    <section className={cn("rounded-[1.5rem] border bg-background/70 p-4 shadow-sm", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="mt-4 space-y-3">
        {REPORT_FORMATS.map((format) => {
          const enabled = values[format];
          return (
            <div
              key={format}
              data-testid={`report-format-switch-${format.toLowerCase()}`}
              className={cn(
                "flex items-start justify-between gap-4 rounded-2xl border p-3 transition",
                enabled ? "bg-card/60" : "bg-muted/30",
                disabled ? "opacity-60" : ""
              )}
            >
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`report-format-enabled-${format.toLowerCase()}`} className="text-sm font-medium">
                  {buildReportFormatLabel(format)}
                </Label>
                <p className="text-xs text-muted-foreground">{buildReportFormatDescription(format)}</p>
                <Badge variant={enabled ? "success" : "secondary"} className="w-fit">
                  {enabled ? "Généré" : "Ignoré"}
                </Badge>
              </div>

              <Switch
                id={`report-format-enabled-${format.toLowerCase()}`}
                checked={enabled}
                onCheckedChange={(checked) => onChange(format, checked)}
                disabled={disabled}
                className={cn(
                  enabled
                    ? "bg-emerald-500 data-[state=checked]:bg-emerald-500"
                    : "bg-red-500 data-[state=unchecked]:bg-red-500",
                  disabled ? "opacity-60" : ""
                )}
                aria-label={`${buildReportFormatLabel(format)} ${enabled ? "activé" : "désactivé"}`}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
