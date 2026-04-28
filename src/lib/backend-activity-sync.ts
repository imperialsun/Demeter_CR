import { backendFetch, parseBackendJson, readBackendError } from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import { isAuthenticated } from "@/lib/auth";
import logger from "@/lib/logger";
import { loadQueueSnapshot, writeQueueSnapshot } from "@/lib/backend-queue-storage";
import { isBackendMode } from "@/lib/runtime-config";
import { createSecureId } from "@/lib/secure-id";

const ACTIVITY_QUEUE_KEY = "demeter-backend-activity-queue";
const RETRY_DELAY_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;

export type BackendActivityEventKind = "transcription" | "report";
export type BackendActivitySourceMode = "local" | "cloud_direct" | "cloud_backend";
export type BackendActivityStatus = "success" | "error";

export interface BackendActivityTrackInput {
  eventKind: BackendActivityEventKind;
  sourceMode: BackendActivitySourceMode;
  provider: string;
  status: BackendActivityStatus;
  occurredAt?: string;
  meta?: Record<string, unknown>;
}

interface BackendActivityQueuedEvent extends BackendActivityTrackInput {
  eventId: string;
  occurredAt: string;
}

function isBackendActivityQueuedEvent(value: unknown): value is BackendActivityQueuedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    typeof record.eventKind === "string" &&
    typeof record.sourceMode === "string" &&
    typeof record.provider === "string" &&
    typeof record.status === "string" &&
    typeof record.occurredAt === "string"
  );
}

type BackendActivityBatchResult =
  | { kind: "response"; response: Response }
  | { kind: "expired" }
  | { kind: "failed"; response: Response };

let queueLoaded = false;
let queueLoadPromise: Promise<void> | null = null;
let queue: BackendActivityQueuedEvent[] = [];
let listenersReady = false;
let flushInFlight = false;
let retryTimer: number | null = null;
let persistChain: Promise<void> = Promise.resolve();

export function initializeBackendActivitySync() {
  if (!isBackendMode() || typeof window === "undefined" || listenersReady) return;
  listenersReady = true;
  void loadQueue();
  window.addEventListener("online", () => {
    logger.info("[backend-activity-sync] network online, retrying flush");
    void flushBackendActivityQueueNow();
  });
  void flushBackendActivityQueueNow();
}

export function trackBackendActivityEvent(input: BackendActivityTrackInput) {
  if (!isBackendMode() || typeof window === "undefined") return;
  void loadQueue();
  const event: BackendActivityQueuedEvent = {
    eventId: newEventID(),
    eventKind: input.eventKind,
    sourceMode: input.sourceMode,
    provider: input.provider.trim().toLowerCase(),
    status: input.status,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    meta: input.meta,
  };
  queue.push(event);
  persistQueue();
  logger.info("[backend-activity-sync] queued event", {
    eventKind: event.eventKind,
    sourceMode: event.sourceMode,
    provider: event.provider,
    status: event.status,
    queueSize: queue.length,
  });
  void flushBackendActivityQueueNow();
}

export async function flushBackendActivityQueueNow() {
  if (!isBackendMode() || typeof window === "undefined") return;
  if (flushInFlight) return;
  await loadQueue();
  if (queue.length === 0) return;
  if (!isAuthenticated()) {
    logger.info("[backend-activity-sync] flush skipped: not authenticated");
    scheduleRetry();
    return;
  }

  flushInFlight = true;
  clearRetry();

  try {
    while (queue.length > 0 && isAuthenticated()) {
      const batch = queue.slice(0, FLUSH_BATCH_SIZE);
      const result = await sendActivityBatch(batch);
      if (result.kind === "expired") {
        return;
      }
      if (result.kind === "failed") {
        scheduleRetry();
        return;
      }
      const response = result.response;
      if (!response.ok) {
        const message = await readBackendError(response);
        throw new Error(message);
      }

      const payload = await parseBackendJson<{
        accepted?: number;
        duplicates?: number;
        rejected?: Array<{ eventId?: string; reason?: string }>;
      }>(response);

      queue = queue.slice(batch.length);
      persistQueue();

      logger.info("[backend-activity-sync] batch flushed", {
        batchSize: batch.length,
        accepted: payload.accepted ?? 0,
        duplicates: payload.duplicates ?? 0,
        rejected: payload.rejected?.length ?? 0,
        remaining: queue.length,
      });
    }
  } catch (error) {
    logger.warn("[backend-activity-sync] flush failed, scheduling retry", {
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleRetry();
  } finally {
    flushInFlight = false;
  }
}

async function sendActivityBatch(batch: BackendActivityQueuedEvent[]): Promise<BackendActivityBatchResult> {
  const requestBatch = async () =>
    backendFetch("/activity/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ events: batch }),
    });

  let response = await requestBatch();
  if (response.status !== 401) {
    return { kind: "response", response };
  }

  logger.info("[backend-activity-sync] flush unauthorized, attempting refresh");
  const refreshResult = await backendRefresh();
  if (refreshResult !== "refreshed") {
    if (refreshResult === "expired") {
      return { kind: "expired" };
    }
    return { kind: "failed", response };
  }

  response = await requestBatch();
  return { kind: "response", response };
}

async function loadQueue() {
  if (queueLoaded) return;
  if (queueLoadPromise) return queueLoadPromise;
  queueLoadPromise = (async () => {
    queue = await loadQueueSnapshot<BackendActivityQueuedEvent>({
      queueKey: ACTIVITY_QUEUE_KEY,
      legacyStorageKey: ACTIVITY_QUEUE_KEY,
      validateLegacyItem: isBackendActivityQueuedEvent,
      pendingQueue: queue,
    });
    queueLoaded = true;
  })().finally(() => {
    queueLoadPromise = null;
  });
  return queueLoadPromise;
}

function persistQueue() {
  if (typeof window === "undefined") return;
  persistChain = persistChain
    .then(async () => {
      await loadQueue();
      await writeQueueSnapshot(ACTIVITY_QUEUE_KEY, queue);
    })
    .catch((error) => {
      logger.warn("[backend-activity-sync] persist failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

function scheduleRetry() {
  if (typeof window === "undefined" || retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushBackendActivityQueueNow();
  }, RETRY_DELAY_MS);
}

function clearRetry() {
  if (typeof window === "undefined") return;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function newEventID(): string {
  return createSecureId("activity-");
}
