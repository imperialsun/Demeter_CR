import * as React from "react";

import { ThemeContext, type Theme } from "./theme-context";

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = "dark",
  storageKey = "app-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme);

  React.useEffect(() => {
    const stored = window.localStorage.getItem(storageKey) as
      | "light"
      | "dark"
      | "system"
      | null;
    if (stored) {
      setThemeState(stored);
      applyTheme(stored);
      return;
    }
    applyTheme(defaultTheme);
  }, [defaultTheme, storageKey]);

  const setTheme = React.useCallback(
    (value: Theme) => {
      setThemeState(value);
      window.localStorage.setItem(storageKey, value);
      applyTheme(value);
    },
    [storageKey]
  );

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}

function applyTheme(theme: Theme) {
  const root = window.document.documentElement;
  const resolved = theme === "system" ? getSystemTheme() : theme;

  root.classList.remove("light", "dark");
  root.classList.add(resolved);
}

function getSystemTheme(): Extract<Theme, "light" | "dark"> {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
