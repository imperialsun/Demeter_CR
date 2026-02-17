import { describe, expect, it } from "vitest";

import {
  computeDomainStats,
  computeTelemetryKpis,
  enrichTelemetryEvents,
  filterTelemetryEvents,
  normalizeTelemetryLiveMode,
  normalizeTelemetryScope,
  normalizeTelemetrySeverity,
  normalizeTelemetryTab,
  resolveAlertDomain,
} from "@/lib/telemetryView";
import type { TelemetryEvent } from "@/lib/telemetry";

function makeEvent(type: TelemetryEvent["type"], timestamp: number, data?: Record<string, unknown>): TelemetryEvent {
  return { type, timestamp, data };
}

describe("telemetryView", () => {
  it("classifies domains with local/cloud/llm rules", () => {
    const events: TelemetryEvent[] = [
      makeEvent("LOCAL_UPLOAD_PAGE_VIEW", 1),
      makeEvent("CLOUD_UPLOAD_PAGE_VIEW", 2),
      makeEvent("LLM_LOCAL_PAGE_VIEW", 3),
      makeEvent("LLM_CLOUD_PAGE_VIEW", 4),
      makeEvent("LLM_RUN_STAGE", 5, { provider: "local" }),
      makeEvent("LLM_RUN_STAGE", 6, { provider: "huggingface" }),
      makeEvent("AUTH_LOGIN_SUCCESS", 7),
    ];

    const enriched = enrichTelemetryEvents(events);
    expect(enriched.map((item) => item.domain)).toEqual([
      "local",
      "cloud",
      "llm_local",
      "llm_cloud",
      "llm_local",
      "llm_cloud",
      "unknown",
    ]);
  });

  it("filters by scope, severity and search", () => {
    const events = enrichTelemetryEvents([
      makeEvent("LOG_WARN", 1, { context: "low_memory" }),
      makeEvent("LLM_LOCAL_GENERATION_BLOCKED", 2, { reason: "backend" }),
      makeEvent("LLM_CLOUD_DOWNLOAD_DONE", 3, { format: "CRI" }),
    ]);

    const filtered = filterTelemetryEvents(events, {
      scope: "llm_local",
      severity: "warn",
      search: "blocked",
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.event.type).toBe("LLM_LOCAL_GENERATION_BLOCKED");
  });

  it("computes KPI counters and latest timestamp", () => {
    const events = enrichTelemetryEvents([
      makeEvent("LOG_WARN", 10),
      makeEvent("LOG_ERROR", 20),
      makeEvent("LOCAL_UPLOAD_PAGE_VIEW", 30),
    ]);

    const kpis = computeTelemetryKpis(events, 2);
    expect(kpis.total).toBe(3);
    expect(kpis.errors).toBe(1);
    expect(kpis.warnings).toBe(1);
    expect(kpis.droppedEvents).toBe(2);
    expect(kpis.latestTimestamp).toBe(30);
  });

  it("builds domain stats with latest error type", () => {
    const events = enrichTelemetryEvents([
      makeEvent("LOCAL_UPLOAD_PAGE_VIEW", 1),
      makeEvent("ERROR", 2),
      makeEvent("CLOUD_UPLOAD_DONE", 3),
      makeEvent("LLM_CLOUD_GENERATION_BLOCKED", 4),
    ]);

    const stats = computeDomainStats(events);
    expect(stats.local.total).toBe(1);
    expect(stats.local.errors).toBe(0);
    expect(stats.cloud.total).toBe(1);
    expect(stats.llm_cloud.total).toBe(1);
    expect(stats.unknown.total).toBe(1);
    expect(stats.unknown.latestErrorType).toBe("ERROR");
  });

  it("normalizes query params and alert domain mapping", () => {
    expect(normalizeTelemetryScope("llm_local")).toBe("llm_local");
    expect(normalizeTelemetryScope("bad")).toBe("all");
    expect(normalizeTelemetryTab("alerts")).toBe("alerts");
    expect(normalizeTelemetryTab("bad")).toBe("overview");
    expect(normalizeTelemetrySeverity("warn")).toBe("warn");
    expect(normalizeTelemetrySeverity("bad")).toBe("all");
    expect(normalizeTelemetryLiveMode("off")).toBe("off");
    expect(normalizeTelemetryLiveMode("bad")).toBe("on");

    expect(resolveAlertDomain("PREPROCESS_NOISE")).toBe("local");
    expect(resolveAlertDomain("CLOUD_UPLOAD_FAILED")).toBe("cloud");
    expect(resolveAlertDomain("LLM_LOCAL_RESET_FAILED")).toBe("llm_local");
    expect(resolveAlertDomain("UNMAPPED")).toBe("unknown");
  });
});
