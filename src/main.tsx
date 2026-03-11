import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/use-toast";
import { initializeBackendSupport } from "@/lib/backend-support";
import logger, {
  installConsoleGuard,
  setConsoleVisibilityPolicy,
  setDebugProvider,
  setTelemetryProvider,
} from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import { initializeBackendSession } from "@/lib/backend-auth";
import { initializeBackendSettingsSync, pullBackendSettings } from "@/lib/backend-settings-sync";
import { flushBackendActivityQueueNow, initializeBackendActivitySync } from "@/lib/backend-activity-sync";
import { replaceSettingsCacheFromBackend } from "@/lib/storage";
import { isAuthenticated, setAuthenticated } from "@/lib/auth";
import "./index.css";
import App from "./App";

// Configure logger provider after store is available so logger.enabled() can read runtime flag
import { useAsrStore } from "@/store/asr-store";
setDebugProvider(() => useAsrStore.getState().debugConfidence);
setTelemetryProvider(() => useAsrStore.getState().telemetryCollector);
setConsoleVisibilityPolicy("warn-error-only");
installConsoleGuard();

try {
  useAsrStore
    .getState()
    .telemetryCollector
    ?.logEvent?.("CONSOLE_GUARD_INSTALLED", {
      debugEnabled: useAsrStore.getState().debugConfidence,
    });
} catch (err) {
  void err;
}

if (isBackendMode()) {
  initializeBackendSettingsSync();
  initializeBackendActivitySync();
  const me = await initializeBackendSession();
  setAuthenticated(Boolean(me));
  if (me) {
    await flushBackendActivityQueueNow();
  }
}

await initializeBackendSupport();
useAsrStore.getState().hydrateFromStorage();

if (isBackendMode() && isAuthenticated()) {
  try {
    const serverSettings = await pullBackendSettings();
    if (serverSettings?.settings) {
      replaceSettingsCacheFromBackend(serverSettings.settings);
      useAsrStore.getState().hydrateFromStorage();
    }
  } catch (error) {
    logger.warn("[app] backend settings sync bootstrap failed", error);
  }
}
logger.info("[app] settings hydrated from storage", {
  blockedPresets: useAsrStore.getState().blockedPresets,
});

// Check runtime support and notify the user if no backend is available
{
  const state = useAsrStore.getState();
  if (!state.webGpuSupported && !state.wasmAvailable) {
    const message = "Aucun backend utilisable trouvé : WebGPU non supporté et fichiers WASM manquants ou inaccessibles (/onnx/). Vérifiez que les assets WASM sont déployés et que les en-têtes COOP/COEP sont configurés.";
    // Set UI status and emit a toast (deferred to allow Toaster to mount)
    state.setStatus("error", message);
    try {
      logger.error("[app] startup check failed: no backend available", {
        webGpuSupported: state.webGpuSupported,
        wasmAvailable: state.wasmAvailable,
      });
    } catch (err) {
      void err;
    }
    setTimeout(() => { try { toast(message); } catch (err) { void err; } }, 0);
  }
}

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
