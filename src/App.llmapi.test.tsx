import { describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import App from "@/App";

vi.mock("@/lib/auth", () => ({
  isAuthenticated: () => true,
}));

vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/routes/LocalUploadPage", () => ({ default: () => <div>LocalUploadStub</div> }));
vi.mock("@/routes/CloudUploadPage", () => ({ default: () => <div>CloudUploadStub</div> }));
vi.mock("@/routes/LLMLocalPage", () => ({ default: () => <div>LLMLocalStub</div> }));
vi.mock("@/routes/LLMApiPage", () => ({ default: () => <div>LLMApiStub</div> }));
vi.mock("@/routes/SettingsPage", () => ({ default: () => <div>SettingsStub</div> }));
vi.mock("@/routes/TelemetryPage", () => ({ default: () => <div>TelemetryStub</div> }));
vi.mock("@/routes/LoginPage", () => ({ default: () => <div>LoginStub</div> }));

describe("App routing", () => {
  it("registers /llmapi route", () => {
    render(
      <MemoryRouter initialEntries={["/llmapi"]}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText("LLMApiStub")).toBeInTheDocument();
  });

  it("registers /llmlocal route", () => {
    render(
      <MemoryRouter initialEntries={["/llmlocal"]}>
        <App />
      </MemoryRouter>
    );

    expect(screen.getByText("LLMLocalStub")).toBeInTheDocument();
  });
});
