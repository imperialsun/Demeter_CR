export type TelemetryEventType =
  | "START_INIT"
  | "START_LOAD_MODEL"
  | "PROGRESS_MODEL"
  | "READY"
  | "START_DECODE"
  | "END_DECODE"
  | "START_CHUNK"
  | "END_CHUNK"
  | "SKIP_CHUNK"
  | "MEMORY_SUMMARY"
  | "REQUESTDATA_TIMEOUT"
  | "REQUESTDATA_FALLBACK"
  | "MODEL_FETCH"
  | "CACHE_CLEARED"
  | "CACHE_STATS_CALC_START"
  | "CACHE_STATS_CALC_DONE"
  | "CACHE_STATS_CALC_ERROR"
  | "ALERT"
  | "STOP_REQUESTED"
  | "STOPPED"
  | "ERROR"
  | "PREPROCESS_START"
  | "PREPROCESS_FILTERS"
  | "PREPROCESS_NORMALIZE"
  | "PREPROCESS_LUFS"
  | "PREPROCESS_NOISE_PROFILE"
  | "PREPROCESS_GATE"
  | "PREPROCESS_OVERLAP"
  | "PREPROCESS_LIMITER"
  | "PREPROCESS_DONE"
  | "PREPROCESS_AUTOTUNE"
  | "CALIBRATION_REQUESTED"
  | "RAM_USAGE"
  | "PROGRESSIVE_SEGMENT_PLAN"
  | "PROGRESSIVE_SEGMENT_START"
  | "PROGRESSIVE_SEGMENT_DONE"
  | "SEGMENT_DEDUP"
  | "CHUNK_PLAN"
  | "PROGRESS_SEGMENT_PCM"
  | "SEGMENT_CACHE_START"
  | "SEGMENT_CACHE_PROGRESS"
  | "SEGMENT_CACHE_DONE"
  | "FFMPEG_LOAD_START"
  | "FFMPEG_LOAD_DONE"
  | "FFMPEG_LOAD_ERROR"
  | "PROGRESS_CONFIDENCE"
  | "AUTH_LOGIN_ATTEMPT"
  | "AUTH_LOGIN_FAILED"
  | "AUTH_LOGIN_SUCCESS"
  | "LOCAL_UPLOAD_PAGE_VIEW"
  | "LOCAL_UPLOAD_PRIVACY_NOTE_TOGGLE"
  | "CONSOLE_GUARD_INSTALLED"
  | "SETTINGS_PANEL_VIEW"
  | "SETTINGS_MIC_SECTION_VISIBILITY"
  | "TOPBAR_DEBUG_CONTROLS_VISIBILITY"
  | "MODEL_COMPAT_TEST_START"
  | "MODEL_COMPAT_WEBGPU_SUPPORT"
  | "MODEL_COMPAT_SKIP"
  | "MODEL_COMPAT_BACKEND_START"
  | "MODEL_COMPAT_PROGRESS"
  | "MODEL_COMPAT_OK"
  | "MODEL_COMPAT_STOPPED"
  | "MODEL_COMPAT_TEST_DONE"
  | "MODEL_COMPAT_SUMMARY_CLOSED"
  | "WASM_MULTITHREAD_AVAILABLE"
  | "WASM_MULTITHREAD_TEST"
  | "WASM_MEMORY_MEASURE_FAILED";

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: number;
  data?: Record<string, unknown>;
}

export interface ChunkTelemetry {
  id: string;
  index: number;
  startSec: number;
  endSec: number;
  transcriptionMs: number;
  realtimeFactor: number;
  text?: string;
}

export interface TelemetrySnapshot {
  label: string;
  timestamp: number;
  usedJSHeapSize?: number;
  totalJSHeapSize?: number;
}

export interface TelemetrySummary {
  sessionId: string;
  createdAt: string;
  userAgent: string;
  transformersVersion: string;
  backend: string;
  modelId: string;
  timings: Record<string, number>;
  chunks: ChunkTelemetry[];
  events: TelemetryEvent[];
  memorySnapshots: TelemetrySnapshot[];
  alerts: Record<string, { count: number; lastTimestamp: number; lastData?: Record<string, unknown> }>;
}

let transformersVersion = "unknown";

export function setTransformersVersion(version: string) {
  transformersVersion = version;
}

export function getTransformersVersion() {
  return transformersVersion;
}

export class TelemetryCollector {
  private readonly sessionId: string;
  private readonly events: TelemetryEvent[] = [];
  private readonly timings = new Map<string, number>();
  private readonly timeStarts = new Map<string, number>();
  private readonly chunkMetrics: ChunkTelemetry[] = [];
  private readonly snapshots: TelemetrySnapshot[] = [];
  private readonly alerts = new Map<string, { count: number; lastTimestamp: number; lastData?: Record<string, unknown> }>();
  private backend: string = "auto";
  private modelId: string = "";

  constructor(sessionId: string = crypto.randomUUID()) {
    this.sessionId = sessionId;
    this.logEvent("START_INIT");
  }

  setRuntimeContext(context: { backend: string; modelId: string }) {
    this.backend = context.backend;
    this.modelId = context.modelId;
  }

  logEvent(type: TelemetryEventType, data?: Record<string, unknown>) {
    this.events.push({ type, timestamp: performance.now(), data });
  }

  startTimer(label: string) {
    this.timeStarts.set(label, performance.now());
  }

  stopTimer(label: string) {
    const start = this.timeStarts.get(label);
    if (typeof start === "number") {
      this.timings.set(label, performance.now() - start);
      this.timeStarts.delete(label);
    }
  }

  pushChunkMetric(metric: ChunkTelemetry) {
    this.chunkMetrics.push(metric);
  }

  /**
   * Record an alert for important fallback conditions. Increments a counter and
   * logs an `ALERT` telemetry event for later analysis.
   */
  recordAlert(alertType: string, data?: Record<string, unknown>) {
    const now = performance.now();
    const existing = this.alerts.get(alertType);
    const newCount = (existing?.count ?? 0) + 1;
    this.alerts.set(alertType, { count: newCount, lastTimestamp: now, lastData: data });
    // Also emit an ALERT event for visibility in the event stream
    this.logEvent("ALERT", { alertType, count: newCount, ...data });
  }

  snapshotMemory(label: string) {
    if (typeof performance === "undefined" || !("memory" in performance)) {
      return;
    }
    const { memory } = performance as unknown as {
      memory: { usedJSHeapSize: number; totalJSHeapSize: number };
    };
    this.snapshots.push({
      label,
      timestamp: performance.now(),
      usedJSHeapSize: Math.round(memory.usedJSHeapSize / (1024 * 1024)),
      totalJSHeapSize: Math.round(memory.totalJSHeapSize / (1024 * 1024)),
    });
  }

  exportSummary(): TelemetrySummary {
    const alerts: Record<string, { count: number; lastTimestamp: number; lastData?: Record<string, unknown> }> = {};
    for (const [key, val] of this.alerts.entries()) {
      alerts[key] = { count: val.count, lastTimestamp: val.lastTimestamp, lastData: val.lastData };
    }
    return {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "unknown",
      transformersVersion,
      backend: this.backend,
      modelId: this.modelId,
      timings: Object.fromEntries(this.timings.entries()),
      chunks: this.chunkMetrics,
      events: this.events,
      memorySnapshots: this.snapshots,
      alerts,
    };
  }

  exportJson(): string {
    return JSON.stringify(this.exportSummary(), null, 2);
  }
}
