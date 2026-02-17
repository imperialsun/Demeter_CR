import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import LoginPage from "@/routes/LoginPage";

vi.mock("@/lib/auth", () => ({
  isAuthenticated: vi.fn(() => false),
  isPasswordValid: vi.fn(() => false),
  setAuthenticated: vi.fn(),
}));

describe("LoginPage", () => {
  it("renders company logo, branding text, and login title", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByAltText("Logo Demeter Speech")).toBeInTheDocument();
    expect(screen.getByText("Demeter Speech")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Connexion" })).toBeInTheDocument();
  });
});

