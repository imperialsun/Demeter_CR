/// <reference types="vite/client" />

declare const __LOGIN_HASHES__: string[];

interface Window {
  __APP_RUNTIME_CONFIG__?: {
    mode?: "standalone" | "backend";
    backendBaseUrl?: string;
  };
}
