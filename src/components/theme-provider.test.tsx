import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ThemeProvider } from "@/components/theme-provider";
import { useTheme } from "@/components/theme-context";

function ThemeConsumer() {
  const { theme, setTheme, visualStyle, setVisualStyle, toggleVisualStyle } = useTheme();
  return (
    <div>
      <span data-testid="theme-value">{theme}</span>
      <span data-testid="visual-style-value">{visualStyle}</span>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        system
      </button>
      <button type="button" onClick={() => setVisualStyle("app")}>
        app style
      </button>
      <button type="button" onClick={toggleVisualStyle}>
        toggle style
      </button>
    </div>
  );
}

describe("ThemeProvider", () => {
  afterEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("light", "dark", "style-app");
    vi.restoreAllMocks();
  });

  it("applies default theme and visual style when storage is empty", () => {
    render(
      <ThemeProvider defaultTheme="light" storageKey="theme-test">
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId("theme-value")).toHaveTextContent("light");
    expect(screen.getByTestId("visual-style-value")).toHaveTextContent("default");
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("style-app")).toBe(false);
  });

  it("uses stored theme from localStorage", () => {
    window.localStorage.setItem("theme-test", "dark");

    render(
      <ThemeProvider defaultTheme="light" storageKey="theme-test">
        <ThemeConsumer />
      </ThemeProvider>
    );

    return waitFor(() => {
      expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    });
  });

  it("uses stored visual style from localStorage and forces the light app style", async () => {
    window.localStorage.setItem("theme-test", "dark");
    window.localStorage.setItem("style-test", "app");

    render(
      <ThemeProvider defaultTheme="light" storageKey="theme-test" visualStyleStorageKey="style-test">
        <ThemeConsumer />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
      expect(screen.getByTestId("visual-style-value")).toHaveTextContent("app");
      expect(document.documentElement.classList.contains("style-app")).toBe(true);
      expect(document.documentElement.classList.contains("light")).toBe(true);
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    });
  });

  it("updates theme, stores value and resolves system theme", () => {
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: query.includes("prefers-color-scheme: dark"),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    render(
      <ThemeProvider defaultTheme="light" storageKey="theme-test">
        <ThemeConsumer />
      </ThemeProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "system" }));
    expect(screen.getByTestId("theme-value")).toHaveTextContent("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
  });

  it("updates and persists the visual style independently from theme", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    render(
      <ThemeProvider defaultTheme="dark" storageKey="theme-test" visualStyleStorageKey="style-test">
        <ThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId("theme-value")).toHaveTextContent("dark");
    expect(screen.getByTestId("visual-style-value")).toHaveTextContent("default");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "app style" }));
    expect(screen.getByTestId("visual-style-value")).toHaveTextContent("app");
    expect(setItemSpy).toHaveBeenCalledWith("style-test", "app");
    expect(document.documentElement.classList.contains("style-app")).toBe(true);
    expect(document.documentElement.classList.contains("light")).toBe(true);
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "toggle style" }));
    expect(screen.getByTestId("visual-style-value")).toHaveTextContent("default");
    expect(setItemSpy).toHaveBeenCalledWith("style-test", "default");
    expect(document.documentElement.classList.contains("style-app")).toBe(false);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("throws when useTheme is used outside provider", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<ThemeConsumer />)).toThrowError(/useTheme must be used within a ThemeProvider/i);
    errorSpy.mockRestore();
  });
});
