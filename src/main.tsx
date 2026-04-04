import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/components/ui/use-toast";
import { initializeBackendSupport } from "@/lib/backend-support";
import logger, {
  initializeLogCapture,
  setLogLevelProvider,
  setTelemetryProvider,
  resolveBootstrapLogLevel,
} from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import { initializeBackendSession } from "@/lib/backend-auth";
import { initializeBackendSettingsSync, pullBackendSettings } from "@/lib/backend-settings-sync";
import { flushBackendActivityQueueNow, initializeBackendActivitySync } from "@/lib/backend-activity-sync";
import { flushBackendPerformanceQueueNow, initializeBackendPerformanceSync } from "@/lib/backend-performance-sync";
import { replaceSettingsCacheFromBackend } from "@/lib/storage";
import { isAuthenticated, setAuthenticated } from "@/lib/auth";
import "./index.css";
import App from "./App";

import { useAsrStore } from "@/store/asr-store";
initializeLogCapture();
setLogLevelProvider(() => resolveBootstrapLogLevel(useAsrStore.getState()));
setTelemetryProvider(() => useAsrStore.getState().telemetryCollector);

logger.info("[app] bootstrap start", {
  runtimeMode: isBackendMode() ? "backend" : "standalone",
});

if (isBackendMode()) {
  logger.info("[app][backend] bootstrap start");
  initializeBackendSettingsSync();
  logger.info("[app][backend] settings sync initialized");
  initializeBackendActivitySync();
  logger.info("[app][backend] activity sync initialized");
  initializeBackendPerformanceSync();
  logger.info("[app][backend] performance sync initialized");
  const me = await initializeBackendSession();
  setAuthenticated(Boolean(me));
  logger.info("[app][auth] backend session resolved", {
    authenticated: Boolean(me),
    userId: me?.user.id ?? null,
    organizationId: me?.organization.id ?? null,
  });
  if (me) {
    logger.debug("[app][activity] flushing queued backend activity");
    await flushBackendActivityQueueNow();
    logger.info("[app][activity] queued backend activity flushed");
    logger.debug("[app][performance] flushing queued backend performance");
    await flushBackendPerformanceQueueNow();
    logger.info("[app][performance] queued backend performance flushed");
  }
} else {
  logger.info("[app][auth] standalone bootstrap", { authenticated: isAuthenticated() });
}

logger.info("[app][support] backend support initialization start");
await initializeBackendSupport();
logger.info("[app][support] backend support initialization done");
logger.info("[app][settings] hydrate from storage start");
useAsrStore.getState().hydrateFromStorage();
logger.info("[app][settings] hydrate from storage done", {
  logLevel: useAsrStore.getState().logLevel,
  blockedPresets: useAsrStore.getState().blockedPresets,
});

if (isBackendMode() && isAuthenticated()) {
  try {
    logger.info("[app][settings] backend bootstrap sync start");
    const serverSettings = await pullBackendSettings();
    if (serverSettings?.settings) {
      replaceSettingsCacheFromBackend(serverSettings.settings);
      useAsrStore.getState().hydrateFromStorage();
      logger.info("[app][settings] backend bootstrap sync applied", {
        keyCount: Object.keys(serverSettings.settings).length,
      });
    } else {
      logger.info("[app][settings] backend bootstrap sync skipped", {
        reason: "empty_settings",
      });
    }
  } catch (error) {
    logger.warn("[app] backend settings sync bootstrap failed", error);
  }
} else if (isBackendMode()) {
  logger.info("[app][settings] backend bootstrap sync skipped", {
    reason: "not_authenticated",
  });
}
logger.info("[app] settings hydrated from storage", {
  blockedPresets: useAsrStore.getState().blockedPresets,
});
logger.debug("[app] debug console channel active", {
  runtimeMode: isBackendMode() ? "backend" : "standalone",
  logLevel: useAsrStore.getState().logLevel,
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

logger.info("[app] react root render");
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
