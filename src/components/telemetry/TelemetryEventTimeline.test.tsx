import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TelemetryEventTimeline } from "@/components/telemetry/TelemetryEventTimeline";
import type { TelemetryViewEvent } from "@/lib/telemetryView";

function makeTimelineEvent(index: number, type: string): TelemetryViewEvent {
  return {
    key: `evt-${index}`,
    index,
    domain: "local",
    severity: "info",
    event: {
      type: type as TelemetryViewEvent["event"]["type"],
      timestamp: index * 10,
      data: { index },
    },
  };
}

describe("TelemetryEventTimeline", () => {
  const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 250,
    });
  });

  afterEach(() => {
    if (originalScrollHeight) {
      Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      return;
    }
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  });

  it("autoscrolls to latest event when live mode is on", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <TelemetryEventTimeline
        events={[makeTimelineEvent(1, "LOCAL_UPLOAD_PAGE_VIEW")]}
        selectedEventKey={null}
        liveMode="on"
        onSelectEvent={onSelect}
      />
    );

    rerender(
      <TelemetryEventTimeline
        events={[makeTimelineEvent(1, "LOCAL_UPLOAD_PAGE_VIEW"), makeTimelineEvent(2, "LOG_INFO")]}
        selectedEventKey={null}
        liveMode="on"
        onSelectEvent={onSelect}
      />
    );

    const scrollContainer = screen.getByTestId("telemetry-timeline-scroll");
    expect(scrollContainer.scrollTop).toBe(250);
  });

  it("forwards event selection callback", () => {
    const onSelect = vi.fn();
    render(
      <TelemetryEventTimeline
        events={[makeTimelineEvent(1, "LOCAL_UPLOAD_PAGE_VIEW")]}
        selectedEventKey={null}
        liveMode="off"
        onSelectEvent={onSelect}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /LOCAL_UPLOAD_PAGE_VIEW/i }));
    expect(onSelect).toHaveBeenCalledWith("evt-1");
  });

  it("renders readable labels for cloud LLM stage events", () => {
    const onSelect = vi.fn();
    render(
      <TelemetryEventTimeline
        events={[
          {
            key: "stage-1",
            index: 1,
            domain: "llm_cloud",
            severity: "info",
            event: {
              type: "LLM_RUN_STAGE",
              timestamp: 20,
              data: {
                stage: "workflow_expansion_target_start",
                stageLabel: "Passe 2/6 · Expansion partie 1/3",
                globalPassIndex: 2,
                globalPassTotal: 6,
                targetIndex: 1,
                targetTotal: 3,
              },
            },
          },
        ]}
        selectedEventKey={null}
        liveMode="off"
        onSelectEvent={onSelect}
      />
    );

    expect(screen.getByRole("button", { name: /Passe 2\/6 · Expansion partie 1\/3/i })).toBeInTheDocument();
  });
});
