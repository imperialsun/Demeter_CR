import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  buildReportDetailLevelLabel,
  buildReportDetailSummary,
  buildReportDetailTargetLabel,
  reportDetailIndexToLevel,
  reportDetailLevelToIndex,
  type ReportDetailLevel,
} from "@/lib/llm/reportDetail";
import { buildReportFormatDescription, buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import type { ReportFormat } from "@/lib/llm/reportSchema";
import type { OrganizationReportTemplate } from "@/lib/report-templates";
import { cn } from "@/lib/utils";

const REPORT_FORMATS: ReportFormat[] = ["CRI", "CRO", "CRS", "CRN"];

interface ReportFormatSwitchesSectionProps {
  values: Record<ReportFormat, boolean>;
  onChange: (format: ReportFormat, value: boolean) => void;
  title?: string;
  description?: string;
  className?: string;
  disabled?: boolean;
  detailValues?: Record<ReportFormat, ReportDetailLevel>;
  onDetailChange?: (format: ReportFormat, level: ReportDetailLevel) => void;
  detailDisabled?: boolean;
  customTemplates?: OrganizationReportTemplate[];
  customTemplateValues?: Record<string, boolean>;
  onCustomTemplateChange?: (templateId: string, value: boolean) => void;
}

export function ReportFormatSwitchesSection({
  values,
  onChange,
  title = "Formats de compte rendu",
  description = "Active ou désactive la génération de chaque format avant de lancer le traitement.",
  className,
  disabled = false,
  detailValues,
  onDetailChange,
  detailDisabled = false,
  customTemplates = [],
  customTemplateValues = {},
  onCustomTemplateChange,
}: ReportFormatSwitchesSectionProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const showDetailControls = Boolean(detailValues && onDetailChange);

  return (
    <section className={cn("rounded-[1.5rem] border bg-background/70 p-4 shadow-sm", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0 text-muted-foreground"
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((value) => !value)}
        >
          {isExpanded ? "Replier" : "Déplier"}
        </Button>
      </div>

      {isExpanded ? (
        <div className="mt-4 space-y-3">
          {REPORT_FORMATS.map((format) => {
            const enabled = values[format];
            return (
              <div
                key={format}
                data-testid={`report-format-switch-${format.toLowerCase()}`}
                className={cn(
                  "rounded-2xl border p-3 transition",
                  enabled ? "bg-card/60" : "bg-muted/30",
                  disabled ? "opacity-60" : ""
                )}
              >
                <div className="flex items-start justify-between gap-4">
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

                {showDetailControls && detailValues && enabled ? (
                  <div className="mt-4 space-y-2 border-t pt-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor={`report-detail-${format.toLowerCase()}`} className="text-xs font-medium text-muted-foreground">
                        Verbosité
                      </Label>
                      <Badge variant="outline" className="shrink-0">
                        {buildReportDetailSummary(format, detailValues[format])}
                      </Badge>
                    </div>

                    <input
                      id={`report-detail-${format.toLowerCase()}`}
                      type="range"
                      min={0}
                      max={2}
                      step={1}
                      value={reportDetailLevelToIndex(detailValues[format])}
                      onChange={(event) => {
                        onDetailChange?.(format, reportDetailIndexToLevel(Number(event.target.value)));
                      }}
                      disabled={disabled || detailDisabled}
                      aria-label={buildReportFormatLabel(format)}
                      aria-valuetext={buildReportDetailSummary(format, detailValues[format])}
                      className={cn("w-full accent-primary", disabled || detailDisabled ? "opacity-60" : "")}
                    />

                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      {(["standard", "verbose", "exhaustive"] as const).map((level, index) => {
                        const currentIndex = reportDetailLevelToIndex(detailValues[format]);
                        const selected = currentIndex === index;
                        const isOptionDisabled = disabled || detailDisabled;
                        return (
                          <button
                            key={level}
                            type="button"
                            className={cn(
                              "rounded-xl border px-2 py-2 text-left transition",
                              selected ? "border-primary bg-primary/10 text-foreground" : "border-border bg-background/60 text-muted-foreground",
                              isOptionDisabled ? "cursor-not-allowed opacity-60" : "hover:border-primary/60 hover:bg-primary/5"
                            )}
                            disabled={isOptionDisabled}
                            onClick={() => onDetailChange?.(format, level)}
                            aria-label={`${buildReportFormatLabel(format)} ${buildReportDetailLevelLabel(level)}`}
                          >
                            <div className="font-medium">{buildReportDetailLevelLabel(level)}</div>
                            <div className="text-muted-foreground">{buildReportDetailTargetLabel(format, level)}</div>
                          </button>
                        );
                      })}
                    </div>

                    <p className="text-[11px] text-muted-foreground">
                      Cible qualitative: {buildReportDetailTargetLabel(format, detailValues[format])}.
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })}
          {customTemplates.length ? (
            <div className="space-y-3 border-t pt-3">
              <div className="space-y-1">
                <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">CR personnalisés</h4>
                <p className="text-xs text-muted-foreground">Modèles activés dans la page CR personnalisés.</p>
              </div>
              {customTemplates.map((template) => {
                const enabled = customTemplateValues[template.id] ?? true;
                return (
                  <div
                    key={template.id}
                    data-testid={`report-template-switch-${template.id}`}
                    className={cn(
                      "rounded-2xl border p-3 transition",
                      enabled ? "bg-card/60" : "bg-muted/30",
                      disabled ? "opacity-60" : ""
                    )}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 space-y-1">
                        <Label htmlFor={`report-template-enabled-${template.id}`} className="text-sm font-medium">
                          {template.name}
                        </Label>
                        <p className="text-xs text-muted-foreground">
                          {template.description || "Modèle personnalisé de l'organisation."}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <Badge variant="outline" className="w-fit">
                            Base {buildReportFormatLabel(template.baseFormat)}
                          </Badge>
                          <Badge variant={enabled ? "success" : "secondary"} className="w-fit">
                            {enabled ? "Généré" : "Ignoré"}
                          </Badge>
                        </div>
                      </div>

                      <Switch
                        id={`report-template-enabled-${template.id}`}
                        checked={enabled}
                        onCheckedChange={(checked) => onCustomTemplateChange?.(template.id, checked)}
                        disabled={disabled || !onCustomTemplateChange}
                        className={cn(
                          enabled
                            ? "bg-emerald-500 data-[state=checked]:bg-emerald-500"
                            : "bg-red-500 data-[state=unchecked]:bg-red-500",
                          disabled ? "opacity-60" : ""
                        )}
                        aria-label={`${template.name} ${enabled ? "activé" : "désactivé"}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
