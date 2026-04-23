import type { AudioMetadata } from "@/lib/audio";
import type { CloudTranscriptionChunkGroup } from "@/lib/cloud/transcriptionChunks";

export type CloudPreparedUploadInfo = {
  provider: "whisper" | "mistral" | "demeter_sante";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  chunkIndex: number;
  totalChunks: number;
};

export type CloudTranscriptionSessionRuntime = {
  selectedFile: File | null;
  previewUrl: string | null;
  audioMetadata: AudioMetadata | null;
  preparedUpload: CloudPreparedUploadInfo | null;
  chunkSummaries: CloudTranscriptionChunkGroup[];
  progress: number;
  isTranscribing: boolean;
  isResettingSession: boolean;
  stopRequested: boolean;
  sessionId: string | null;
};

export type AssistantWorkflowRuntime = {
  diarizationChoice: boolean | null;
  hasTriggeredTranscription: boolean;
  hasTriggeredGeneration: boolean;
  hasConfirmedDiarizationReview: boolean;
  activeChunkId: string | null;
};

export function createDefaultCloudTranscriptionSessionRuntime(): CloudTranscriptionSessionRuntime {
  return {
    selectedFile: null,
    previewUrl: null,
    audioMetadata: null,
    preparedUpload: null,
    chunkSummaries: [],
    progress: 0,
    isTranscribing: false,
    isResettingSession: false,
    stopRequested: false,
    sessionId: null,
  };
}

export function createDefaultAssistantWorkflowRuntime(): AssistantWorkflowRuntime {
  return {
    diarizationChoice: null,
    hasTriggeredTranscription: false,
    hasTriggeredGeneration: false,
    hasConfirmedDiarizationReview: false,
    activeChunkId: null,
  };
}
