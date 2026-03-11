type StoredCookie = {
  name: string;
  value: string;
  path: string;
  expiresAt?: number;
};

function normalizePath(value: string | null): string {
  if (!value || !value.startsWith("/")) return "/";
  return value;
}

function splitSetCookieHeader(header: string): string[] {
  const cookies: string[] = [];
  let current = "";
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    const next = header.slice(index, index + 8).toLowerCase();

    if (next === "expires=") {
      inExpires = true;
    }

    if (char === ",") {
      if (inExpires) {
        current += char;
        continue;
      }
      cookies.push(current.trim());
      current = "";
      continue;
    }

    if (char === ";" && inExpires) {
      inExpires = false;
    }

    current += char;
  }

  if (current.trim()) {
    cookies.push(current.trim());
  }

  return cookies;
}

export class TestCookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(private readonly nativeFetch: typeof fetch) {}

  installGlobally() {
    const jarFetch = this.fetch.bind(this) as typeof fetch;
    const previousFetch = globalThis.fetch;
    globalThis.fetch = jarFetch;
    if (typeof window !== "undefined") {
      window.fetch = jarFetch;
    }
    return () => {
      globalThis.fetch = previousFetch;
      if (typeof window !== "undefined") {
        window.fetch = previousFetch;
      }
    };
  }

  clear() {
    this.cookies.clear();
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    const cookieHeader = this.buildCookieHeader(new URL(request.url));
    if (cookieHeader && !headers.has("cookie")) {
      headers.set("cookie", cookieHeader);
    }

    const response = await this.nativeFetch(request, {
      headers,
      credentials: init?.credentials ?? "include",
      signal: init?.signal ?? request.signal,
    });

    this.storeResponseCookies(response);
    return response;
  }

  private buildCookieHeader(url: URL): string {
    const now = Date.now();
    const values: string[] = [];

    for (const cookie of this.cookies.values()) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(this.cookieKey(cookie.name, cookie.path));
        continue;
      }
      if (!url.pathname.startsWith(cookie.path)) continue;
      values.push(`${cookie.name}=${cookie.value}`);
    }

    return values.join("; ");
  }

  private storeResponseCookies(response: Response) {
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const rawHeaders = getSetCookie ? getSetCookie() : splitSetCookieHeader(response.headers.get("set-cookie") ?? "");

    for (const rawHeader of rawHeaders) {
      this.storeCookie(rawHeader);
    }
  }

  private storeCookie(rawHeader: string) {
    if (!rawHeader.trim()) return;

    const [nameValue, ...attributeParts] = rawHeader.split(";");
    const separatorIndex = nameValue.indexOf("=");
    if (separatorIndex <= 0) return;

    const name = nameValue.slice(0, separatorIndex).trim();
    const value = nameValue.slice(separatorIndex + 1).trim();
    const attributes = new Map<string, string>();

    for (const part of attributeParts) {
      const [rawKey, ...rawValue] = part.trim().split("=");
      if (!rawKey) continue;
      attributes.set(rawKey.toLowerCase(), rawValue.join("="));
    }

    const path = normalizePath(attributes.get("path") ?? null);
    const expiresRaw = attributes.get("expires");
    const expiresAt = expiresRaw ? Date.parse(expiresRaw) : undefined;
    const key = this.cookieKey(name, path);

    if (!value || (expiresAt !== undefined && !Number.isNaN(expiresAt) && expiresAt <= Date.now())) {
      this.cookies.delete(key);
      return;
    }

    this.cookies.set(key, {
      name,
      value,
      path,
      expiresAt: expiresAt !== undefined && !Number.isNaN(expiresAt) ? expiresAt : undefined,
    });
  }

  private cookieKey(name: string, path: string) {
    return `${name};${path}`;
  }
}
