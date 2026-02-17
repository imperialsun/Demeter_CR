import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";

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
  });
});
