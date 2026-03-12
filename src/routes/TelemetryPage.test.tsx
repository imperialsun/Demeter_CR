import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import TelemetryPage from "@/routes/TelemetryPage";
import { debug, setLogLevelProvider } from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";

function LocationSearchProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

describe("TelemetryPage", () => {
  beforeEach(() => {
    useAsrStore.setState({ telemetrySummary: null, telemetryCollector: null } as never);
    setLogLevelProvider(() => "debug");
  });

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

  it("clears telemetry query params when resetting filters", async () => {
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
        events: [{ type: "LOG_WARN", timestamp: 12, data: { provider: "cloud" } }],
        memorySnapshots: [],
        alerts: {},
      },
    } as never);

    render(
      <MemoryRouter initialEntries={["/telemetry?tab=alerts&scope=cloud&severity=warn&live=off"]}>
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

    fireEvent.click(screen.getByRole("button", { name: /reset filtres/i }));

    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("tab=");
      expect(search).not.toContain("scope=");
      expect(search).not.toContain("severity=");
      expect(search).not.toContain("live=");
    });
  });

  it("removes live query param when switching back to default live mode", async () => {
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
        events: [{ type: "LOG_WARN", timestamp: 14, data: {} }],
        memorySnapshots: [],
        alerts: {},
      },
    } as never);

    render(
      <MemoryRouter initialEntries={["/telemetry?live=off"]}>
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

    fireEvent.click(screen.getByRole("button", { name: /reprendre live/i }));

    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("live=");
    });
  });

  it("shows buffered frontend logs when no telemetry session is active", async () => {
    debug("[route][telemetry] debug fallback visible", { page: "/telemetry" });

    render(
      <MemoryRouter initialEntries={["/telemetry?severity=debug"]}>
        <Routes>
          <Route path="/telemetry" element={<TelemetryPage />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.queryByText(/aperçu de démonstration/i)).toBeNull();
      expect(screen.getAllByText("LOG_DEBUG").length).toBeGreaterThan(0);
      expect(screen.getAllByText(/debug fallback visible/i).length).toBeGreaterThan(0);
    });
  });
});
