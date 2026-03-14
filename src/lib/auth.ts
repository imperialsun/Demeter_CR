import { compareSync } from "bcryptjs";
import logger from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import {
  clearBackendSession,
  isBackendAuthenticated,
  setBackendAuthenticatedFlag,
} from "@/lib/backend-session";

const LOGIN_HASHES: string[] = typeof __LOGIN_HASHES__ !== "undefined" ? __LOGIN_HASHES__ : [];
try {
  logger.info("Auth hashes loaded", { count: LOGIN_HASHES.length });
} catch (err) {
  void err;
}

export function isAuthenticated(): boolean {
  if (isBackendMode()) {
    return isBackendAuthenticated();
  }
  return true;
}

export function setAuthenticated(value: boolean): void {
  if (typeof window === "undefined") return;
  if (isBackendMode()) {
    if (value) {
      setBackendAuthenticatedFlag(true);
    } else {
      clearBackendSession();
    }
    return;
  }
  logger.debug("[auth] standalone auth state remains in-memory only", { authenticated: value });
}

export function isPasswordValid(password: string): boolean {
  if (!password) return false;
  if (!LOGIN_HASHES.length) return false;
  return LOGIN_HASHES.some((hash) => {
    try {
      return compareSync(password, hash);
    } catch (err) {
      void err;
      return false;
    }
  });
}
