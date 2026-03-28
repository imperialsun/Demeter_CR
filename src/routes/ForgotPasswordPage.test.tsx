import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  isBackendMode: vi.fn(() => true),
  backendRequestPasswordReset: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: mocks.isBackendMode,
}));

vi.mock("@/lib/backend-auth", () => ({
  backendRequestPasswordReset: mocks.backendRequestPasswordReset,
}));

vi.mock("@/lib/backend-permissions", () => ({
  getFirstAuthorizedRoute: () => "/localupload",
}));

vi.mock("@/lib/backend-api", () => ({
  formatBackendErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: vi.fn(),
  },
}));

import ForgotPasswordPage from "@/routes/ForgotPasswordPage";

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReset();
    mocks.isAuthenticated.mockReturnValue(false);
    mocks.isBackendMode.mockReset();
    mocks.isBackendMode.mockReturnValue(true);
    mocks.backendRequestPasswordReset.mockReset();
    mocks.backendRequestPasswordReset.mockResolvedValue(undefined);
  });

  it("redirects to login outside backend mode", () => {
    mocks.isBackendMode.mockReturnValue(false);

    render(
      <MemoryRouter initialEntries={["/forgot-password"]}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/login" element={<div>login-target</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("login-target")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Sécurité du mot de passe" })).toBeNull();
  });

  it("submits the trimmed email and shows a generic success message", async () => {
    render(
      <MemoryRouter initialEntries={["/forgot-password"]}>
        <Routes>
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: " user@example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Envoyer le lien" }));

    await waitFor(() => expect(mocks.backendRequestPasswordReset).toHaveBeenCalledWith("user@example.com"));
    expect(
      screen.getByText("Si un compte actif correspond a cet email, un lien de reinitialisation vient d etre envoye.")
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Sécurité du mot de passe" })).toBeNull();
  });
});
