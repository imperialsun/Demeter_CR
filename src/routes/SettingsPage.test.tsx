import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { ThemeProvider } from "@/components/theme-provider";
import SettingsPage from "@/routes/SettingsPage";

describe("SettingsPage", () => {
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

    expect(screen.getByText("Pipeline /llmapi")).toBeInTheDocument();
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
    expect(screen.queryByText("Pipeline /llmapi")).not.toBeInTheDocument();
  });
});
