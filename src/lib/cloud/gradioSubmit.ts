import type { Client, StatusMessage } from "@gradio/client";
import logger from "@/lib/logger";

export type GradioProgressUpdate = {
  progress: number | null;
  stage?: StatusMessage["stage"];
  desc?: string | null;
  eta?: number | null;
  position?: number | null;
  size?: number | null;
};

type SubmitOptions = {
  onProgress?: (update: GradioProgressUpdate) => void;
  onStatus?: (status: StatusMessage) => void;
  shouldAbort?: () => boolean;
};

function normalizeProgress(value: number) {
  if (!Number.isFinite(value)) return null;
  const normalized = value > 1 ? value / 100 : value;
  return Math.max(0, Math.min(1, normalized));
}

function extractProgress(status: StatusMessage): GradioProgressUpdate {
  const entry = status.progress_data?.find((item) => {
    return typeof item.progress === "number" || (typeof item.index === "number" && typeof item.length === "number");
  });
  let progress: number | null = null;
  if (entry) {
    if (typeof entry.progress === "number") {
      progress = normalizeProgress(entry.progress);
    } else if (typeof entry.index === "number" && typeof entry.length === "number" && entry.length > 0) {
      progress = normalizeProgress((entry.index + 1) / entry.length);
    }
  }
  return {
    progress,
    stage: status.stage,
    desc: entry?.desc ?? null,
    eta: typeof status.eta === "number" ? status.eta : null,
    position: typeof status.position === "number" ? status.position : null,
    size: typeof status.size === "number" ? status.size : null,
  };
}

export async function submitWithProgress<T>(
  client: Client,
  endpoint: string,
  data: unknown[] | Record<string, unknown>,
  options: SubmitOptions = {}
): Promise<{ data: T; progressSeen: boolean }> {
  logger.info("[cloud][gradio] submit start", {
    endpoint,
    payloadType: Array.isArray(data) ? "array" : "object",
    payloadSize: Array.isArray(data) ? data.length : Object.keys(data).length,
  });
  const iterable = client.submit(endpoint, data, undefined, null, true) as AsyncIterable<unknown> & {
    cancel: () => Promise<void>;
  };
  let lastData: T | null = null;
  let progressSeen = false;

  for await (const message of iterable) {
    if (options.shouldAbort?.()) {
      logger.warn("[cloud][gradio] submit aborted by caller", { endpoint });
      await iterable.cancel();
      break;
    }
    const type = (message as { type?: string })?.type;
    if (type === "data") {
      lastData = (message as { data: T }).data;
    }
    if (type === "status") {
      const status = message as StatusMessage;
      options.onStatus?.(status);
      if (status.stage === "error") {
        logger.error("[cloud][gradio] status error", {
          endpoint,
          stage: status.stage,
          code: status.code ?? null,
          message: status.message ?? null,
        });
        throw status;
      }
      const update = extractProgress(status);
      if (typeof update.progress === "number") {
        progressSeen = true;
        options.onProgress?.(update);
      }
    }
  }

  if (lastData === null) {
    logger.error("[cloud][gradio] submit failed: no data returned", { endpoint });
    throw new Error("Gradio submit did not return data");
  }
  logger.info("[cloud][gradio] submit done", { endpoint, progressSeen });
  return { data: lastData, progressSeen };
}
