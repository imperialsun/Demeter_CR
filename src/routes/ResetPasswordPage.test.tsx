import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  isBackendMode: vi.fn(() => true),
  backendResetPassword: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: mocks.isBackendMode,
}));

vi.mock("@/lib/backend-auth", () => ({
  backendResetPassword: mocks.backendResetPassword,
}));

vi.mock("@/lib/backend-permissions", () => ({
  getFirstAuthorizedRoute: () => "/localupload",
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/lib/backend-api", () => ({
  formatBackendErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    warn: vi.fn(),
  },
}));

import ResetPasswordPage from "@/routes/ResetPasswordPage";

describe("ResetPasswordPage", () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReset();
    mocks.isAuthenticated.mockReturnValue(false);
    mocks.isBackendMode.mockReset();
    mocks.isBackendMode.mockReturnValue(true);
    mocks.backendResetPassword.mockReset();
    mocks.backendResetPassword.mockResolvedValue(undefined);
    mocks.toast.mockReset();
  });

  it("redirects to login outside backend mode", () => {
    mocks.isBackendMode.mockReturnValue(false);

    render(
      <MemoryRouter initialEntries={["/reset-password?token=abc"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<div>login-target</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("login-target")).toBeInTheDocument();
  });

  it("validates the presence of a token", async () => {
    render(
      <MemoryRouter initialEntries={["/reset-password"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Nouveau mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mettre a jour" }));

    expect(screen.getByText("Le lien de reinitialisation est invalide ou incomplet.")).toBeInTheDocument();
    expect(mocks.backendResetPassword).not.toHaveBeenCalled();
  });

  it("rejects mismatched passwords", async () => {
    render(
      <MemoryRouter initialEntries={["/reset-password?token=abc"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Nouveau mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "OtherPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mettre a jour" }));

    expect(screen.getByText("Les mots de passe ne correspondent pas.")).toBeInTheDocument();
    expect(mocks.backendResetPassword).not.toHaveBeenCalled();
  });

  it("submits the token and redirects to login on success", async () => {
    render(
      <MemoryRouter initialEntries={["/reset-password?token=abc"]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/login" element={<div>login-target</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Nouveau mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.change(screen.getByLabelText("Confirmer le mot de passe"), {
      target: { value: "NewPass123!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mettre a jour" }));

    await waitFor(() => expect(mocks.backendResetPassword).toHaveBeenCalledWith("abc", "NewPass123!"));
    expect(mocks.toast).toHaveBeenCalledWith("Mot de passe reinitialise.");
    await waitFor(() => expect(screen.getByText("login-target")).toBeInTheDocument());
  });
});
