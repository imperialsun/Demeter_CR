/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TelemetryPanel } from "@/components/telemetry/TelemetryPanel";

const baseSummary = {
  sessionId: "session-1234567890",
  createdAt: new Date("2026-02-17T10:00:00.000Z").toISOString(),
  userAgent: "test-agent",
  transformersVersion: "4.0.0",
  backend: "wasm",
  modelId: "Xenova/whisper-tiny",
  timings: { load_model_total: 123, decode_audio_total: 456 },
  memorySnapshots: [{ label: "snapshot", usedJSHeapSize: 10, totalJSHeapSize: 50, timestamp: 100 }],
  events: [
    { type: "RAM_USAGE", timestamp: 200, data: { context: "chunk", index: 0, mb: 12 } },
    { type: "LOCAL_UPLOAD_PAGE_VIEW", timestamp: 300, data: { route: "/localupload" } },
  ],
  chunks: [{ id: "c1", index: 0, startSec: 0, endSec: 10, transcriptionMs: 1000, realtimeFactor: 0.5 }],
  alerts: {
    PREPROCESS_GATE: {
      count: 1,
      lastTimestamp: 320,
      lastData: { reason: "high_noise" },
    },
  },
};

describe("TelemetryPanel", () => {
  it("renders preview cockpit when no summary is available", () => {
    render(<TelemetryPanel summary={null} />);
    expect(
      screen.getByText("Aucune session telemetry active. Aperçu de démonstration affiché pour visualiser la page.")
    ).toBeInTheDocument();
    expect(screen.getByText("Pilotage session")).toBeInTheDocument();
  });

  it("renders cockpit sections for a summary", () => {
    render(
      <TelemetryPanel
        summary={baseSummary as any}
        scope="all"
        severity="all"
        tab="overview"
        liveMode="on"
        onScopeChange={vi.fn()}
        onSeverityChange={vi.fn()}
        onTabChange={vi.fn()}
        onLiveModeChange={vi.fn()}
        onResetFilters={vi.fn()}
      />
    );

    expect(screen.getByText("Pilotage session")).toBeInTheDocument();
    expect(screen.getByText("Santé domaines")).toBeInTheDocument();
    expect(screen.getByText("Timeline événements")).toBeInTheDocument();
    expect(screen.getAllByText("LOCAL_UPLOAD_PAGE_VIEW").length).toBeGreaterThan(0);
  });

  it("switches to alerts tab and shows alert aggregates", () => {
    render(
      <TelemetryPanel
        summary={baseSummary as any}
        scope="all"
        severity="all"
        tab="alerts"
        liveMode="on"
        onScopeChange={vi.fn()}
        onSeverityChange={vi.fn()}
        onTabChange={vi.fn()}
        onLiveModeChange={vi.fn()}
        onResetFilters={vi.fn()}
      />
    );

    expect(screen.getByText("Alertes agrégées")).toBeInTheDocument();
    expect(screen.getByText("PREPROCESS_GATE")).toBeInTheDocument();
  });
});
