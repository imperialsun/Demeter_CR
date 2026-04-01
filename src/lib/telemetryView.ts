import type { TelemetryEvent } from "@/lib/telemetry";

export type TelemetryScope = "all" | "local" | "cloud" | "llm_local" | "llm_cloud";
export type TelemetryDomain = Exclude<TelemetryScope, "all"> | "unknown";
export type TelemetrySeverity = "error" | "warn" | "info" | "debug";
export type TelemetrySeverityFilter = "all" | TelemetrySeverity;
export type TelemetryDetailTab = "overview" | "timeline" | "performance" | "preprocess" | "alerts";
export type TelemetryLiveMode = "on" | "off";

export interface TelemetryViewEvent {
  key: string;
  index: number;
  event: TelemetryEvent;
  domain: TelemetryDomain;
  severity: TelemetrySeverity;
}

export interface TelemetryKpis {
  total: number;
  errors: number;
  warnings: number;
  droppedEvents: number;
  latestTimestamp: number | null;
}

export interface TelemetryDomainStats {
  domain: TelemetryDomain;
  total: number;
  errors: number;
  warnings: number;
  latestTimestamp: number | null;
  latestErrorType: string | null;
}

export interface TelemetryFilterCriteria {
  scope: TelemetryScope;
  severity: TelemetrySeverityFilter;
  search: string;
}

const LLM_RUN_EVENT_TYPES = new Set(["LLM_RUN_START", "LLM_RUN_STAGE", "LLM_RUN_DONE", "LLM_RUN_ERROR", "LLM_DOCX_DOWNLOAD"]);

const LOCAL_DOMAIN_EVENTS = new Set([
  "RAM_USAGE",
  "MODEL_FETCH",
  "PROGRESS_SEGMENT_PCM",
  "PROGRESS_CONFIDENCE",
  "CALIBRATION_REQUESTED",
  "REQUESTDATA_TIMEOUT",
  "REQUESTDATA_TIMEOUT_RETRY",
  "REQUESTDATA_STALLED_BUT_ALIVE",
  "REQUESTDATA_FALLBACK",
  "VISIBILITY_CHANGE",
  "BACKGROUND_RUN_CONTINUED",
]);

const DOMAIN_ORDER: TelemetryDomain[] = ["local", "cloud", "llm_local", "llm_cloud", "unknown"];

const SCOPE_VALUES: TelemetryScope[] = ["all", "local", "cloud", "llm_local", "llm_cloud"];
const TAB_VALUES: TelemetryDetailTab[] = ["overview", "timeline", "performance", "preprocess", "alerts"];
const SEVERITY_VALUES: TelemetrySeverityFilter[] = ["all", "error", "warn", "info", "debug"];
const LIVE_VALUES: TelemetryLiveMode[] = ["on", "off"];

function isKnownScope(value: string | null | undefined): value is TelemetryScope {
  return Boolean(value && SCOPE_VALUES.includes(value as TelemetryScope));
}

function isKnownTab(value: string | null | undefined): value is TelemetryDetailTab {
  return Boolean(value && TAB_VALUES.includes(value as TelemetryDetailTab));
}

function isKnownSeverity(value: string | null | undefined): value is TelemetrySeverityFilter {
  return Boolean(value && SEVERITY_VALUES.includes(value as TelemetrySeverityFilter));
}

function isKnownLiveMode(value: string | null | undefined): value is TelemetryLiveMode {
  return Boolean(value && LIVE_VALUES.includes(value as TelemetryLiveMode));
}

export function normalizeTelemetryScope(value: string | null | undefined): TelemetryScope {
  return isKnownScope(value) ? value : "all";
}

export function normalizeTelemetryTab(value: string | null | undefined): TelemetryDetailTab {
  return isKnownTab(value) ? value : "overview";
}

export function normalizeTelemetrySeverity(value: string | null | undefined): TelemetrySeverityFilter {
  return isKnownSeverity(value) ? value : "all";
}

export function normalizeTelemetryLiveMode(value: string | null | undefined): TelemetryLiveMode {
  return isKnownLiveMode(value) ? value : "on";
}

export function telemetryEventKey(event: TelemetryEvent, index: number): string {
  return `${event.timestamp}-${index}-${event.type}`;
}

export function resolveTelemetryDomain(event: TelemetryEvent): TelemetryDomain {
  if (event.type.startsWith("LLM_LOCAL_")) return "llm_local";
  if (event.type.startsWith("LLM_CLOUD_")) return "llm_cloud";

  if (LLM_RUN_EVENT_TYPES.has(event.type)) {
    const provider = typeof event.data?.provider === "string" ? event.data.provider : undefined;
    if (provider === "local") return "llm_local";
    if (provider === "huggingface" || provider === "mistral" || provider === "cloud") return "llm_cloud";
    return "unknown";
  }

  if (event.type.startsWith("CLOUD_")) return "cloud";
  if (event.type.startsWith("LOCAL_")) return "local";

  if (
    event.type.startsWith("START_") ||
    event.type.startsWith("END_") ||
    event.type.startsWith("PREPROCESS_") ||
    event.type.startsWith("CHUNK_") ||
    event.type.startsWith("SEGMENT_") ||
    event.type.startsWith("PROGRESSIVE_") ||
    LOCAL_DOMAIN_EVENTS.has(event.type)
  ) {
    return "local";
  }

  return "unknown";
}

export function resolveTelemetrySeverity(event: TelemetryEvent): TelemetrySeverity {
  if (event.type === "LOG_DEBUG") return "debug";
  if (event.type === "LOG_WARN") return "warn";
  if (event.type === "LOG_ERROR") return "error";
  if (event.type === "LOG_INFO") return "info";

  if (event.type === "VISIBILITY_CHANGE") {
    return event.data?.hidden === true || event.data?.pageHidden === true ? "warn" : "info";
  }

  if (event.type === "BACKGROUND_RUN_CONTINUED") {
    return "warn";
  }

  if (event.type === "ERROR" || event.type.endsWith("_ERROR") || event.type.endsWith("_FAILED")) {
    return "error";
  }

  if (
    event.type === "ALERT" ||
    event.type.endsWith("_BLOCKED") ||
    event.type.endsWith("_FALLBACK") ||
    event.type.endsWith("_TIMEOUT") ||
    event.type.endsWith("_RETRY") ||
    event.type.endsWith("_ALIVE")
  ) {
    return "warn";
  }

  return "info";
}

export function enrichTelemetryEvents(events: TelemetryEvent[]): TelemetryViewEvent[] {
  return events.map((event, index) => ({
    event,
    index,
    key: telemetryEventKey(event, index),
    domain: resolveTelemetryDomain(event),
    severity: resolveTelemetrySeverity(event),
  }));
}

function matchesScope(event: TelemetryViewEvent, scope: TelemetryScope): boolean {
  if (scope === "all") return true;
  return event.domain === scope;
}

function matchesSeverity(event: TelemetryViewEvent, severity: TelemetrySeverityFilter): boolean {
  if (severity === "all") return true;
  return event.severity === severity;
}

function matchesSearch(event: TelemetryViewEvent, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (event.event.type.toLowerCase().includes(trimmed)) return true;
  if (event.domain.toLowerCase().includes(trimmed)) return true;
  if (event.severity.toLowerCase().includes(trimmed)) return true;
  if (!event.event.data) return false;

  try {
    return JSON.stringify(event.event.data).toLowerCase().includes(trimmed);
  } catch {
    return false;
  }
}

export function filterTelemetryEvents(events: TelemetryViewEvent[], criteria: TelemetryFilterCriteria): TelemetryViewEvent[] {
  return events.filter((event) => {
    return (
      matchesScope(event, criteria.scope) &&
      matchesSeverity(event, criteria.severity) &&
      matchesSearch(event, criteria.search)
    );
  });
}

export function computeTelemetryKpis(events: TelemetryViewEvent[], droppedEvents: number | undefined): TelemetryKpis {
  let errors = 0;
  let warnings = 0;

  for (const entry of events) {
    if (entry.severity === "error") errors += 1;
    if (entry.severity === "warn") warnings += 1;
  }

  return {
    total: events.length,
    errors,
    warnings,
    droppedEvents: droppedEvents ?? 0,
    latestTimestamp: events.length ? events[events.length - 1]!.event.timestamp : null,
  };
}

export function computeDomainStats(events: TelemetryViewEvent[]): Record<TelemetryDomain, TelemetryDomainStats> {
  const initial = DOMAIN_ORDER.reduce<Record<TelemetryDomain, TelemetryDomainStats>>((acc, domain) => {
    acc[domain] = {
      domain,
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    };
    return acc;
  }, {
    local: {
      domain: "local",
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    },
    cloud: {
      domain: "cloud",
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    },
    llm_local: {
      domain: "llm_local",
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    },
    llm_cloud: {
      domain: "llm_cloud",
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    },
    unknown: {
      domain: "unknown",
      total: 0,
      errors: 0,
      warnings: 0,
      latestTimestamp: null,
      latestErrorType: null,
    },
  });

  for (const entry of events) {
    const stats = initial[entry.domain];
    stats.total += 1;
    stats.latestTimestamp = entry.event.timestamp;
    if (entry.severity === "error") {
      stats.errors += 1;
      stats.latestErrorType = entry.event.type;
    }
    if (entry.severity === "warn") {
      stats.warnings += 1;
    }
  }

  return initial;
}

export function telemetryDomainLabel(domain: TelemetryDomain): string {
  switch (domain) {
    case "local":
      return "Local ASR";
    case "cloud":
      return "Cloud ASR";
    case "llm_local":
      return "LLM Local";
    case "llm_cloud":
      return "LLM Cloud";
    default:
      return "Inconnu";
  }
}

export function telemetryScopeLabel(scope: TelemetryScope): string {
  if (scope === "all") return "Tous domaines";
  return telemetryDomainLabel(scope);
}

export function formatEventTimestamp(timestamp: number | null): string {
  if (timestamp === null || !Number.isFinite(timestamp)) return "—";
  if (timestamp < 1000) return `${Math.round(timestamp)} ms`;
  return `${(timestamp / 1000).toFixed(1)} s`;
}

export function shortSessionId(sessionId: string): string {
  if (!sessionId) return "—";
  return sessionId.length <= 12 ? sessionId : `${sessionId.slice(0, 12)}…`;
}

export function resolveAlertDomain(alertKey: string): TelemetryDomain {
  if (alertKey.startsWith("CLOUD_")) return "cloud";
  if (alertKey.startsWith("LLM_LOCAL_")) return "llm_local";
  if (alertKey.startsWith("LLM_CLOUD_")) return "llm_cloud";
  if (alertKey.startsWith("PREPROCESS_") || alertKey.startsWith("CHUNK_") || alertKey.startsWith("SEGMENT_")) {
    return "local";
  }
  return "unknown";
}
