import { beforeEach, describe, expect, it } from "vitest";
import { indexedDB as fakeIndexedDb } from "fake-indexeddb";
import {
  clearSecureTokens,
  getSecureVaultAvailability,
  loadSecureTokens,
  saveSecureTokens,
} from "@/lib/secure-token-vault";

const DB_NAME = "demeter-secure-vault";
const SECRETS_STORE = "secrets";
const TOKENS_RECORD_ID = "tokens-v1";

async function resetVaultDb() {
  await new Promise<void>((resolve) => {
    const request = fakeIndexedDb.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function readRawSecretRecord() {
  return new Promise<unknown>((resolve, reject) => {
    const openRequest = fakeIndexedDb.open(DB_NAME);
    openRequest.onsuccess = () => {
      const db = openRequest.result;
      const tx = db.transaction(SECRETS_STORE, "readonly");
      const store = tx.objectStore(SECRETS_STORE);
      const getRequest = store.get(TOKENS_RECORD_ID);
      getRequest.onsuccess = () => {
        resolve(getRequest.result);
        db.close();
      };
      getRequest.onerror = () => {
        reject(getRequest.error);
        db.close();
      };
    };
    openRequest.onerror = () => reject(openRequest.error);
  });
}

describe("secure-token-vault", () => {
  beforeEach(async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDb,
      configurable: true,
    });
    await resetVaultDb();
  });

  it("persists and restores encrypted tokens", async () => {
    await saveSecureTokens({
      hfApiToken: "hf_secret_token",
      mistralApiKey: "mistral_secret_key",
    });

    const loaded = await loadSecureTokens();
    expect(loaded).toEqual({
      hfApiToken: "hf_secret_token",
      mistralApiKey: "mistral_secret_key",
    });
  });

  it("stores non-plaintext payload in indexeddb", async () => {
    await saveSecureTokens({
      hfApiToken: "hf_visible_plaintext",
      mistralApiKey: "mistral_visible_plaintext",
    });
    const rawRecord = await readRawSecretRecord();
    const serialized = JSON.stringify(rawRecord);
    expect(serialized).not.toContain("hf_visible_plaintext");
    expect(serialized).not.toContain("mistral_visible_plaintext");
  });

  it("clears persisted tokens", async () => {
    await saveSecureTokens({
      hfApiToken: "hf_secret_token",
      mistralApiKey: "mistral_secret_key",
    });
    await clearSecureTokens();
    const loaded = await loadSecureTokens();
    expect(loaded).toBeNull();
  });

  it("falls back cleanly when indexeddb is unavailable", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: undefined,
      configurable: true,
    });
    expect(getSecureVaultAvailability().supported).toBe(false);
    await expect(
      saveSecureTokens({
        hfApiToken: "hf_secret_token",
        mistralApiKey: "mistral_secret_key",
      })
    ).resolves.toBeUndefined();
    await expect(loadSecureTokens()).resolves.toBeNull();
    await expect(clearSecureTokens()).resolves.toBeUndefined();
  });
});
