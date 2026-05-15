import { useEffect, useId, useMemo, useState } from "react";
import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { useReportTemplates } from "@/hooks/useReportTemplates";
import { buildReportFormatLabel } from "@/lib/llm/reportPrompts";
import logger from "@/lib/logger";
import type { UserReportTemplatePreference } from "@/lib/report-templates";

function buildTemplateFormatBadge(format: UserReportTemplatePreference["template"]["baseFormat"]): string {
  return format === "CUSTOM" ? "Modèle libre" : `Base ${buildReportFormatLabel(format)}`;
}

export default function CustomReportsPage() {
  const { items, loading, error, refresh, setPreference } = useReportTemplates();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const selectedItem = useMemo(
    () => items.find((item) => item.template.id === selectedTemplateId) ?? null,
    [items, selectedTemplateId],
  );

  useEffect(() => {
    if (selectedTemplateId && !selectedItem) {
      setSelectedTemplateId(null);
    }
  }, [selectedItem, selectedTemplateId]);

  const handlePreferenceChange = async (templateId: string, checked: boolean) => {
    try {
      logger.info("[custom-reports] saving template preference", { templateId, enabled: checked });
      await setPreference(templateId, checked);
      logger.info("[custom-reports] saved template preference", { templateId, enabled: checked });
      toast(checked ? "Modèle activé." : "Modèle masqué.");
    } catch (reason) {
      logger.warn("[custom-reports] failed to save template preference", {
        templateId,
        enabled: checked,
        message: reason instanceof Error ? reason.message : String(reason),
      });
      toast(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold">CR personnalisés</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Activez les modèles que vous voulez voir dans Assistant et Rédaction. Les modèles absents sont désactivés par
            l’administrateur de votre organisation.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => void refresh()} disabled={loading}>
          {loading ? "Actualisation..." : "Actualiser"}
        </Button>
      </header>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error.message}
        </div>
      ) : null}

      {items.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map(({ template, enabled }) => (
            <Card key={template.id} className={enabled ? "bg-card/80" : "bg-muted/40"}>
              <CardHeader className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <CardTitle className="text-base">{template.name}</CardTitle>
                    <CardDescription>{template.description || "Modèle personnalisé de l'organisation."}</CardDescription>
                  </div>
                  <Badge variant={enabled ? "success" : "secondary"}>{enabled ? "Visible" : "Masqué"}</Badge>
                </div>
                <Badge variant="outline" className="w-fit">
                  {buildTemplateFormatBadge(template.baseFormat)}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">{template.instructions}</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setSelectedTemplateId(template.id)}>
                  Détails
                </Button>
                <div className="flex items-center justify-between gap-4 rounded-md border bg-background/70 p-3">
                  <Label htmlFor={`custom-report-template-${template.id}`} className="text-sm font-medium">
                    Sélectionnable dans Front User
                  </Label>
                  <Switch
                    id={`custom-report-template-${template.id}`}
                    className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
                    checked={enabled}
                    onCheckedChange={(checked) => {
                      void handlePreferenceChange(template.id, checked);
                    }}
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="rounded-md border border-dashed bg-muted/20 p-8 text-sm text-muted-foreground">
          {loading ? "Chargement des modèles..." : "Aucun modèle personnalisé actif pour votre organisation."}
        </div>
      )}
      {selectedItem ? (
        <ReportTemplateDetailsDialog
          item={selectedItem}
          onClose={() => setSelectedTemplateId(null)}
          onPreferenceChange={handlePreferenceChange}
        />
      ) : null}
    </div>
  );
}

function ReportTemplateDetailsDialog({
  item,
  onClose,
  onPreferenceChange,
}: {
  item: UserReportTemplatePreference;
  onClose: () => void;
  onPreferenceChange: (templateId: string, checked: boolean) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const { template, enabled } = item;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-[91] flex max-h-[90vh] w-full max-w-2xl flex-col rounded-lg border bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b p-6">
          <div className="min-w-0 space-y-2">
            <h3 id={titleId} className="text-lg font-semibold">
              {template.name}
            </h3>
            <p id={descriptionId} className="text-sm text-muted-foreground">
              {template.description || "Modèle personnalisé de l'organisation."}
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{buildTemplateFormatBadge(template.baseFormat)}</Badge>
              <Badge variant={enabled ? "success" : "secondary"}>{enabled ? "Visible" : "Masqué"}</Badge>
            </div>
          </div>
          <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Fermer">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-5 overflow-y-auto p-6">
          <div className="flex items-center justify-between gap-4 rounded-md border bg-background/70 p-3">
            <Label htmlFor={`custom-report-template-modal-${template.id}`} className="text-sm font-medium">
              Activer dans Front User
            </Label>
            <Switch
              id={`custom-report-template-modal-${template.id}`}
              className="bg-red-500 data-[state=checked]:bg-emerald-500 data-[state=unchecked]:bg-red-500"
              checked={enabled}
              onCheckedChange={(checked) => {
                void onPreferenceChange(template.id, checked);
              }}
            />
          </div>

          <section className="space-y-2">
            <h4 className="text-sm font-semibold">Consignes</h4>
            <p className="whitespace-pre-wrap rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
              {template.instructions || "Aucune consigne renseignée."}
            </p>
          </section>

          {template.exampleOutline ? (
            <section className="space-y-2">
              <h4 className="text-sm font-semibold">Structure attendue</h4>
              <p className="whitespace-pre-wrap rounded-md border bg-muted/20 p-4 text-sm text-muted-foreground">
                {template.exampleOutline}
              </p>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
