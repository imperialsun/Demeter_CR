import { TelemetryCollector, type TelemetryEventType } from "@/lib/telemetry";
import { useAsrStore } from "@/store/asr-store";

export type LlmTelemetryScope = "llmlocal" | "llmcloud";

export function ensureLlmTelemetryCollector(scope: LlmTelemetryScope): TelemetryCollector {
  void scope;
  const state = useAsrStore.getState();
  const existing = state.telemetryCollector;
  if (existing) {
    return existing;
  }

  const telemetry = new TelemetryCollector();
  state.registerTelemetry(telemetry);
  state.setTelemetrySummary(null);
  return telemetry;
}

export function emitLlmEvent(type: TelemetryEventType, data?: Record<string, unknown>) {
  const scope = inferScopeFromEvent(type);
  const telemetry = ensureLlmTelemetryCollector(scope);
  telemetry.logEvent(type, data);
}

function inferScopeFromEvent(type: TelemetryEventType): LlmTelemetryScope {
  if (type.startsWith("LLM_LOCAL_")) {
    return "llmlocal";
  }
  return "llmcloud";
}
