import type React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import { customReportTemplateKey, type OrganizationReportTemplate } from "@/lib/report-templates";
import { cn } from "@/lib/utils";
import type { ReportFormat, ReportResult, ReportResultKey } from "@/lib/llm/reportSchema";

const REPORT_FORMATS: Array<{ format: ReportFormat; key: ReportResultKey }> = [
  { format: "CRI", key: "cri" },
  { format: "CRO", key: "cro" },
  { format: "CRS", key: "crs" },
  { format: "CRN", key: "crn" },
];

function buildTemplateDescription(template: OrganizationReportTemplate): string {
  if (template.description) return template.description;
  return template.baseFormat === "CUSTOM"
    ? "Modèle libre de l'organisation"
    : `Modèle personnalisé basé sur ${template.baseFormat}`;
}

function renderInlineMarkdown(value: string) {
  const parts: React.ReactNode[] = [];
  const boldPattern = /\*\*([^*]+(?:\*(?!\*)[^*]+)*)\*\*/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = boldPattern.exec(value)) !== null) {
    if (match.index > lastIndex) {
      parts.push(value.slice(lastIndex, match.index));
    }

    parts.push(
      <strong key={`bold-${match.index}`} className="font-semibold text-foreground">
        {match[1]}
      </strong>
    );
    lastIndex = boldPattern.lastIndex;
  }

  if (lastIndex < value.length) {
    parts.push(value.slice(lastIndex));
  }

  return parts.length > 0 ? parts : value;
}

interface ReportFormatResultsPanelProps {
  results: Partial<Record<ReportResultKey, ReportResult>>;
  enabledFormats: Record<ReportFormat, boolean>;
  onDownload: (format: ReportResultKey) => void;
  title?: string;
  description?: string;
  emptyMessage?: string;
  className?: string;
  showDownloadButton?: boolean;
  customTemplates?: OrganizationReportTemplate[];
}

export function ReportFormatResultsPanel({
  results,
  enabledFormats,
  onDownload,
  title = "Résultats des comptes rendus",
  description = "Chaque carte apparaît dès qu'un format activé est reçu. Seuls les formats activés pour cette génération sont affichés.",
  emptyMessage = "Les résultats apparaîtront ici au fil de la génération.",
  className,
  showDownloadButton = true,
  customTemplates = [],
}: ReportFormatResultsPanelProps) {
  const displayItems = [
    ...REPORT_FORMATS.map((item) => ({
      key: item.key,
      format: item.format,
      label: buildReportFormatLabel(item.format),
      description: buildReportFormatDescription(item.format),
      enabled: enabledFormats[item.format],
    })),
    ...customTemplates.map((template) => ({
      key: customReportTemplateKey(template.id),
      format: template.baseFormat,
      label: template.name,
      description: buildTemplateDescription(template),
      enabled: true,
    })),
  ];
  const visibleItems = displayItems.filter((item) => item.enabled);
  const hasAnyResult = visibleItems.some((item) => Boolean(results[item.key]));

  return (
    <section className={cn("rounded-[1.5rem] border bg-background/70 p-4 shadow-sm", className)}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      {hasAnyResult ? (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {visibleItems.map((item) => {
            const result = results[item.key];
            const report = result?.report;
            const hasResult = Boolean(report);
            return (
              <article
                key={item.key}
                data-testid={`report-result-card-${item.key}`}
                className={cn("rounded-2xl border p-3 transition", hasResult ? "bg-card/80" : "bg-muted/30")}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <h4 className="text-sm font-semibold">{item.label}</h4>
                    <p className="text-xs text-muted-foreground">{item.description}</p>
                  </div>
                  <Badge variant={hasResult ? "success" : "secondary"}>
                    {hasResult ? "Reçu" : "En attente"}
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
                        <p className="line-clamp-3 whitespace-pre-wrap leading-relaxed">
                          {renderInlineMarkdown(section.paragraphs[0] ?? "")}
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs text-muted-foreground">{emptyMessage}</p>
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
                      Télécharger le {item.label} (.docx)
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
