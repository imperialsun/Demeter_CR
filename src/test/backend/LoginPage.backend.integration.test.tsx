import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { createBackendUser } from "./adminClient";
import { createAppCookieJar, configureBackendRuntime, resetBrowserState } from "./runtime";

const smokeMocks = vi.hoisted(() => ({
  hydrateFromStorage: vi.fn(),
  logEvent: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/components/ui/use-toast", () => ({
  toast: (...args: unknown[]) => smokeMocks.toast(...args),
}));

vi.mock("@/store/asr-store", () => {
  const useAsrStore = Object.assign(
    (selector: (state: { telemetryCollector: { logEvent: typeof smokeMocks.logEvent } }) => unknown) =>
      selector({ telemetryCollector: { logEvent: smokeMocks.logEvent } }),
    {
      getState: () => ({
        hydrateFromStorage: smokeMocks.hydrateFromStorage,
      }),
    }
  );
  return { useAsrStore };
});

describe("LoginPage backend integration", () => {
  beforeEach(() => {
    resetBrowserState();
    smokeMocks.hydrateFromStorage.mockReset();
    smokeMocks.logEvent.mockReset();
    smokeMocks.toast.mockReset();
  });

  it("logs in against the real backend and redirects to the first authorized route", async () => {
    const user = await createBackendUser();
    vi.resetModules();
    await configureBackendRuntime();
    const jar = await createAppCookieJar();
    const restoreFetch = jar.installGlobally();

    try {
      const { default: LoginPage } = await import("@/routes/LoginPage");

      render(
        <MemoryRouter initialEntries={["/login"]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/localupload" element={<div>Local upload page</div>} />
            <Route path="/forbidden" element={<div>Forbidden page</div>} />
          </Routes>
        </MemoryRouter>
      );

      fireEvent.change(screen.getByLabelText("Email"), {
        target: { value: user.email },
      });
      fireEvent.change(screen.getByLabelText("Mot de passe"), {
        target: { value: user.password },
      });
      fireEvent.click(screen.getByRole("button", { name: "Se connecter" }));

      await waitFor(() => {
        expect(screen.getByText("Local upload page")).toBeInTheDocument();
      });

      expect(smokeMocks.toast).toHaveBeenCalledWith("Connexion réussie.");
      expect(smokeMocks.hydrateFromStorage).toHaveBeenCalled();
      expect(smokeMocks.logEvent).toHaveBeenCalledWith("AUTH_LOGIN_SUCCESS", {
        source: "login_page",
        mode: "backend",
      });
    } finally {
      restoreFetch();
    }
  });
});
