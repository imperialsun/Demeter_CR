import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AppShell } from "./AppShell";
import { useAsrStore, type AsrConfigStore } from "@/store/asr-store";

vi.mock("@/components/layout/Sidebar", () => ({
  Sidebar: () => <div data-testid="sidebar" />,
}));

vi.mock("@/components/layout/Topbar", () => ({
  Topbar: () => <div data-testid="topbar" />,
}));

describe("AppShell", () => {
  const originalStoreState = useAsrStore.getState();

  afterEach(() => {
    document.title = "Demeter Speech";
    useAsrStore.setState(originalStoreState, true);
    vi.restoreAllMocks();
  });

  it("resets session on mount", async () => {
    const resetSpy = vi.fn();
    useAsrStore.setState({ resetSession: resetSpy } as Partial<AsrConfigStore>);

    let unmount: () => void = () => {};
    await act(async () => {
      const result = render(
        <MemoryRouter initialEntries={["/dashboard"]}>
          <AppShell>
            <div />
          </AppShell>
        </MemoryRouter>,
      );
      unmount = result.unmount;
    });

    expect(resetSpy).toHaveBeenCalledTimes(1);
    act(() => {
      unmount();
    });
  });

  it("keeps the generic tab title outside /cloudupload", async () => {
    const resetSpy = vi.fn();
    useAsrStore.setState(
      {
        resetSession: resetSpy,
        isTranscribing: true,
        progress: 0.32,
        cloudStatus: "preprocessing",
      } as Partial<AsrConfigStore>,
    );

    render(
      <MemoryRouter initialEntries={["/dashboard"]}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    await waitFor(() => expect(document.title).toBe("Demeter Speech (32%)"));
  });

  it("shows cloud progress in the tab title on /cloudupload", async () => {
    const resetSpy = vi.fn();
    useAsrStore.setState(
      {
        resetSession: resetSpy,
        isTranscribing: true,
        progress: 0.32,
        cloudStatus: "preprocessing",
      } as Partial<AsrConfigStore>,
    );

    render(
      <MemoryRouter initialEntries={["/cloudupload"]}>
        <AppShell>
          <div />
        </AppShell>
      </MemoryRouter>,
    );

    await waitFor(() => expect(document.title).toBe("Demeter Speech - Préparation (32%)"));

    act(() => {
      useAsrStore.setState({
        progress: 0.67,
        cloudStatus: "uploading",
      } as Partial<AsrConfigStore>);
    });
    await waitFor(() => expect(document.title).toBe("Demeter Speech - Envoi cloud (67%)"));

    act(() => {
      useAsrStore.setState({
        progress: 0.89,
        cloudStatus: "transcribing",
      } as Partial<AsrConfigStore>);
    });
    await waitFor(() => expect(document.title).toBe("Demeter Speech - Transcription (89%)"));

    act(() => {
      useAsrStore.setState({
        isTranscribing: true,
        progress: 1,
        cloudStatus: "stopping",
      } as Partial<AsrConfigStore>);
    });
    await waitFor(() => expect(document.title).toBe("Demeter Speech"));
  });
});
