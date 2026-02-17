import { beforeEach, describe, expect, it } from "vitest";
import { TelemetryCollector } from "@/lib/telemetry";
import { emitLlmEvent, ensureLlmTelemetryCollector } from "@/lib/llm/telemetrySession";
import { useAsrStore } from "@/store/asr-store";

describe("llm telemetry session", () => {
  beforeEach(() => {
    const state = useAsrStore.getState();
    state.registerTelemetry(null);
    state.setTelemetrySummary(null);
  });

  it("creates and registers a telemetry collector when missing", () => {
    const collector = ensureLlmTelemetryCollector("llmlocal");
    expect(useAsrStore.getState().telemetryCollector).toBe(collector);
    expect(useAsrStore.getState().telemetrySummary).toBeNull();
  });

  it("reuses existing telemetry collector without overriding it", () => {
    const existing = new TelemetryCollector("existing-llm-collector");
    useAsrStore.getState().registerTelemetry(existing);

    const collector = ensureLlmTelemetryCollector("llmcloud");
    expect(collector).toBe(existing);
    expect(useAsrStore.getState().telemetryCollector).toBe(existing);
  });

  it("emits llm events through the active telemetry collector", () => {
    emitLlmEvent("LLM_LOCAL_PAGE_VIEW", { route: "/llmlocal" });
    const collector = useAsrStore.getState().telemetryCollector;
    expect(collector).toBeTruthy();
    const events = collector?.exportSummary().events.map((event) => event.type) ?? [];
    expect(events).toContain("LLM_LOCAL_PAGE_VIEW");
  });
});
