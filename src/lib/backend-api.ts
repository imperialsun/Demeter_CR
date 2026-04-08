import { invalidateBackendSession } from "@/lib/backend-session";
import { backendRefresh } from "@/lib/backend-auth";
import { getRuntimeConfig } from "@/lib/runtime-config";
import logger from "@/lib/logger";

export const BACKEND_FORBIDDEN_MESSAGE = "Accès refusé par vos permissions backend.";
export const BACKEND_UNAUTHORIZED_MESSAGE = "Session expirée. Veuillez vous reconnecter.";
export const BACKEND_NETWORK_ERROR_MESSAGE =
  "Impossible de joindre le backend. Vérifiez l'accès réseau à l'API puis réessayez.";
export const BACKEND_TIMEOUT_ERROR_MESSAGE =
  "Le backend met trop de temps à répondre. Réessayez dans quelques instants.";

const DEFAULT_SAFE_TIMEOUT_MS = 15_000;
const DEFAULT_MUTATING_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_INITIAL_BACKOFF_MS = 300;
const DEFAULT_RETRY_MAX_BACKOFF_MS = 2_000;
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRYABLE_HTTP_STATUSES = new Set([404, 408, 502, 503, 504]);
const SESSION_REFRESH_EXEMPT_PATHS = new Set([
  "/auth/login",
  "/auth/refresh",
  "/auth/logout",
  "/auth/forgot-password",
  "/auth/reset-password",
]);

export type BackendFetchOptions = RequestInit & {
  timeoutMs?: number;
  retryAttempts?: number;
  retryInitialBackoffMs?: number;
  retryMaxBackoffMs?: number;
  allowSessionRefresh?: boolean;
};

export class BackendTimeoutError extends Error {
  readonly path: string;
  readonly method: string;
  readonly url: string;
  readonly timeoutMs: number;

  constructor(params: { path: string; method: string; url: string; timeoutMs: number }) {
    super(
      `${BACKEND_TIMEOUT_ERROR_MESSAGE} (${params.method} ${params.path} -> ${params.url}, délai ${params.timeoutMs} ms)`
    );
    this.name = "BackendTimeoutError";
    this.path = params.path;
    this.method = params.method;
    this.url = params.url;
    this.timeoutMs = params.timeoutMs;
  }
}

export class BackendHttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly path: string;
  readonly method: string;
  readonly traceId?: string;
  readonly fileName?: string;
  readonly fileSizeBytes?: number;
  readonly mimeType?: string;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    path: string;
    method: string;
    traceId?: string;
    fileName?: string;
    fileSizeBytes?: number;
    mimeType?: string;
  }) {
    super(params.message);
    this.name = "BackendHttpError";
    this.status = params.status;
    this.code = params.code;
    this.path = params.path;
    this.method = params.method;
    this.traceId = params.traceId;
    this.fileName = params.fileName;
    this.fileSizeBytes = params.fileSizeBytes;
    this.mimeType = params.mimeType;
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

  if (error.code === "empty_audio_file") {
    return "Fichier audio vide.";
  }

  if (error.code === "invalid_audio_file" || error.code === "invalid_request_file") {
    return "Fichier audio invalide.";
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

const AUDIO_VALIDATION_ERROR_CODES = new Set(["empty_audio_file", "invalid_audio_file", "invalid_request_file", "3310"]);

function isAudioValidationMessage(message: string): boolean {
  return /audio input could not be decoded|fichier audio vide|fichier audio invalide/i.test(message);
}

export function isBackendAudioValidationError(error: unknown): boolean {
  if (!isBackendHttpError(error)) {
    return false;
  }
  if (error.status !== 400) {
    return false;
  }
  return AUDIO_VALIDATION_ERROR_CODES.has(error.code) || isAudioValidationMessage(error.message);
}

export function shouldRetryAudioUpload(error: unknown): boolean {
  if (isBackendAudioValidationError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return isAudioValidationMessage(message) || /invalid_request_file/i.test(message);
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === "AbortError";
}

function isNetworkFetchError(error: unknown): boolean {
  if (error instanceof TypeError) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|networkerror|load failed/i.test(message);
}

function isRetryableMethod(method: string): boolean {
  return RETRYABLE_METHODS.has(method);
}

function isRetryableHttpStatus(status: number): boolean {
  return RETRYABLE_HTTP_STATUSES.has(status);
}

function canAttemptSessionRefresh(path: string, init?: BackendFetchOptions): boolean {
  if (init?.allowSessionRefresh === false) {
    return false;
  }

  return !SESSION_REFRESH_EXEMPT_PATHS.has(path);
}

async function refreshBackendSession(): Promise<boolean> {
  const refreshResult = await backendRefresh();
  return refreshResult === "refreshed";
}

export function isBackendRetryableTransportError(error: unknown): boolean {
  if (error instanceof BackendTimeoutError || isNetworkFetchError(error)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes(BACKEND_NETWORK_ERROR_MESSAGE) || message.includes(BACKEND_TIMEOUT_ERROR_MESSAGE);
}

function getDefaultTimeoutMs(method: string): number {
  return isRetryableMethod(method) ? DEFAULT_SAFE_TIMEOUT_MS : DEFAULT_MUTATING_TIMEOUT_MS;
}

function calculateRetryDelayMs(attempt: number, initialBackoffMs: number, maxBackoffMs: number): number {
  return Math.min(initialBackoffMs * 2 ** attempt, maxBackoffMs);
}

function normalizeBackendFetchError(error: unknown, path: string, method: string, url: string): Error {
  if (isAbortError(error)) {
    return error;
  }
  if (error instanceof BackendTimeoutError) {
    return error;
  }
  if (isNetworkFetchError(error)) {
    return new Error(`${BACKEND_NETWORK_ERROR_MESSAGE} (${method} ${path} -> ${url})`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  path: string,
  method: string,
  timeoutMs: number
): Promise<Response> {
  const externalSignal = init.signal;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
  let timedOut = false;

  const onExternalAbort = () => {
    controller.abort();
  };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  if (timeoutMs > 0) {
    timeoutId = globalThis.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  try {
    return await fetch(url, {
      ...init,
      credentials: "include",
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut && isAbortError(error)) {
      throw new BackendTimeoutError({
        path,
        method,
        url,
        timeoutMs,
      });
    }
    throw error;
  } finally {
    if (timeoutId !== undefined) {
      globalThis.clearTimeout(timeoutId);
    }
    if (externalSignal) {
      externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

export async function backendFetch(path: string, init?: BackendFetchOptions): Promise<Response> {
  const url = toBackendUrl(path);
  const method = (init?.method ?? "GET").toUpperCase();
  const retryAttempts = init?.retryAttempts ?? (isRetryableMethod(method) ? DEFAULT_RETRY_ATTEMPTS : 0);
  const retryInitialBackoffMs = init?.retryInitialBackoffMs ?? DEFAULT_RETRY_INITIAL_BACKOFF_MS;
  const retryMaxBackoffMs = init?.retryMaxBackoffMs ?? DEFAULT_RETRY_MAX_BACKOFF_MS;
  const timeoutMs = init?.timeoutMs ?? getDefaultTimeoutMs(method);
  const allowSessionRefresh = canAttemptSessionRefresh(path, init);
  const startedAt = performance.now();

  let attempt = 0;
  let sessionRefreshAttempted = false;
  while (true) {
    try {
      const response = await fetchWithTimeout(url, init ?? {}, path, method, timeoutMs);
      if (response.status === 401 && allowSessionRefresh && !sessionRefreshAttempted) {
        sessionRefreshAttempted = true;
        logger.info("[backend-api] unauthorized response, attempting session refresh", {
          method,
          path,
          url,
        });

        try {
          const refreshed = await refreshBackendSession();
          if (refreshed) {
            logger.info("[backend-api] session refresh succeeded, retrying request", {
              method,
              path,
              url,
            });
            continue;
          }

          logger.info("[backend-api] session refresh expired or unavailable", {
            method,
            path,
            url,
          });
        } catch (error) {
          logger.warn("[backend-api] session refresh attempt failed", {
            method,
            path,
            url,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (isRetryableHttpStatus(response.status) && attempt < retryAttempts) {
        const delayMs = calculateRetryDelayMs(attempt, retryInitialBackoffMs, retryMaxBackoffMs);
        logger.warn("[backend-api] retryable response", {
          method,
          path,
          url,
          status: response.status,
          attempt: attempt + 1,
          delayMs,
        });
        attempt += 1;
        await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
        continue;
      }

      logger.debug("[backend-api] request completed", {
        method,
        path,
        status: response.status,
        durationMs: Math.round(performance.now() - startedAt),
        attempts: attempt + 1,
      });
      return response;
    } catch (error) {
      const normalizedError = normalizeBackendFetchError(error, path, method, url);
      if (attempt < retryAttempts && isBackendRetryableTransportError(error)) {
        const delayMs = calculateRetryDelayMs(attempt, retryInitialBackoffMs, retryMaxBackoffMs);
        logger.warn("[backend-api] retrying request after transport failure", {
          method,
          path,
          url,
          attempt: attempt + 1,
          delayMs,
          message: normalizedError.message,
        });
        attempt += 1;
        await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
        continue;
      }

      logger.error("[backend-api] request failed", {
        method,
        path,
        url,
        durationMs: Math.round(performance.now() - startedAt),
        attempts: attempt + 1,
        message: normalizedError.message,
      });
      throw normalizedError;
    }
  }
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
  traceId?: unknown;
  fileName?: unknown;
  fileSizeBytes?: unknown;
  mimeType?: unknown;
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
    const fileSizeBytes =
      typeof parsed.fileSizeBytes === "number" && Number.isFinite(parsed.fileSizeBytes)
        ? parsed.fileSizeBytes
        : typeof parsed.fileSizeBytes === "string" && parsed.fileSizeBytes.trim().length > 0
          ? Number(parsed.fileSizeBytes)
          : undefined;
    const typedError = new BackendHttpError({
      status,
      code,
      message,
      path: typeof parsed.path === "string" && parsed.path.trim().length > 0 ? parsed.path : path,
      method: method.toUpperCase(),
      traceId: typeof parsed.traceId === "string" && parsed.traceId.trim().length > 0 ? parsed.traceId.trim() : undefined,
      fileName: typeof parsed.fileName === "string" && parsed.fileName.trim().length > 0 ? parsed.fileName.trim() : undefined,
      fileSizeBytes: Number.isFinite(fileSizeBytes) ? fileSizeBytes : undefined,
      mimeType: typeof parsed.mimeType === "string" && parsed.mimeType.trim().length > 0 ? parsed.mimeType.trim() : undefined,
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
