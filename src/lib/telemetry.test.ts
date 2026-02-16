import { describe, expect, it } from "vitest";
import { TelemetryCollector } from "@/lib/telemetry";

describe("telemetry", () => {
  it("caps events and tracks dropped count", () => {
    const collector = new TelemetryCollector("telemetry-cap-test");

    for (let index = 0; index < 5100; index += 1) {
      collector.logEvent("LOG_INFO", { index });
    }

    const summary = collector.exportSummary();
    expect(summary.events.length).toBe(5000);
    expect(summary.droppedEvents).toBe(101);

    const lastEvent = summary.events[summary.events.length - 1];
    expect(lastEvent?.data?.index).toBe(5099);
  });

  it("keeps droppedEvents undefined when no event was dropped", () => {
    const collector = new TelemetryCollector("telemetry-no-drop-test");
    collector.logEvent("LLM_RUN_START", { provider: "huggingface" });

    const summary = collector.exportSummary();
    expect(summary.droppedEvents).toBeUndefined();
  });
});
