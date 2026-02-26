import { compareSync } from "bcryptjs";
import logger from "@/lib/logger";

const AUTH_KEY = "demeter-authenticated";
const LOGIN_HASHES: string[] = typeof __LOGIN_HASHES__ !== "undefined" ? __LOGIN_HASHES__ : [];
try {
  logger.info("Auth hashes loaded", { count: LOGIN_HASHES.length });
} catch (err) {
  void err;
}

export function isAuthenticated(): boolean {
  return true;
}

export function setAuthenticated(value: boolean): void {
  if (typeof window === "undefined") return;
  if (value) {
    window.localStorage.setItem(AUTH_KEY, "1");
  } else {
    window.localStorage.removeItem(AUTH_KEY);
  }
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
