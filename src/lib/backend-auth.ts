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

export async function backendRequestPasswordReset(email: string): Promise<void> {
  logger.info("[backend-auth] password reset request", { email });
  const path = "/auth/forgot-password";
  const response = await backendFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email }),
  });

  if (!response.ok) {
    logger.warn("[backend-auth] password reset request failed", { email, status: response.status });
    throw await parseBackendHttpError(response, path, "POST");
  }
}

export async function backendChangePassword(currentPassword: string, password: string): Promise<void> {
  logger.info("[backend-auth] password change request");
  const path = "/auth/me/password";
  const response = await backendFetch(path, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ currentPassword, password }),
  });

  if (!response.ok) {
    logger.warn("[backend-auth] password change failed", { status: response.status });
    throw await parseBackendHttpError(response, path, "PUT");
  }
}

export async function backendResetPassword(token: string, password: string): Promise<void> {
  logger.info("[backend-auth] password reset apply");
  const path = "/auth/reset-password";
  const response = await backendFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token, password }),
  });

  if (!response.ok) {
    logger.warn("[backend-auth] password reset apply failed", { status: response.status });
    throw await parseBackendHttpError(response, path, "POST");
  }
}

export async function backendRefresh(): Promise<boolean> {
  logger.info("[backend-auth] refresh request");
  const response = await backendFetch("/auth/refresh", { method: "POST" });
  if (response.status === 401) {
    logger.warn("[backend-auth] refresh unauthorized, invalidating session");
    invalidateBackendSession({ redirectToLogin: false });
  }
  logger.debug("[backend-auth] refresh response", { ok: response.ok, status: response.status });
  return response.ok;
}

export async function backendMe(): Promise<BackendSessionPayload | null> {
  const path = "/auth/me";
  logger.info("[backend-auth] me request");
  const response = await backendFetch(path);
  if (response.status === 401) {
    logger.debug("[backend-auth] me unauthorized");
    invalidateBackendSession({ redirectToLogin: false });
    return null;
  }
  if (!response.ok) {
    logger.warn("[backend-auth] me failed", { status: response.status });
    throw await parseBackendHttpError(response, path);
  }
  const payload = await parseBackendJson<BackendSessionPayload>(response);
  setBackendSession(payload);
  logger.debug("[backend-auth] me success", {
    userId: payload.user.id,
    organizationId: payload.organization.id,
  });
  return payload;
}

export async function initializeBackendSession(): Promise<BackendSessionPayload | null> {
  logger.info("[backend-auth] session init start");
  try {
    const me = await backendMe();
    if (me) {
      logger.info("[backend-auth] session init completed from me");
      return me;
    }
    logger.info("[backend-auth] session init retrying via refresh");
    const refreshed = await backendRefresh();
    if (!refreshed) {
      clearBackendSession();
      logger.warn("[backend-auth] session init failed after refresh");
      return null;
    }
    const meAfterRefresh = await backendMe();
    if (!meAfterRefresh) {
      clearBackendSession();
      logger.warn("[backend-auth] session init missing user after refresh");
      return null;
    }
    logger.info("[backend-auth] session init completed after refresh");
    return meAfterRefresh;
  } catch (error) {
    logger.warn("[backend-auth] session init failed, clearing local session", error);
    clearBackendSession();
    return null;
  }
}

export async function backendLogout(): Promise<void> {
  logger.info("[backend-auth] logout request start");
  try {
    await backendFetch("/auth/logout", { method: "POST" });
    logger.info("[backend-auth] logout request sent");
  } finally {
    clearBackendSession();
    logger.info("[backend-auth] local session cleared");
  }
}
