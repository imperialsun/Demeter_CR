import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import App from "@/App";

const isAuthenticatedMock = vi.fn(() => true);
const runtimeModeMock = vi.fn(() => false);
const backendPermissionMocks = vi.hoisted(() => ({
  canAccessFeature: vi.fn(() => true),
  getFirstAuthorizedRoute: vi.fn(() => "/localupload"),
}));

vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => isAuthenticatedMock(),
}));

vi.mock("@/lib/runtime-config", () => ({
  isBackendMode: () => runtimeModeMock(),
}));

vi.mock("@/lib/backend-permissions", () => ({
  canAccessFeature: (...args: unknown[]) => backendPermissionMocks.canAccessFeature(...args),
  getFirstAuthorizedRoute: (...args: unknown[]) => backendPermissionMocks.getFirstAuthorizedRoute(...args),
}));

vi.mock("@/hooks/useBackendPermissions", () => ({
  useBackendPermissions: () => ({}),
}));

vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/routes/LocalUploadPage", () => ({ default: () => <div>LocalUploadStub</div> }));
vi.mock("@/routes/CloudUploadPage", () => ({ default: () => <div>CloudUploadStub</div> }));
vi.mock("@/routes/AssistantPage", () => ({ default: () => <div>AssistantStub</div> }));
vi.mock("@/routes/LLMLocalPage", () => ({ default: () => <div>LLMLocalStub</div> }));
vi.mock("@/routes/LLMApiPage", () => ({ default: () => <div>LLMApiStub</div> }));
vi.mock("@/routes/SettingsPage", () => ({ default: () => <div>SettingsStub</div> }));
vi.mock("@/routes/TelemetryPage", () => ({ default: () => <div>TelemetryStub</div> }));
vi.mock("@/routes/ForbiddenPage", () => ({ default: () => <div>ForbiddenStub</div> }));
vi.mock("@/routes/LoginPage", () => ({ default: () => <div>LoginStub</div> }));

describe("App routing", () => {
  beforeEach(() => {
    runtimeModeMock.mockReturnValue(false);
    backendPermissionMocks.canAccessFeature.mockReset();
    backendPermissionMocks.canAccessFeature.mockReturnValue(true);
    backendPermissionMocks.getFirstAuthorizedRoute.mockReset();
    backendPermissionMocks.getFirstAuthorizedRoute.mockReturnValue("/localupload");
  });

  it("registers /llmapi route", async () => {
    isAuthenticatedMock.mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={["/llmapi"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("LLMApiStub")).toBeInTheDocument();
  });

  it("registers /assistant route", async () => {
    isAuthenticatedMock.mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={["/assistant"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("AssistantStub")).toBeInTheDocument();
  });

  it("registers /llmlocal route", async () => {
    isAuthenticatedMock.mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={["/llmlocal"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("LLMLocalStub")).toBeInTheDocument();
  });

  it("redirects unauthenticated users to /login", async () => {
    isAuthenticatedMock.mockReturnValue(false);

    render(
      <MemoryRouter initialEntries={["/llmapi"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("LoginStub")).toBeInTheDocument();
  });

  it("redirects legacy /upload route to /localupload", async () => {
    isAuthenticatedMock.mockReturnValue(true);

    render(
      <MemoryRouter initialEntries={["/upload"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("LocalUploadStub")).toBeInTheDocument();
  });

  it("redirects to /forbidden when backend feature access is denied", async () => {
    runtimeModeMock.mockReturnValue(true);
    isAuthenticatedMock.mockReturnValue(true);
    backendPermissionMocks.canAccessFeature.mockReturnValue(false);
    backendPermissionMocks.getFirstAuthorizedRoute.mockReturnValue("/forbidden");

    render(
      <MemoryRouter initialEntries={["/localupload"]}>
        <App />
      </MemoryRouter>
    );

    expect(await screen.findByText("ForbiddenStub")).toBeInTheDocument();
  });
});
