import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";

const preloadSpies = vi.hoisted(() => ({
  cloud: vi.fn(),
  llmLocal: vi.fn(),
  llmApi: vi.fn(),
  settings: vi.fn(),
  telemetry: vi.fn(),
}));

vi.mock("@/routes/CloudUploadPage", () => {
  preloadSpies.cloud();
  return { default: () => null };
});
vi.mock("@/routes/LLMLocalPage", () => {
  preloadSpies.llmLocal();
  return { default: () => null };
});
vi.mock("@/routes/LLMApiPage", () => {
  preloadSpies.llmApi();
  return { default: () => null };
});
vi.mock("@/routes/SettingsPage", () => {
  preloadSpies.settings();
  return { default: () => null };
});
vi.mock("@/routes/TelemetryPage", () => {
  preloadSpies.telemetry();
  return { default: () => null };
});

describe("Sidebar", () => {
  it("renders LLM local/cloud navigation items", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    expect(screen.getByAltText("Logo Demeter Speech")).toBeInTheDocument();
    expect(screen.getByText("Demeter Speech")).toBeInTheDocument();
    const localLink = screen.getByRole("link", { name: /llm local/i });
    expect(localLink).toBeInTheDocument();
    expect(localLink.getAttribute("href")).toBe("/llmlocal");

    const link = screen.getByRole("link", { name: /llm cloud/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/llmapi");
    expect(screen.getByText("Transcription locale et distante · Chrome uniquement")).toBeInTheDocument();
    expect(screen.queryByText(/Whisper sur Transformers\.js/i)).toBeNull();
  });

  it("preloads lazy routes on hover and focus", async () => {
    preloadSpies.cloud.mockClear();
    preloadSpies.llmLocal.mockClear();
    preloadSpies.llmApi.mockClear();
    preloadSpies.settings.mockClear();
    preloadSpies.telemetry.mockClear();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    fireEvent.mouseEnter(screen.getByRole("link", { name: /transcription cloud/i }));
    fireEvent.focus(screen.getByRole("link", { name: /llm local/i }));
    fireEvent.mouseEnter(screen.getByRole("link", { name: /llm cloud/i }));
    fireEvent.focus(screen.getByRole("link", { name: /paramètres/i }));
    fireEvent.mouseEnter(screen.getByRole("link", { name: /télémetrie/i }));

    await waitFor(() => {
      expect(preloadSpies.cloud).toHaveBeenCalled();
      expect(preloadSpies.llmLocal).toHaveBeenCalled();
      expect(preloadSpies.llmApi).toHaveBeenCalled();
      expect(preloadSpies.settings).toHaveBeenCalled();
      expect(preloadSpies.telemetry).toHaveBeenCalled();
    });
  });

  it("does not preload for local transcription entry", () => {
    preloadSpies.cloud.mockClear();
    preloadSpies.llmLocal.mockClear();
    preloadSpies.llmApi.mockClear();
    preloadSpies.settings.mockClear();
    preloadSpies.telemetry.mockClear();

    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    const localLink = screen.getByRole("link", { name: /transcription locale/i });
    fireEvent.mouseEnter(localLink);
    fireEvent.focus(localLink);

    expect(preloadSpies.cloud).not.toHaveBeenCalled();
    expect(preloadSpies.llmLocal).not.toHaveBeenCalled();
    expect(preloadSpies.llmApi).not.toHaveBeenCalled();
    expect(preloadSpies.settings).not.toHaveBeenCalled();
    expect(preloadSpies.telemetry).not.toHaveBeenCalled();
  });
});
