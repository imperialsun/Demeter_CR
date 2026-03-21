import {
  backendFetch,
  formatBackendErrorMessage,
  handleBackendUnauthorized,
  isBackendForbiddenError,
  isBackendUnauthorizedError,
  parseBackendHttpError,
  parseBackendJson,
} from "@/lib/backend-api";
import { backendRefresh } from "@/lib/backend-auth";
import { isBackendAuthenticated } from "@/lib/backend-session";
import { isBackendMode } from "@/lib/runtime-config";
import logger from "@/lib/logger";

const RETRY_DELAY_MS = 5000;
const SAVE_DEBOUNCE_MS = 1000;
const LEGACY_SETTINGS_KEYS = ["cloudApiUrl", "cloudContextPreset"] as const;

let pendingSettings: Record<string, unknown> | null = null;
let debounceTimer: number | null = null;
let retryTimer: number | null = null;
let inFlight = false;
let listenersReady = false;

export type BackendSettingsEnvelope = {
  version: number;
  schemaVersion: number;
  updatedAt: string;
  settings: Record<string, unknown>;
};

function stripLegacySettings(settings: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...settings };
  for (const key of LEGACY_SETTINGS_KEYS) {
    delete sanitized[key];
  }
  return sanitized;
}

export function initializeBackendSettingsSync() {
  if (listenersReady || typeof window === "undefined") return;
  listenersReady = true;
  window.addEventListener("online", () => {
    logger.info("[backend-settings-sync] network online, triggering sync flush");
    void flushNow();
  });
}

export function queueBackendSettingsSync(settings: Record<string, unknown>) {
  if (!isBackendMode() || !isBackendAuthenticated()) return;
  pendingSettings = stripLegacySettings(settings);
  logger.debug("[backend-settings-sync] queued settings update", {
    keys: Object.keys(pendingSettings).length,
  });
  if (typeof window === "undefined") return;
  if (debounceTimer) {
    window.clearTimeout(debounceTimer);
  }
  debounceTimer = window.setTimeout(() => {
    debounceTimer = null;
    void flushNow();
  }, SAVE_DEBOUNCE_MS);
}

export async function flushNow() {
  if (!isBackendMode() || !isBackendAuthenticated()) return;
  if (inFlight || !pendingSettings) return;
  inFlight = true;
  logger.debug("[backend-settings-sync] flush start");

  try {
    const snapshot = pendingSettings;
    if (!snapshot) {
      clearRetry();
      return;
    }
    await sendSettingsSnapshot(snapshot);
    if (pendingSettings === snapshot) {
      pendingSettings = null;
    }
    logger.debug("[backend-settings-sync] flush success");
    clearRetry();
  } catch (error) {
    if (isBackendUnauthorizedError(error)) {
      logger.warn("[backend-settings-sync] unauthorized, attempting refresh", {
        error: formatBackendErrorMessage(error),
      });
      let refreshed = false;
      try {
        refreshed = await backendRefresh();
      } catch (refreshError) {
        logger.warn("[backend-settings-sync] refresh request failed", {
          error: refreshError instanceof Error ? refreshError.message : String(refreshError),
        });
        scheduleRetry();
        return;
      }
      if (!refreshed) {
        handleBackendUnauthorized(error);
        clearRetry();
        logger.warn("[backend-settings-sync] refresh failed, stopping retries", {
          error: formatBackendErrorMessage(error),
        });
        return;
      }

      try {
        const snapshot = pendingSettings;
        if (!snapshot) {
          clearRetry();
          return;
        }
        await sendSettingsSnapshot(snapshot);
        if (pendingSettings === snapshot) {
          pendingSettings = null;
        }
        logger.debug("[backend-settings-sync] flush success after refresh");
        clearRetry();
        return;
      } catch (retryError) {
        if (isBackendUnauthorizedError(retryError)) {
          handleBackendUnauthorized(retryError);
          clearRetry();
          logger.warn("[backend-settings-sync] unauthorized after refresh, stopping retries", {
            error: formatBackendErrorMessage(retryError),
          });
          return;
        }

        if (isBackendForbiddenError(retryError)) {
          clearRetry();
          logger.warn("[backend-settings-sync] forbidden after refresh, stopping retries", {
            error: formatBackendErrorMessage(retryError),
          });
          return;
        }

        logger.warn("[backend-settings-sync] flush retry failed, scheduling retry", {
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        scheduleRetry();
        return;
      }
    }

    if (isBackendForbiddenError(error)) {
      clearRetry();
      logger.warn("[backend-settings-sync] forbidden, stopping retries", {
        error: formatBackendErrorMessage(error),
      });
      return;
    }

    logger.warn("[backend-settings-sync] flush failed, scheduling retry", {
      error: error instanceof Error ? error.message : String(error),
    });
    scheduleRetry();
  } finally {
    inFlight = false;
  }
}

async function sendSettingsSnapshot(snapshot: Record<string, unknown>) {
  const response = await backendFetch("/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: 1,
      settings: snapshot,
    }),
  });

  if (!response.ok) {
    throw await parseBackendHttpError(response, "/settings", "PUT");
  }

  return response;
}

export async function pullBackendSettings(): Promise<BackendSettingsEnvelope | null> {
  if (!isBackendMode() || !isBackendAuthenticated()) return null;
  const requestSettings = () => backendFetch("/settings", { method: "GET" });

  const parseSettingsEnvelope = async (response: Response) => {
    const payload = await parseBackendJson<BackendSettingsEnvelope>(response);
    return {
      ...payload,
      settings: stripLegacySettings(payload.settings),
    };
  };

  let response = await requestSettings();
  if (response.ok) {
    const payload = await parseSettingsEnvelope(response);
    logger.debug("[backend-settings-sync] pull success", { version: payload.version });
    return payload;
  }

  const error = await parseBackendHttpError(response, "/settings", "GET");
  if (isBackendForbiddenError(error)) {
    logger.debug("[backend-settings-sync] pull forbidden", { status: error.status });
    return null;
  }
  if (!isBackendUnauthorizedError(error)) {
    logger.warn("[backend-settings-sync] pull failed", { status: error.status, message: error.message });
    throw error;
  }

  logger.warn("[backend-settings-sync] pull unauthorized, attempting refresh", {
    error: formatBackendErrorMessage(error),
  });
  try {
    const refreshed = await backendRefresh();
    if (!refreshed) {
      if (!isBackendAuthenticated()) {
        handleBackendUnauthorized(error);
      }
      logger.warn("[backend-settings-sync] pull refresh failed", {
        error: formatBackendErrorMessage(error),
      });
      return null;
    }
  } catch (refreshError) {
    logger.warn("[backend-settings-sync] pull refresh request failed", {
      error: refreshError instanceof Error ? refreshError.message : String(refreshError),
    });
    return null;
  }

  response = await requestSettings();
  if (response.ok) {
    const payload = await parseSettingsEnvelope(response);
    logger.debug("[backend-settings-sync] pull success after refresh", { version: payload.version });
    return payload;
  }

  const retryError = await parseBackendHttpError(response, "/settings", "GET");
  if (isBackendForbiddenError(retryError)) {
    logger.debug("[backend-settings-sync] pull forbidden after refresh", { status: retryError.status });
    return null;
  }
  if (isBackendUnauthorizedError(retryError)) {
    handleBackendUnauthorized(retryError);
    logger.debug("[backend-settings-sync] pull unauthorized after refresh", { status: retryError.status });
    return null;
  }
  logger.warn("[backend-settings-sync] pull failed after refresh", {
    status: retryError.status,
    message: retryError.message,
  });
  throw retryError;
}

function clearRetry() {
  if (typeof window === "undefined") return;
  if (retryTimer) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function scheduleRetry() {
  if (typeof window === "undefined") return;
  if (retryTimer) return;
  retryTimer = window.setTimeout(() => {
    retryTimer = null;
    logger.debug("[backend-settings-sync] retry flush");
    void flushNow();
  }, RETRY_DELAY_MS);
}
