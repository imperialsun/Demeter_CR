import { describe, expect, it } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { Sidebar } from "@/components/layout/Sidebar";

describe("Sidebar", () => {
  it("renders LLM Cloud navigation item", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: /llm cloud/i });
    expect(link).toBeInTheDocument();
    expect(link.getAttribute("href")).toBe("/llmapi");
  });
});
