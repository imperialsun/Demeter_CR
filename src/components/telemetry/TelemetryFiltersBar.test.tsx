import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TelemetryFiltersBar } from "@/components/telemetry/TelemetryFiltersBar";
import type { TelemetryKpis } from "@/lib/telemetryView";

const baseKpis: TelemetryKpis = {
  total: 42,
  errors: 2,
  warnings: 3,
  droppedEvents: 1,
  latestTimestamp: Date.now(),
};

function renderFiltersBar() {
  const onScopeChange = vi.fn();
  const onSeverityChange = vi.fn();
  const onSearchQueryChange = vi.fn();
  const onLiveModeChange = vi.fn();
  const onResetFilters = vi.fn();

  render(
    <TelemetryFiltersBar
      sessionId="session_123456789"
      createdAt={new Date("2026-02-18T12:00:00.000Z").toISOString()}
      backend="wasm"
      modelId="Xenova/whisper-small"
      scope="all"
      severity="all"
      liveMode="on"
      searchQuery=""
      visibleEventsCount={12}
      kpis={baseKpis}
      onScopeChange={onScopeChange}
      onSeverityChange={onSeverityChange}
      onSearchQueryChange={onSearchQueryChange}
      onLiveModeChange={onLiveModeChange}
      onResetFilters={onResetFilters}
    />
  );

  return {
    onScopeChange,
    onSeverityChange,
    onSearchQueryChange,
    onLiveModeChange,
    onResetFilters,
  };
}

describe("TelemetryFiltersBar", () => {
  it("renders key metadata and kpis", () => {
    renderFiltersBar();

    expect(screen.getByText(/session/i)).toBeInTheDocument();
    expect(screen.getByText("Backend wasm")).toBeInTheDocument();
    expect(screen.getByText("Modèle Xenova/whisper-small")).toBeInTheDocument();
    expect(screen.getByText("sur 42")).toBeInTheDocument();
  });

  it("calls callbacks for scope, severity, search and live controls", async () => {
    const {
      onScopeChange,
      onSeverityChange,
      onSearchQueryChange,
      onLiveModeChange,
      onResetFilters,
    } = renderFiltersBar();

    fireEvent.click(screen.getByLabelText("Domaine", { selector: "button#telemetry-scope" }));
    fireEvent.click(await screen.findByText("Cloud ASR"));
    await waitFor(() => expect(onScopeChange).toHaveBeenCalledWith("cloud"));

    fireEvent.click(screen.getByLabelText("Sévérité", { selector: "button#telemetry-severity" }));
    fireEvent.click(await screen.findByText("Warn"));
    await waitFor(() => expect(onSeverityChange).toHaveBeenCalledWith("warn"));

    fireEvent.change(screen.getByLabelText("Recherche", { selector: "input#telemetry-search" }), {
      target: { value: "mistral" },
    });
    expect(onSearchQueryChange).toHaveBeenCalledWith("mistral");

    await userEvent.click(screen.getByRole("button", { name: /pause live/i }));
    expect(onLiveModeChange).toHaveBeenCalledWith("off");

    await userEvent.click(screen.getByRole("switch", { name: /live/i }));
    expect(onLiveModeChange).toHaveBeenCalledWith("off");

    await userEvent.click(screen.getByRole("button", { name: /reset filtres/i }));
    expect(onResetFilters).toHaveBeenCalledTimes(1);
  });
});
