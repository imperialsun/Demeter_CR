import { TestCookieJar } from "./cookieJar";
import { ensureBackendHarness } from "./harness";

export async function createAppCookieJar() {
  const nativeFetch = globalThis.__demeterNativeFetch ?? globalThis.fetch.bind(globalThis);
  return new TestCookieJar(nativeFetch);
}

export async function configureBackendRuntime() {
  const harness = await ensureBackendHarness();
  window.__APP_RUNTIME_CONFIG__ = {
    mode: "backend",
    backendBaseUrl: `${harness.baseUrl}/api/v1`,
  };
  return harness;
}

export function resetBrowserState() {
  window.localStorage.clear();
  window.sessionStorage.clear();
}
