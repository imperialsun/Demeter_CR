export type RuntimeMode = "standalone" | "backend";

export interface RuntimeConfig {
  mode: RuntimeMode;
  backendBaseUrl: string;
}

const DEFAULT_CONFIG: RuntimeConfig = {
  mode: "standalone",
  backendBaseUrl: "/api/v1",
};

let cachedConfig: RuntimeConfig | null = null;

function normalizeBackendBaseUrl(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return DEFAULT_CONFIG.backendBaseUrl;
  return trimmed.replace(/\/+$/, "");
}

function normalizeMode(value: string | undefined): RuntimeMode {
  return value === "backend" ? "backend" : "standalone";
}

export function getRuntimeConfig(): RuntimeConfig {
  if (cachedConfig) return cachedConfig;
  if (typeof window === "undefined") {
    cachedConfig = DEFAULT_CONFIG;
    return cachedConfig;
  }

  const fromWindow = window.__APP_RUNTIME_CONFIG__;
  cachedConfig = {
    mode: normalizeMode(fromWindow?.mode),
    backendBaseUrl: normalizeBackendBaseUrl(fromWindow?.backendBaseUrl),
  };
  return cachedConfig;
}

export function isBackendMode(): boolean {
  return getRuntimeConfig().mode === "backend";
}
