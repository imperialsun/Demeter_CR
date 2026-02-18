import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import LoginPage from "@/routes/LoginPage";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  isPasswordValid: vi.fn(() => false),
  setAuthenticated: vi.fn(),
  toast: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
  isPasswordValid: mocks.isPasswordValid,
  setAuthenticated: mocks.setAuthenticated,
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: mocks.toast,
}));

vi.mock("@/store/asr-store", async () => {
  const actual = await vi.importActual("@/store/asr-store");
  return {
    ...actual,
    useAsrStore: ((selector: (state: { telemetryCollector: { logEvent: typeof mocks.logEvent } }) => unknown) =>
      selector({ telemetryCollector: { logEvent: mocks.logEvent } })) as unknown,
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe("LoginPage", () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReturnValue(false);
    mocks.isPasswordValid.mockReturnValue(false);
    mocks.setAuthenticated.mockClear();
    mocks.toast.mockClear();
    mocks.logEvent.mockClear();
  });

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

  it("redirects authenticated users to requested route", () => {
    mocks.isAuthenticated.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/login", state: { from: { pathname: "/settings" } } } as never]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/settings" element={<div>Settings page</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText("Settings page")).toBeInTheDocument();
  });

  it("shows a validation error for empty password", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));

    expect(screen.getByText("Veuillez saisir le mot de passe.")).toBeInTheDocument();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith("AUTH_LOGIN_FAILED", { reason: "empty_password" });
  });

  it("shows an error when password is invalid", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "wrong-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));

    expect(screen.getByText("Mot de passe incorrect.")).toBeInTheDocument();
    expect(mocks.setAuthenticated).not.toHaveBeenCalled();
    expect(mocks.logEvent).toHaveBeenCalledWith("AUTH_LOGIN_FAILED", { reason: "invalid_password" });
  });

  it("authenticates and navigates to default local upload page", () => {
    mocks.isPasswordValid.mockReturnValue(true);
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/localupload" element={<div>Local upload page</div>} />
        </Routes>
      </MemoryRouter>
    );

    fireEvent.change(screen.getByLabelText("Mot de passe"), {
      target: { value: "correct-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));

    expect(mocks.setAuthenticated).toHaveBeenCalledWith(true);
    expect(mocks.toast).toHaveBeenCalledWith("Connexion réussie.");
    expect(screen.getByText("Local upload page")).toBeInTheDocument();
  });
});
