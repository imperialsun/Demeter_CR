export function isProdEnv(): boolean {
  return Boolean(import.meta.env.PROD);
}

export function getEnvMode(): string {
  return String(import.meta.env.MODE ?? "unknown");
}
