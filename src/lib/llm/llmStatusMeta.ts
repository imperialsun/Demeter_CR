import type { LlmApiStatus } from "@/store/asr-store";

export const LLM_API_STATUS_META: Record<
  LlmApiStatus,
  { label: string; variant: "secondary" | "warning" | "default" | "success" | "destructive" }
> = {
  idle: { label: "En attente", variant: "secondary" },
  preparing: { label: "Préparation", variant: "warning" },
  generating: { label: "Génération", variant: "default" },
  formatting: { label: "Mise en forme", variant: "warning" },
  done: { label: "Terminé", variant: "success" },
  error: { label: "Erreur", variant: "destructive" },
};
