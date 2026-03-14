import { isBackendMode } from "@/lib/runtime-config";
import logger from "@/lib/logger";

const BACKEND_AUTH_KEY = "demeter-backend-authenticated";
const BACKEND_SESSION_KEY = "demeter-backend-session";
const BACKEND_SESSION_CHANGE_EVENT = "demeter:backend-session-change";
let currentSession: BackendSessionPayload | null = null;

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

function getSessionStorageApi(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch (error) {
    logger.warn("[backend-session] sessionStorage unavailable", error);
    return null;
  }
}

function clearLegacyStorageArtifacts() {
  if (typeof window === "undefined") return;
  window.sessionStorage.removeItem(BACKEND_SESSION_KEY);
  window.localStorage.removeItem(BACKEND_AUTH_KEY);
  window.localStorage.removeItem(BACKEND_SESSION_KEY);
}

function cloneBackendSession(payload: BackendSessionPayload): BackendSessionPayload {
  return {
    user: { ...payload.user },
    organization: { ...payload.organization },
    globalRoles: [...payload.globalRoles],
    orgRoles: [...payload.orgRoles],
    permissions: [...payload.permissions],
    runtimeMode: payload.runtimeMode,
  };
}

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
  currentSession = cloneBackendSession(payload);
  const storage = getSessionStorageApi();
  storage?.setItem(BACKEND_AUTH_KEY, "1");
  clearLegacyStorageArtifacts();
  logger.info("[backend-session] session stored", {
    userId: payload.user.id,
    organizationId: payload.organization.id,
    permissionCount: payload.permissions.length,
    storage: "session-memory",
  });
  emitBackendSessionChange("session_set");
}

export function setBackendAuthenticatedFlag(value: boolean) {
  const storage = getSessionStorageApi();
  if (value) {
    storage?.setItem(BACKEND_AUTH_KEY, "1");
    clearLegacyStorageArtifacts();
    logger.info("[backend-session] auth flag set", {
      authenticated: true,
      hasSession: currentSession !== null,
    });
    emitBackendSessionChange("auth_flag_set");
    return;
  }
  currentSession = null;
  storage?.removeItem(BACKEND_AUTH_KEY);
  clearLegacyStorageArtifacts();
  logger.info("[backend-session] auth flag cleared");
  emitBackendSessionChange("session_cleared");
}

export function clearBackendSession() {
  currentSession = null;
  const storage = getSessionStorageApi();
  storage?.removeItem(BACKEND_AUTH_KEY);
  clearLegacyStorageArtifacts();
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
  const storage = getSessionStorageApi();
  return storage?.getItem(BACKEND_AUTH_KEY) === "1" && currentSession !== null;
}

export function getBackendSession(): BackendSessionPayload | null {
  return currentSession ? cloneBackendSession(currentSession) : null;
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
