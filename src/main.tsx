import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { initializeBackendSupport } from "@/lib/backend-support";
import "./index.css";
import App from "./App";

// Configure logger provider after store is available so logger.enabled() can read runtime flag
import { setDebugProvider } from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";
setDebugProvider(() => useAsrStore.getState().debugConfidence);

await initializeBackendSupport();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark" storageKey="demeter-theme">
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster />
    </ThemeProvider>
  </StrictMode>
);
