import type { LlmApiStatus } from "@/store/asr-store";

export const LLM_API_STATUS_META: Record<
  LlmApiStatus,
  { label: string; variant: "secondary" | "warning" | "default" | "success" | "destructive" }
> = {
  idle: { label: "En attente", variant: "secondary" },
  preparing: { label: "Preparation", variant: "warning" },
  generating: { label: "Generation", variant: "default" },
  formatting: { label: "Mise en forme", variant: "warning" },
  done: { label: "Termine", variant: "success" },
  error: { label: "Erreur", variant: "destructive" },
};
