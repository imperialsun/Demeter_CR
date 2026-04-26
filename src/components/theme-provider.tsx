import * as React from "react";

import { ThemeContext, type Theme, type VisualStyle } from "./theme-context";

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  defaultVisualStyle?: VisualStyle;
  storageKey?: string;
  visualStyleStorageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  defaultVisualStyle = "default",
  storageKey = "app-theme",
  visualStyleStorageKey = "demeter-visual-style",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);
  const [visualStyle, setVisualStyleState] = React.useState<VisualStyle>(defaultVisualStyle);

  React.useEffect(() => {
    const stored = window.localStorage.getItem(storageKey) as
      | "light"
      | "dark"
      | "system"
      | null;
    const storedVisualStyle = readVisualStyle(window.localStorage.getItem(visualStyleStorageKey));
    const nextVisualStyle = storedVisualStyle ?? defaultVisualStyle;

    setVisualStyleState(nextVisualStyle);
    if (stored) {
      setThemeState(stored);
      applyAppearance(stored, nextVisualStyle);
      return;
    }
    applyAppearance(defaultTheme, nextVisualStyle);
  }, [defaultTheme, defaultVisualStyle, storageKey, visualStyleStorageKey]);

  const setTheme = React.useCallback(
    (value: Theme) => {
      setThemeState(value);
      window.localStorage.setItem(storageKey, value);
      applyAppearance(value, visualStyle);
    },
    [storageKey, visualStyle]
  );

  const setVisualStyle = React.useCallback(
    (value: VisualStyle) => {
      setVisualStyleState(value);
      window.localStorage.setItem(visualStyleStorageKey, value);
      applyAppearance(theme, value);
    },
    [theme, visualStyleStorageKey]
  );

  const toggleVisualStyle = React.useCallback(
    () => {
      setVisualStyle(visualStyle === "app" ? "default" : "app");
    },
    [setVisualStyle, visualStyle]
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme, visualStyle, setVisualStyle, toggleVisualStyle }}>
      {children}
    </ThemeContext.Provider>
  );
}

function applyAppearance(theme: Theme, visualStyle: VisualStyle) {
  const root = window.document.documentElement;
  const resolved = visualStyle === "app" ? "light" : theme === "system" ? getSystemTheme() : theme;

  root.classList.remove("light", "dark", "style-app");
  root.classList.add(resolved);
  if (visualStyle === "app") {
    root.classList.add("style-app");
  }
}

function getSystemTheme(): Extract<Theme, "light" | "dark"> {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readVisualStyle(value: string | null): VisualStyle | null {
  return value === "app" || value === "default" ? value : null;
}
