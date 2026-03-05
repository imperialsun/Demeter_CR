import { backendFetch, parseBackendJson, parseBackendHttpError } from "@/lib/backend-api";
import {
  clearBackendSession,
  invalidateBackendSession,
  setBackendSession,
  type BackendSessionPayload,
} from "@/lib/backend-session";
import logger from "@/lib/logger";

export async function backendLogin(email: string, password: string): Promise<BackendSessionPayload> {
  logger.info("[backend-auth] login request", { email });
  const path = "/auth/login";
  const response = await backendFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    logger.warn("[backend-auth] login failed", { email, status: response.status });
    throw await parseBackendHttpError(response, path, "POST");
  }

  const payload = await parseBackendJson<BackendSessionPayload>(response);
  setBackendSession(payload);
  logger.info("[backend-auth] login success", {
    userId: payload.user.id,
    organizationId: payload.organization.id,
  });
  return payload;
}

export async function backendRefresh(): Promise<boolean> {
  const response = await backendFetch("/auth/refresh", { method: "POST" });
  if (response.status === 401) {
    invalidateBackendSession({ redirectToLogin: false });
  }
  logger.info("[backend-auth] refresh response", { ok: response.ok, status: response.status });
  return response.ok;
}

export async function backendMe(): Promise<BackendSessionPayload | null> {
  const path = "/auth/me";
  const response = await backendFetch(path);
  if (response.status === 401) {
    logger.info("[backend-auth] me unauthorized");
    invalidateBackendSession({ redirectToLogin: false });
    return null;
  }
  if (!response.ok) {
    logger.warn("[backend-auth] me failed", { status: response.status });
    throw await parseBackendHttpError(response, path);
  }
  const payload = await parseBackendJson<BackendSessionPayload>(response);
  setBackendSession(payload);
  logger.info("[backend-auth] me success", {
    userId: payload.user.id,
    organizationId: payload.organization.id,
  });
  return payload;
}

export async function initializeBackendSession(): Promise<BackendSessionPayload | null> {
  try {
    const me = await backendMe();
    if (me) return me;
    const refreshed = await backendRefresh();
    if (!refreshed) {
      clearBackendSession();
      return null;
    }
    const meAfterRefresh = await backendMe();
    if (!meAfterRefresh) {
      clearBackendSession();
      return null;
    }
    return meAfterRefresh;
  } catch {
    logger.warn("[backend-auth] session init failed, clearing local session");
    clearBackendSession();
    return null;
  }
}

export async function backendLogout(): Promise<void> {
  try {
    await backendFetch("/auth/logout", { method: "POST" });
    logger.info("[backend-auth] logout request sent");
  } finally {
    clearBackendSession();
    logger.info("[backend-auth] local session cleared");
  }
}
