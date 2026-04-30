import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ThemeProvider } from "@/components/theme-provider";
import SettingsPage from "@/routes/SettingsPage";

const backendPermissionMocks = vi.hoisted(() => ({
  getAuthorizedSettingsTabs: vi.fn(() => ["local", "cloud", "llmlocal", "llm"]),
}));

vi.mock("@/lib/backend-permissions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend-permissions")>("@/lib/backend-permissions");
  return {
    ...actual,
    getAuthorizedSettingsTabs: (...args: unknown[]) => backendPermissionMocks.getAuthorizedSettingsTabs(...args),
  };
});

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

describe("SettingsPage", () => {
  beforeEach(() => {
    backendPermissionMocks.getAuthorizedSettingsTabs.mockReset();
    backendPermissionMocks.getAuthorizedSettingsTabs.mockReturnValue(["local", "cloud", "llmlocal", "llm"]);
  });

  it("opens llmlocal tab from query param", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <MemoryRouter initialEntries={["/settings?tab=llmlocal"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByText("Pipeline /llmlocal")).toBeInTheDocument();
  });

  it("opens llm tab from query param", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <MemoryRouter initialEntries={["/settings?tab=llm"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByText("Pipeline Rédaction")).toBeInTheDocument();
  });

  it("falls back to local tab when query param is invalid", () => {
    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <MemoryRouter initialEntries={["/settings?tab=unknown"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByText("Modèle Whisper")).toBeInTheDocument();
    expect(screen.queryByText("Pipeline Rédaction")).not.toBeInTheDocument();
  });

  it("falls back to first authorized tab when requested tab is forbidden", () => {
    backendPermissionMocks.getAuthorizedSettingsTabs.mockReturnValue(["llm"]);

    render(
      <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
        <MemoryRouter initialEntries={["/settings?tab=local"]}>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    );

    expect(screen.getByText("Pipeline Rédaction")).toBeInTheDocument();
    expect(screen.queryByText("Modèle Whisper")).not.toBeInTheDocument();
  });
});
