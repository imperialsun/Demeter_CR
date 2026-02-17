import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import TelemetryPage from "@/routes/TelemetryPage";
import { useAsrStore } from "@/store/asr-store";

function LocationSearchProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

describe("TelemetryPage", () => {
  it("reads valid query params for telemetry view", () => {
    useAsrStore.setState({
      telemetrySummary: {
        sessionId: "session-test",
        createdAt: new Date("2026-02-17T12:00:00.000Z").toISOString(),
        userAgent: "test-agent",
        transformersVersion: "4.0.0",
        backend: "wasm",
        modelId: "Xenova/whisper-tiny",
        timings: {},
        chunks: [],
        events: [{ type: "LLM_LOCAL_PAGE_VIEW", timestamp: 42, data: { route: "/llmlocal" } }],
        memorySnapshots: [],
        alerts: {},
      },
    } as never);

    render(
      <MemoryRouter initialEntries={["/telemetry?tab=alerts&scope=llm_local&severity=warn&live=off"]}>
        <Routes>
          <Route path="/telemetry" element={<TelemetryPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Alertes agrégées")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reprendre live" })).toBeInTheDocument();
  });

  it("falls back to default tab when query is invalid", () => {
    useAsrStore.setState({
      telemetrySummary: {
        sessionId: "session-test",
        createdAt: new Date("2026-02-17T12:00:00.000Z").toISOString(),
        userAgent: "test-agent",
        transformersVersion: "4.0.0",
        backend: "wasm",
        modelId: "Xenova/whisper-tiny",
        timings: {},
        chunks: [],
        events: [{ type: "LOCAL_UPLOAD_PAGE_VIEW", timestamp: 10, data: {} }],
        memorySnapshots: [],
        alerts: {},
      },
    } as never);

    render(
      <MemoryRouter initialEntries={["/telemetry?tab=invalid"]}>
        <Routes>
          <Route path="/telemetry" element={<TelemetryPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Santé domaines")).toBeInTheDocument();
  });

  it("writes tab query param when changing telemetry tab", () => {
    useAsrStore.setState({
      telemetrySummary: {
        sessionId: "session-test",
        createdAt: new Date("2026-02-17T12:00:00.000Z").toISOString(),
        userAgent: "test-agent",
        transformersVersion: "4.0.0",
        backend: "wasm",
        modelId: "Xenova/whisper-tiny",
        timings: {},
        chunks: [],
        events: [{ type: "LOG_WARN", timestamp: 10, data: { reason: "slow_network" } }],
        memorySnapshots: [],
        alerts: {},
      },
    } as never);

    render(
      <MemoryRouter initialEntries={["/telemetry?tab=alerts"]}>
        <Routes>
          <Route
            path="/telemetry"
            element={(
              <>
                <TelemetryPage />
                <LocationSearchProbe />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: /LOG_WARN/i }));
    expect(screen.getByTestId("location-search").textContent).toContain("tab=timeline");
  });
});
