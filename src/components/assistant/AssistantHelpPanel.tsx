import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Info } from "lucide-react";

type AssistantHelpSectionConfig = {
  id: string;
  step: string;
  title: string;
  summary: string;
  points: string[];
};

const ASSISTANT_HELP_SECTIONS: AssistantHelpSectionConfig[] = [
  {
    id: "file",
    step: "Étape 1",
    title: "Fichier",
    summary: "Importer un audio et vérifier que la session est bien lancée.",
    points: [
      "Déposez un MP3, WAV ou M4A, ou cliquez pour choisir un fichier.",
      "Vérifiez la durée, le format et la taille affichés sous l’import.",
      "Quand le fichier est chargé, passez à la diarization si vous voulez les morceaux.",
    ],
  },
  {
    id: "diarization",
    step: "Étape 2",
    title: "Diarization",
    summary: "Décider si vous voulez afficher les parties de la réunion détaillées.",
    points: [
      "Cette étape vous permet de choisir si vous voulez voir les parties de la réunion avant de générer les rapports.",
      "Oui, avec parties de la réunion : affiche le détail pour relire qui parle et corriger les speakers si besoin.",
      "Non, version simple : passe directement à la transcription et aux rapports, sans afficher les parties de la réunion.",
      "Oui = plus de contrôle. Non = plus rapide.",
    ],
  },
  {
    id: "transcription",
    step: "Étape 3",
    title: "Transcription",
    summary: "Relire les chunks et corriger les speakers ou le texte si besoin.",
    points: [
      "Ouvrez une partie pour lire les segments et ajuster les speakers.",
      "Les changements sont enregistrés immédiatement dans la session.",
      "Quand tout est bon, validez la revue pour lancer la génération des rapports.",
    ],
  },
  {
    id: "reports",
    step: "Étape 4",
    title: "Rapports",
    summary: "Télécharger la transcription et les trois comptes rendus finaux.",
    points: [
      "Téléchargez la transcription DOCX pour récupérer le texte final avec les bons noms.",
      "Téléchargez CRI, CRO et CRS quand les trois boutons sont visibles.",
      "Si vous repartez de zéro, utilisez « Nouveau fichier » pour relancer le flux.",
    ],
  },
];

export function AssistantHelpPanel() {
  return (
    <section
      id="assistant-help-panel"
      data-testid="assistant-help-panel"
      className="rounded-[1.5rem] border bg-background/70 p-4 shadow-sm"
      aria-label="Aide du mode assistant"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Info className="h-4 w-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold">Aide</h2>
          <p className="text-xs text-muted-foreground">
            Ouvrez une rubrique pour voir quoi faire à chaque étape et ce qui indique que tout est prêt.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {ASSISTANT_HELP_SECTIONS.map((section) => (
          <AssistantHelpSection key={section.id} section={section} />
        ))}
      </div>
    </section>
  );
}

function AssistantHelpSection({ section }: { section: AssistantHelpSectionConfig }) {
  const [open, setOpen] = useState(false);

  return (
    <div data-testid={`assistant-help-section-${section.id}`} className="rounded-2xl border bg-card/60">
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
        aria-expanded={open}
        aria-controls={`assistant-help-section-${section.id}-content`}
        onClick={() => setOpen((value) => !value)}
      >
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="px-2 py-0.5 text-[10px] uppercase tracking-wide">
              {section.step}
            </Badge>
            <span className="font-medium text-foreground">{section.title}</span>
          </div>
          <p className="text-xs text-muted-foreground">{section.summary}</p>
        </div>
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>

      <div
        id={`assistant-help-section-${section.id}-content`}
        className={cn("px-4 pb-4", !open ? "hidden" : "")}
      >
        <ul className="space-y-2 text-sm text-muted-foreground">
          {section.points.map((point) => (
            <li key={point} className="flex items-start gap-2">
              <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
              <span>{point}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
