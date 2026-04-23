import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TelemetryEventInspector } from "@/components/telemetry/TelemetryEventInspector";
import type { TelemetryViewEvent } from "@/lib/telemetryView";

describe("TelemetryEventInspector", () => {
  it("shows readable labels and global pass metadata for LLM stage events", () => {
    const event: TelemetryViewEvent = {
      key: "stage-1",
      index: 1,
      domain: "llm_cloud",
      severity: "info",
      event: {
        type: "LLM_RUN_STAGE",
        timestamp: 120,
        data: {
          stage: "workflow_expansion_target_start",
          stageLabel: "Passe 2/6 · Expansion partie 1/3",
          globalPassIndex: 2,
          globalPassTotal: 6,
          stepKind: "expansion",
          stepStatus: "start",
          targetIndex: 1,
          targetTotal: 3,
          summary: "Ajout d'une sous-partie complémentaire",
        },
      },
    };

    render(<TelemetryEventInspector event={event} />);

    expect(screen.getByRole("heading", { name: "Passe 2/6 · Expansion partie 1/3" })).toBeInTheDocument();
    expect(screen.getByText("Passe 2/6")).toBeInTheDocument();
    expect(screen.getByText("Étape cloud")).toBeInTheDocument();
    expect(screen.getAllByText(/Ajout d'une sous-partie complémentaire/).length).toBeGreaterThan(0);
  });
});
