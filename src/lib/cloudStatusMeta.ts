import type { CloudTranscriptionStatus } from "@/store/asr-store";

export type CloudStatusVariant = "default" | "secondary" | "destructive" | "success" | "warning";

export interface CloudStatusMeta {
  label: string;
  variant: CloudStatusVariant;
}

export const CLOUD_STATUS_META: Record<CloudTranscriptionStatus, CloudStatusMeta> = {
  idle: { label: "En attente", variant: "secondary" },
  preprocessing: { label: "Préparation", variant: "warning" },
  uploading: { label: "Envoi cloud", variant: "warning" },
  queued: { label: "File d'attente", variant: "warning" },
  transcribing: { label: "Transcription", variant: "default" },
  stopping: { label: "Arrêt", variant: "secondary" },
  done: { label: "Terminé", variant: "success" },
  error: { label: "Erreur", variant: "destructive" },
};

export function getCloudStatusMeta(status: CloudTranscriptionStatus): CloudStatusMeta {
  return CLOUD_STATUS_META[status];
}

export function getCloudProgressTitleLabel(status: CloudTranscriptionStatus): string | null {
  switch (status) {
    case "preprocessing":
    case "uploading":
    case "queued":
    case "transcribing":
      return CLOUD_STATUS_META[status].label;
    default:
      return null;
  }
}
