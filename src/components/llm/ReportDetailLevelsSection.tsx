import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import {
  buildReportDetailLevelLabel,
  buildReportDetailSummary,
  buildReportDetailTargetLabel,
  reportDetailIndexToLevel,
  reportDetailLevelToIndex,
  type ReportDetailLevel,
} from "@/lib/llm/reportDetail";
import type { ReportFormat } from "@/lib/llm/reportSchema";

const REPORT_FORMATS: ReportFormat[] = ["CRI", "CRO", "CRS"];

interface ReportDetailLevelsSectionProps {
  values: Record<ReportFormat, ReportDetailLevel>;
  onChange: (format: ReportFormat, level: ReportDetailLevel) => void;
  title?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
}

export function ReportDetailLevelsSection({
  values,
  onChange,
  title = "Niveau de detail des comptes rendus",
  description = "Les formats CRI, CRO et CRS restent inchanges. Les curseurs ajustent uniquement le niveau de detail du resultat. Si des interlocuteurs sont nommes, leurs noms et leur avis ou position sont cites.",
  className,
  disabled = false,
}: ReportDetailLevelsSectionProps) {
  return (
    <section className={cn("rounded-[1.5rem] border bg-background/70 p-4 shadow-sm", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="mt-4 space-y-4">
        {REPORT_FORMATS.map((format) => (
          <div key={format} data-testid={`report-detail-slider-${format.toLowerCase()}`} className="space-y-2 rounded-2xl border bg-card/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <Label htmlFor={`report-detail-${format.toLowerCase()}`} className="text-sm font-medium">
                  {buildReportFormatLabel(format)}
                </Label>
                <p className="text-xs text-muted-foreground">{buildReportFormatDescription(format)}</p>
              </div>
              <Badge variant="outline" className="shrink-0">
                {buildReportDetailSummary(format, values[format])}
              </Badge>
            </div>

            <input
              id={`report-detail-${format.toLowerCase()}`}
              type="range"
              min={0}
              max={2}
              step={1}
              value={reportDetailLevelToIndex(values[format])}
              onChange={(event) => {
                onChange(format, reportDetailIndexToLevel(Number(event.target.value)));
              }}
              disabled={disabled}
              aria-valuetext={buildReportDetailSummary(format, values[format])}
              className={cn("w-full accent-primary", disabled ? "opacity-60" : "")}
            />

            <div className="grid grid-cols-3 gap-2 text-[11px]">
              {(["standard", "verbose", "exhaustive"] as const).map((level, index) => {
                const currentIndex = reportDetailLevelToIndex(values[format]);
                const selected = currentIndex === index;
                return (
                  <button
                    key={level}
                    type="button"
                    className={cn(
                      "rounded-xl border px-2 py-2 text-left transition",
                      selected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background/60 text-muted-foreground",
                      disabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/60 hover:bg-primary/5"
                    )}
                    disabled={disabled}
                    onClick={() => onChange(format, level)}
                    aria-label={`${buildReportFormatLabel(format)} ${buildReportDetailLevelLabel(level)}`}
                  >
                    <div className="font-medium">{buildReportDetailLevelLabel(level)}</div>
                    <div className="text-muted-foreground">{buildReportDetailTargetLabel(format, level)}</div>
                  </button>
                );
              })}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Cible qualitative: {buildReportDetailTargetLabel(format, values[format])}.
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
