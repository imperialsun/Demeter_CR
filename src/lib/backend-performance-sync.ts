import { backendFetch, parseBackendJson, readBackendError } from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import { isAuthenticated } from "@/lib/auth";
import logger from "@/lib/logger";
import { loadQueueSnapshot, writeQueueSnapshot } from "@/lib/backend-queue-storage";
import { isBackendMode } from "@/lib/runtime-config";
import type { TelemetrySummary } from "@/lib/telemetry";
import { createSecureId } from "@/lib/secure-id";

const PERFORMANCE_QUEUE_KEY = "demeter-backend-performance-queue";
const RETRY_DELAY_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;

const TRACKED_TIMINGS: Record<string, { component: string; task: string }> = {
  load_model_total: { component: "asr", task: "frontend_model_load" },
  decode_audio_total: { component: "audio", task: "frontend_audio_decode" },
  decode_audio_segment_total: { component: "audio", task: "frontend_audio_segment_decode" },
  cloud_decode_ffmpeg: { component: "cloud", task: "frontend_cloud_decode_ffmpeg" },
  cloud_preprocess: { component: "cloud", task: "frontend_cloud_preprocess" },
  cloud_transcribe: { component: "cloud", task: "frontend_cloud_transcribe" },
  cloud_total: { component: "cloud", task: "frontend_cloud_total" },
  llm_local_total: { component: "llm_local", task: "frontend_llm_local_total" },
  llm_cloud_total: { component: "llm_cloud", task: "frontend_llm_cloud_total" },
};

export type BackendPerformanceStatus = "success" | "error";

export interface BackendPerformanceTrackInput {
  eventId?: string;
  traceId?: string;
  surface?: "frontend";
  component: string;
  task: string;
  status: BackendPerformanceStatus;
  durationMs: number;
  route?: string;
  occurredAt?: string;
  meta?: Record<string, unknown>;
}

export interface BackendPerformanceSummaryContext {
  status: BackendPerformanceStatus;
  route?: string;
  traceId?: string;
  meta?: Record<string, unknown>;
  surface?: "frontend";
}

type BackendPerformanceBatchResult =
  | { kind: "response"; response: Response }
  | { kind: "expired" }
  | { kind: "failed"; response: Response };

interface BackendPerformanceQueuedEvent {
  eventId: string;
  traceId: string;
  surface: "frontend";
  component: string;
  task: string;
  status: BackendPerformanceStatus;
  durationMs: number;
  route: string;
  occurredAt: string;
  meta?: Record<string, unknown>;
}

function isBackendPerformanceQueuedEvent(value: unknown): value is BackendPerformanceQueuedEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.eventId === "string" &&
    typeof record.traceId === "string" &&
    typeof record.component === "string" &&
    typeof record.task === "string" &&
    typeof record.status === "string" &&
    typeof record.durationMs === "number" &&
    typeof record.route === "string" &&
    typeof record.occurredAt === "string"
  );
}

let queueLoaded = false;
let queueLoadPromise: Promise<void> | null = null;
let queue: BackendPerformanceQueuedEvent[] = [];
let listenersReady = false;
let flushInFlight = false;
let retryTimer: number | null = null;
let persistChain: Promise<void> = Promise.resolve();

export function initializeBackendPerformanceSync() {
  if (!isBackendMode() || typeof window === "undefined" || listenersReady) return;
  listenersReady = true;
  void loadQueue();
  window.addEventListener("online", () => {
    logger.info("[backend-performance-sync] network online, retrying flush");
    void flushBackendPerformanceQueueNow();
  });
  void flushBackendPerformanceQueueNow();
}

export function trackBackendPerformanceEvent(input: BackendPerformanceTrackInput) {
  if (!isBackendMode() || typeof window === "undefined") return;
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  void loadQueue();
  const event: BackendPerformanceQueuedEvent = {
    eventId: input.eventId?.trim() || newEventID(),
    traceId: input.traceId?.trim() || newEventID(),
    surface: "frontend",
    component: input.component.trim().toLowerCase() || "frontend",
    task: input.task.trim().toLowerCase() || "unknown",
    status: input.status,
    durationMs: Math.round(input.durationMs),
    route: input.route?.trim() || currentRoutePath(),
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    meta: input.meta,
  };
  queue.push(event);
  persistQueue();
  logger.info("[backend-performance-sync] queued event", {
    component: event.component,
    task: event.task,
    status: event.status,
    durationMs: event.durationMs,
    queueSize: queue.length,
  });
  void flushBackendPerformanceQueueNow();
}

export function trackBackendPerformanceSummary(summary: TelemetrySummary | null | undefined, context: BackendPerformanceSummaryContext) {
  if (!summary) return;
  if (!isBackendMode() || typeof window === "undefined") return;

  const route = context.route?.trim() || currentRoutePath();
  const traceId = context.traceId?.trim() || summary.sessionId;
  const baseMeta = {
    sessionId: summary.sessionId,
    createdAt: summary.createdAt,
    backend: summary.backend,
    modelId: summary.modelId,
    userAgent: summary.userAgent,
    transformersVersion: summary.transformersVersion,
    surface: context.surface ?? "frontend",
    status: context.status,
    ...context.meta,
  };

  const events: BackendPerformanceQueuedEvent[] = [];
  for (const [timingKey, durationMs] of Object.entries(summary.timings)) {
    const descriptor = TRACKED_TIMINGS[timingKey];
    if (!descriptor) continue;
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;

    events.push({
      eventId: newEventID(),
      traceId,
      surface: "frontend",
      component: descriptor.component,
      task: descriptor.task,
      status: context.status,
      durationMs: Math.round(durationMs),
      route,
      occurredAt: summary.createdAt,
      meta: {
        ...baseMeta,
        timingKey,
        timingMs: Math.round(durationMs),
      },
    });
  }

  if (events.length === 0) return;

  void loadQueue();
  queue.push(...events);
  persistQueue();
  logger.info("[backend-performance-sync] queued performance batch", {
    eventCount: events.length,
    traceId,
    route,
    status: context.status,
  });
  void flushBackendPerformanceQueueNow();
}

export async function flushBackendPerformanceQueueNow() {
  if (!isBackendMode() || typeof window === "undefined") return;
  if (flushInFlight) return;
  await loadQueue();
  if (queue.length === 0) return;
  if (!isAuthenticated()) {
    logger.info("[backend-performance-sync] flush skipped: not authenticated");
    scheduleRetry();
    return;
  }

  flushInFlight = true;
  clearRetry();

  try {
    while (queue.length > 0 && isAuthenticated()) {
      const batch = queue.slice(0, FLUSH_BATCH_SIZE);
      const result = await sendPerformanceBatch(batch);
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

      logger.info("[backend-performance-sync] batch flushed", {
        batchSize: batch.length,
        accepted: payload.accepted ?? 0,
        duplicates: payload.duplicates ?? 0,
        rejected: payload.rejected?.length ?? 0,
        remaining: queue.length,
      });
    }
  } catch (error) {
    logger.warn("[backend-performance-sync] flush failed, scheduling retry", {
      message: error instanceof Error ? error.message : String(error),
    });
    scheduleRetry();
  } finally {
    flushInFlight = false;
  }
}

async function sendPerformanceBatch(batch: BackendPerformanceQueuedEvent[]): Promise<BackendPerformanceBatchResult> {
  const requestBatch = async () =>
    backendFetch("/performance/events", {
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

  logger.info("[backend-performance-sync] flush unauthorized, attempting refresh");
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
    queue = await loadQueueSnapshot<BackendPerformanceQueuedEvent>({
      queueKey: PERFORMANCE_QUEUE_KEY,
      legacyStorageKey: PERFORMANCE_QUEUE_KEY,
      validateLegacyItem: isBackendPerformanceQueuedEvent,
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
      await writeQueueSnapshot(PERFORMANCE_QUEUE_KEY, queue);
    })
    .catch((error) => {
      logger.warn("[backend-performance-sync] persist failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
}

function scheduleRetry() {
  if (typeof window === "undefined" || retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    void flushBackendPerformanceQueueNow();
  }, RETRY_DELAY_MS);
}

function clearRetry() {
  if (typeof window === "undefined") return;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function currentRoutePath() {
  if (typeof window === "undefined") return "-";
  const path = window.location.pathname.trim();
  return path || "-";
}

function newEventID(): string {
  return createSecureId("perf-");
}
