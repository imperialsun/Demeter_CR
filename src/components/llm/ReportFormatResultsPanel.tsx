import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import { cn } from "@/lib/utils";
import type { ReportFormat, ReportResult, ReportResultKey } from "@/lib/llm/reportSchema";

const REPORT_FORMATS: Array<{ format: ReportFormat; key: ReportResultKey }> = [
  { format: "CRI", key: "cri" },
  { format: "CRO", key: "cro" },
  { format: "CRS", key: "crs" },
  { format: "CRN", key: "crn" },
];

interface ReportFormatResultsPanelProps {
  results: Partial<Record<ReportResultKey, ReportResult>>;
  enabledFormats: Record<ReportFormat, boolean>;
  onDownload: (format: ReportResultKey) => void;
  title?: string;
  description?: string;
  emptyMessage?: string;
  className?: string;
  showDownloadButton?: boolean;
}

export function ReportFormatResultsPanel({
  results,
  enabledFormats,
  onDownload,
  title = "Résultats des comptes rendus",
  description = "Chaque carte apparaît dès qu'un format est reçu. Les formats désactivés restent visibles mais sont grisés.",
  emptyMessage = "Les résultats apparaîtront ici au fil de la génération.",
  className,
  showDownloadButton = true,
}: ReportFormatResultsPanelProps) {
  const hasAnyResult = REPORT_FORMATS.some((item) => Boolean(results[item.key]));

  return (
    <section className={cn("rounded-[1.5rem] border bg-background/70 p-4 shadow-sm", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {hasAnyResult ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {REPORT_FORMATS.map((item) => {
            const result = results[item.key];
            const enabled = enabledFormats[item.format];
            const report = result?.report;
            const hasResult = Boolean(report);
            return (
              <article
                key={item.key}
                data-testid={`report-result-card-${item.key}`}
                className={cn(
                  "rounded-2xl border p-3 transition",
                  hasResult ? "bg-card/80" : "bg-muted/30",
                  !enabled ? "opacity-60" : ""
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold">{buildReportFormatLabel(item.format)}</h4>
                    <p className="text-xs text-muted-foreground">{buildReportFormatDescription(item.format)}</p>
                  </div>
                  <Badge variant={hasResult ? "success" : enabled ? "secondary" : "outline"}>
                    {hasResult ? "Reçu" : enabled ? "En attente" : "Désactivé"}
                  </Badge>
                </div>

                {hasResult && result && report ? (
                  <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                    <p className="font-medium text-foreground">{report.title}</p>
                    {report.subtitle ? <p>{report.subtitle}</p> : null}
                    <p>
                      {report.sections.length} section{report.sections.length > 1 ? "s" : ""} •{' '}
                      {new Date(result.generatedAt).toLocaleString("fr-FR")}
                    </p>
                    {report.sections.slice(0, 2).map((section) => (
                      <div key={section.heading} className="space-y-1 rounded-xl border bg-background/60 p-2 text-[11px]">
                        <p className="font-medium text-foreground">{section.heading}</p>
                        <p className="line-clamp-3 whitespace-pre-wrap leading-relaxed">{section.paragraphs[0] ?? ""}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {enabled ? emptyMessage : "Ce format est désactivé pour la prochaine génération."}
                  </p>
                )}

                {showDownloadButton ? (
                  <div className="mt-4">
                    <Button
                      type="button"
                      size="sm"
                      variant="default"
                      className="w-full whitespace-normal text-center leading-tight"
                      disabled={!hasResult}
                      onClick={() => onDownload(item.key)}
                    >
                      Télécharger le {buildReportFormatLabel(item.format)} (.docx)
                    </Button>
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 rounded-2xl border border-dashed bg-muted/20 px-4 py-8 text-sm text-muted-foreground">
          {emptyMessage}
        </div>
      )}
    </section>
  );
}
