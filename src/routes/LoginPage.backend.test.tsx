import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isAuthenticated: vi.fn(() => false),
  isPasswordValid: vi.fn(() => false),
  setAuthenticated: vi.fn(),
  isBackendMode: vi.fn(() => true),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: mocks.isAuthenticated,
  isPasswordValid: mocks.isPasswordValid,
  setAuthenticated: mocks.setAuthenticated,
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: mocks.isBackendMode,
}));

vi.mock("@/lib/backend-auth", () => ({
  backendLogin: vi.fn(),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canAccessRoutePath: () => true,
  getFirstAuthorizedRoute: () => "/localupload",
}));

vi.mock("@/lib/backend-settings-sync", () => ({
  pullBackendSettings: vi.fn(),
}));

vi.mock("@/lib/backend-activity-sync", () => ({
  flushBackendActivityQueueNow: vi.fn(),
}));

vi.mock("@/lib/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/storage")>("@/lib/storage");
  return {
    ...actual,
    replaceSettingsCacheFromBackend: vi.fn(),
  };
});

vi.mock("@/components/ui/use-toast", () => ({
  toast: vi.fn(),
}));

vi.mock("@/store/asr-store", async () => {
  const actual = await vi.importActual("@/store/asr-store");
  return {
    ...actual,
    useAsrStore: ((selector: (state: { telemetryCollector: null }) => unknown) =>
      selector({ telemetryCollector: null })) as unknown,
  };
});

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import LoginPage from "@/routes/LoginPage";

describe("LoginPage backend mode", () => {
  beforeEach(() => {
    mocks.isAuthenticated.mockReset();
    mocks.isAuthenticated.mockReturnValue(false);
    mocks.isBackendMode.mockReset();
    mocks.isBackendMode.mockReturnValue(true);
  });

  it("shows the forgot password link only in backend mode", () => {
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/forgot-password" element={<div>forgot-target</div>} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Mot de passe oublié ?" })).toHaveAttribute("href", "/forgot-password");
  });
});
