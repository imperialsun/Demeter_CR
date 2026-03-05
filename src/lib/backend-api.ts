import { invalidateBackendSession } from "@/lib/backend-session";
import { getRuntimeConfig } from "@/lib/runtime-config";
import logger from "@/lib/logger";

export const BACKEND_FORBIDDEN_MESSAGE = "Accès refusé par vos permissions backend.";
export const BACKEND_UNAUTHORIZED_MESSAGE = "Session expirée. Veuillez vous reconnecter.";

export class BackendHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string;
  readonly method: string;

  constructor(params: { status: number; code: string; message: string; path: string; method: string }) {
    super(params.message);
    this.name = "BackendHttpError";
    this.status = params.status;
    this.code = params.code;
    this.path = params.path;
    this.method = params.method;
  }
}

function toBackendUrl(path: string): string {
  const { backendBaseUrl } = getRuntimeConfig();
  const base = backendBaseUrl.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

export function isBackendHttpError(error: unknown): error is BackendHttpError {
  return error instanceof BackendHttpError;
}

export function isBackendUnauthorizedError(error: unknown): boolean {
  return isBackendHttpError(error) && error.status === 401;
}

export function isBackendForbiddenError(error: unknown): boolean {
  return isBackendHttpError(error) && error.status === 403;
}

export function formatBackendErrorMessage(error: unknown): string {
  if (!isBackendHttpError(error)) {
    return error instanceof Error ? error.message : String(error);
  }

  if (error.status === 403 || error.code === "forbidden") {
    return BACKEND_FORBIDDEN_MESSAGE;
  }

  if (error.status === 401 || error.code === "unauthorized") {
    return BACKEND_UNAUTHORIZED_MESSAGE;
  }

  return error.message;
}

export function handleBackendUnauthorized(error: unknown): boolean {
  if (!isBackendUnauthorizedError(error)) {
    return false;
  }
  invalidateBackendSession({ redirectToLogin: true });
  return true;
}

export async function backendFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = toBackendUrl(path);
  const method = (init?.method ?? "GET").toUpperCase();
  const startedAt = performance.now();
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.headers ?? {}),
    },
  });
  logger.info("[backend-api] request completed", {
    method,
    path,
    status: response.status,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return response;
}

export async function parseBackendJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) {
    return {} as T;
  }
  return JSON.parse(text) as T;
}

type BackendErrorResponseBody = {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  path?: unknown;
};

function normalizeErrorCode(status: number, rawCode: unknown, rawError: unknown): string {
  if (typeof rawCode === "string" && rawCode.trim().length > 0) {
    return rawCode.trim();
  }

  if (typeof rawError === "string" && rawError.trim().length > 0) {
    return rawError.trim().toLowerCase().replace(/\s+/g, "_");
  }

  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  return `http_${status}`;
}

function normalizeErrorMessage(status: number, rawMessage: unknown, rawError: unknown): string {
  if (typeof rawMessage === "string" && rawMessage.trim().length > 0) {
    return rawMessage.trim();
  }

  if (typeof rawError === "string" && rawError.trim().length > 0) {
    return rawError.trim();
  }

  return `Backend error (${status})`;
}

export async function parseBackendHttpError(response: Response, path: string, method = "GET"): Promise<BackendHttpError> {
  const status = response.status;
  const text = await response.text();

  if (!text.trim()) {
    const fallbackError = new BackendHttpError({
      status,
      code: normalizeErrorCode(status, undefined, undefined),
      message: normalizeErrorMessage(status, undefined, undefined),
      path,
      method: method.toUpperCase(),
    });
    logger.warn("[backend-api] backend error response", {
      method: method.toUpperCase(),
      path,
      status,
      code: fallbackError.code,
      message: fallbackError.message,
    });
    return fallbackError;
  }

  try {
    const parsed = JSON.parse(text) as BackendErrorResponseBody;
    const message = normalizeErrorMessage(status, parsed.message, parsed.error);
    const code = normalizeErrorCode(status, parsed.code, parsed.error);
    const typedError = new BackendHttpError({
      status,
      code,
      message,
      path: typeof parsed.path === "string" && parsed.path.trim().length > 0 ? parsed.path : path,
      method: method.toUpperCase(),
    });

    logger.warn("[backend-api] backend error response", {
      method: method.toUpperCase(),
      path,
      status,
      code: typedError.code,
      message: typedError.message,
    });

    return typedError;
  } catch {
    const typedError = new BackendHttpError({
      status,
      code: normalizeErrorCode(status, undefined, undefined),
      message: text.trim() || normalizeErrorMessage(status, undefined, undefined),
      path,
      method: method.toUpperCase(),
    });

    logger.warn("[backend-api] backend error parse failed", {
      method: method.toUpperCase(),
      path,
      status,
      message: typedError.message,
    });

    return typedError;
  }
}

export async function throwBackendHttpError(response: Response, path: string, method = "GET"): Promise<never> {
  throw await parseBackendHttpError(response, path, method);
}

export async function readBackendError(response: Response, path = "unknown", method = "GET"): Promise<string> {
  const error = await parseBackendHttpError(response, path, method);
  return error.message;
}
