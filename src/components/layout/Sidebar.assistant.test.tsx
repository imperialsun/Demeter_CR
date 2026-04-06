import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { Sidebar } from "@/components/layout/Sidebar";

const preloadSpies = vi.hoisted(() => ({
  assistant: vi.fn(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => true,
}));

vi.mock("@/lib/backend-permissions", () => ({
  canAccessFeature: () => true,
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

vi.mock("@/routes/AssistantPage", () => {
  preloadSpies.assistant();
  return { default: () => null };
});

describe("Sidebar assistant entry", () => {
  it("renders the assistant navigation item and preloads it on hover", async () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    const nav = screen.getByRole("navigation");
    const assistantLink = screen.getByRole("link", { name: /assistant/i });
    expect(assistantLink).toBeInTheDocument();
    expect(assistantLink.getAttribute("href")).toBe("/assistant");
    expect(nav.querySelector("a")?.getAttribute("href")).toBe("/assistant");

    fireEvent.mouseEnter(assistantLink);

    await waitFor(() => {
      expect(preloadSpies.assistant).toHaveBeenCalled();
    });
  });
});
