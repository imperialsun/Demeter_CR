import { isBackendMode } from "@/lib/runtime-config";
import logger from "@/lib/logger";

const BACKEND_AUTH_KEY = "demeter-backend-authenticated";
const BACKEND_SESSION_KEY = "demeter-backend-session";
const BACKEND_SESSION_CHANGE_EVENT = "demeter:backend-session-change";

export interface BackendSessionPayload {
  user: {
    id: string;
    email: string;
    status: string;
  };
  organization: {
    id: string;
    name: string;
    code: string;
    status: string;
  };
  globalRoles: string[];
  orgRoles: string[];
  permissions: string[];
  runtimeMode?: string;
}

export interface BackendSessionChangeDetail {
  authenticated: boolean;
  permissions: string[];
  reason: "session_set" | "auth_flag_set" | "session_cleared";
}

const ROUTE_PERMISSION_MAP: Array<{ path: string; permission: string }> = [
  { path: "/localupload", permission: "feature.localupload" },
  { path: "/cloudupload", permission: "feature.cloudupload" },
  { path: "/llmlocal", permission: "feature.llmlocal" },
  { path: "/llmapi", permission: "feature.llmapi" },
  { path: "/settings", permission: "feature.settings" },
  { path: "/telemetry", permission: "feature.telemetry" },
];

function emitBackendSessionChange(reason: BackendSessionChangeDetail["reason"]) {
  if (typeof window === "undefined") return;
  logger.info("[backend-session] session change emitted", {
    reason,
    authenticated: isBackendAuthenticated(),
    permissionCount: getBackendPermissions().length,
  });
  window.dispatchEvent(
    new CustomEvent<BackendSessionChangeDetail>(BACKEND_SESSION_CHANGE_EVENT, {
      detail: {
        authenticated: isBackendAuthenticated(),
        permissions: getBackendPermissions(),
        reason,
      },
    })
  );
}

export function subscribeBackendSessionChange(
  listener: (detail: BackendSessionChangeDetail) => void
): () => void {
  if (typeof window === "undefined") {
    return () => {
      // no-op in SSR/tests without window
    };
  }

  const onChange = (event: Event) => {
    const customEvent = event as CustomEvent<BackendSessionChangeDetail>;
    listener(customEvent.detail);
  };

  window.addEventListener(BACKEND_SESSION_CHANGE_EVENT, onChange as EventListener);
  return () => {
    window.removeEventListener(BACKEND_SESSION_CHANGE_EVENT, onChange as EventListener);
  };
}

export function setBackendSession(payload: BackendSessionPayload) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(BACKEND_AUTH_KEY, "1");
  window.localStorage.setItem(BACKEND_SESSION_KEY, JSON.stringify(payload));
  logger.info("[backend-session] session stored", {
    userId: payload.user.id,
    organizationId: payload.organization.id,
    permissionCount: payload.permissions.length,
  });
  emitBackendSessionChange("session_set");
}

export function setBackendAuthenticatedFlag(value: boolean) {
  if (typeof window === "undefined") return;
  if (value) {
    window.localStorage.setItem(BACKEND_AUTH_KEY, "1");
    logger.info("[backend-session] auth flag set", { authenticated: true });
    emitBackendSessionChange("auth_flag_set");
    return;
  }
  window.localStorage.removeItem(BACKEND_AUTH_KEY);
  logger.info("[backend-session] auth flag cleared");
  emitBackendSessionChange("session_cleared");
}

export function clearBackendSession() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(BACKEND_AUTH_KEY);
  window.localStorage.removeItem(BACKEND_SESSION_KEY);
  logger.info("[backend-session] session cleared");
  emitBackendSessionChange("session_cleared");
}

export function invalidateBackendSession(options?: { redirectToLogin?: boolean }) {
  logger.warn("[backend-session] invalidating session", {
    redirectToLogin: Boolean(options?.redirectToLogin),
  });
  clearBackendSession();
  if (!options?.redirectToLogin) return;
  if (typeof window === "undefined") return;
  if (window.location.pathname === "/login") return;
  logger.warn("[backend-session] redirecting to login after invalidation", {
    from: window.location.pathname,
  });
  window.location.assign("/login");
}

export function isBackendAuthenticated(): boolean {
  if (!isBackendMode()) return false;
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(BACKEND_AUTH_KEY) === "1";
}

export function getBackendSession(): BackendSessionPayload | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(BACKEND_SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BackendSessionPayload;
  } catch (error) {
    logger.warn("[backend-session] failed to parse stored session", error);
    return null;
  }
}

export function getBackendPermissions(): string[] {
  return getBackendSession()?.permissions ?? [];
}

export function hasBackendPermission(code: string): boolean {
  if (!isBackendMode()) return true;
  if (!isBackendAuthenticated()) return false;
  return getBackendPermissions().includes(code);
}

export function getDefaultAuthorizedRoute(): string {
  if (!isBackendMode()) return "/localupload";
  for (const item of ROUTE_PERMISSION_MAP) {
    if (hasBackendPermission(item.permission)) {
      return item.path;
    }
  }
  return "/forbidden";
}

export function canAccessRoute(pathname: string): boolean {
  if (!isBackendMode()) return true;
  const match = ROUTE_PERMISSION_MAP.find((item) => item.path === pathname);
  if (!match) return true;
  return hasBackendPermission(match.permission);
}
