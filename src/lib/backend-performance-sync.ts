import { backendFetch, parseBackendJson, readBackendError } from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import { isAuthenticated } from "@/lib/auth";
import logger from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import type { TelemetrySummary } from "@/lib/telemetry";

const PERFORMANCE_QUEUE_KEY = "demeter-backend-performance-queue";
const RETRY_DELAY_MS = 5_000;
const FLUSH_BATCH_SIZE = 50;

const TRACKED_TIMINGS: Record<string, { component: string; task: string }> = {
  load_model_total: { component: "asr", task: "load_model_total" },
  decode_audio_total: { component: "audio", task: "decode_audio_total" },
  decode_audio_segment_total: { component: "audio", task: "decode_audio_segment_total" },
  cloud_decode_ffmpeg: { component: "cloud", task: "cloud_decode_ffmpeg" },
  cloud_preprocess: { component: "cloud", task: "cloud_preprocess" },
  cloud_transcribe: { component: "cloud", task: "cloud_transcribe" },
  cloud_total: { component: "cloud", task: "cloud_total" },
  llm_local_total: { component: "llm_local", task: "llm_local_total" },
  llm_cloud_total: { component: "llm_cloud", task: "llm_cloud_total" },
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

let queueLoaded = false;
let queue: BackendPerformanceQueuedEvent[] = [];
let listenersReady = false;
let flushInFlight = false;
let retryTimer: number | null = null;

export function initializeBackendPerformanceSync() {
  if (!isBackendMode() || typeof window === "undefined" || listenersReady) return;
  listenersReady = true;
  loadQueue();
  window.addEventListener("online", () => {
    logger.info("[backend-performance-sync] network online, retrying flush");
    void flushBackendPerformanceQueueNow();
  });
  void flushBackendPerformanceQueueNow();
}

export function trackBackendPerformanceEvent(input: BackendPerformanceTrackInput) {
  if (!isBackendMode() || typeof window === "undefined") return;
  if (!Number.isFinite(input.durationMs) || input.durationMs < 0) return;
  loadQueue();
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

  loadQueue();
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
  loadQueue();
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
      const response = await sendPerformanceBatch(batch);

      if (response.status === 401 || response.status === 403) {
        logger.warn("[backend-performance-sync] flush denied by backend", { status: response.status });
        scheduleRetry();
        return;
      }
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

async function sendPerformanceBatch(batch: BackendPerformanceQueuedEvent[]): Promise<Response> {
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
    return response;
  }

  logger.warn("[backend-performance-sync] flush unauthorized, attempting refresh");
  try {
    const refreshed = await backendRefresh();
    if (!refreshed) {
      return response;
    }
  } catch (error) {
    logger.warn("[backend-performance-sync] refresh request failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return response;
  }

  response = await requestBatch();
  return response;
}

function loadQueue() {
  if (queueLoaded || typeof window === "undefined") return;
  queueLoaded = true;
  try {
    const raw = window.localStorage.getItem(PERFORMANCE_QUEUE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    queue = parsed.filter((item): item is BackendPerformanceQueuedEvent => {
      if (!item || typeof item !== "object") return false;
      const record = item as Record<string, unknown>;
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
    });
  } catch (error) {
    logger.warn("[backend-performance-sync] failed to parse queue, resetting", {
      message: error instanceof Error ? error.message : String(error),
    });
    queue = [];
    persistQueue();
  }
}

function persistQueue() {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PERFORMANCE_QUEUE_KEY, JSON.stringify(queue));
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
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
