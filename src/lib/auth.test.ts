import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashSync } from "bcryptjs";

const makeStorage = () => {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
};

const loadAuth = async (hashes: string[]) => {
  vi.stubGlobal("__LOGIN_HASHES__", hashes);
  return await import("./auth");
};

describe("auth", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    Object.defineProperty(window, "localStorage", {
      value: makeStorage(),
      configurable: true,
    });
  });

  it("validates password against configured hashes", async () => {
    const validPassword = "boblebricoleur";
    const hashes = [hashSync(validPassword, 6)];
    const { isPasswordValid } = await loadAuth(hashes);

    expect(isPasswordValid(validPassword)).toBe(true);
    expect(isPasswordValid("wrong-password")).toBe(false);
  });

  it("persists authentication state in localStorage", async () => {
    const { isAuthenticated, setAuthenticated } = await loadAuth([hashSync("x", 6)]);

    expect(isAuthenticated()).toBe(false);
    setAuthenticated(true);
    expect(isAuthenticated()).toBe(true);
    setAuthenticated(false);
    expect(isAuthenticated()).toBe(false);
  });
});
