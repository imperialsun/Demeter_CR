import * as React from "react";

export type Theme = "light" | "dark" | "system";
export type VisualStyle = "default" | "app";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  visualStyle: VisualStyle;
  setVisualStyle: (style: VisualStyle) => void;
  toggleVisualStyle: () => void;
};

export const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export function useTheme() {
  const context = React.useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
