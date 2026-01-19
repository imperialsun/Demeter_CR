import { describe, it, expect, vi, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { AppShell } from "./AppShell";
import { useAsrStore, type AsrConfigStore } from "@/store/asr-store";

vi.mock("@/components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar" />,
}));

describe("AppShell", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resets session on mount", async () => {
    const originalReset = useAsrStore.getState().resetSession;
    const resetSpy = vi.fn();
    useAsrStore.setState({ resetSession: resetSpy } as Partial<AsrConfigStore>);

    let unmount: () => void = () => {};
    await act(async () => {
      const result = render(<AppShell><div /></AppShell>);
      unmount = result.unmount;
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    act(() => {
      unmount();
    });
    useAsrStore.setState({ resetSession: originalReset } as Partial<AsrConfigStore>);
  });
});
