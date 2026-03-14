import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { indexedDB as fakeIndexedDb } from 'fake-indexeddb';

import logger from '@/lib/logger';
import {
  clearSecureTokens,
  getSecureVaultAvailability,
  loadSecureTokens,
  saveSecureTokens,
} from '@/lib/secure-token-vault';

const DB_NAME = 'demeter-secure-vault';
const SECRETS_STORE = 'secrets';
const SESSION_KEY_STORAGE = 'demeter-secure-vault-key';
const TOKENS_RECORD_ID = 'tokens-v1';

type StoredTokensRecord = {
  version: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

const originalIndexedDb = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
const originalCrypto = (globalThis as typeof globalThis & { crypto?: Crypto }).crypto;

async function resetVaultDb() {
  await new Promise<void>((resolve) => {
    const request = fakeIndexedDb.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

async function withDb<T>(run: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const openRequest = fakeIndexedDb.open(DB_NAME);
    openRequest.onsuccess = () => resolve(openRequest.result);
    openRequest.onerror = () => reject(openRequest.error);
  });
  try {
    return await run(db);
  } finally {
    db.close();
  }
}

async function readRawSecretRecord(): Promise<StoredTokensRecord | undefined> {
  return withDb(async (db) => {
    return new Promise<StoredTokensRecord | undefined>((resolve, reject) => {
      const tx = db.transaction(SECRETS_STORE, 'readonly');
      const store = tx.objectStore(SECRETS_STORE);
      const request = store.get(TOKENS_RECORD_ID);
      request.onsuccess = () => resolve(request.result as StoredTokensRecord | undefined);
      request.onerror = () => reject(request.error);
    });
  });
}

async function writeRawSecretRecord(record: StoredTokensRecord): Promise<void> {
  await withDb(async (db) => {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SECRETS_STORE, 'readwrite');
      const store = tx.objectStore(SECRETS_STORE);
      const request = store.put(record, TOKENS_RECORD_ID);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

function clearSessionKey() {
  window.sessionStorage.removeItem(SESSION_KEY_STORAGE);
}

describe('secure-token-vault', () => {
  beforeEach(async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: fakeIndexedDb,
      configurable: true,
    });
    if (originalCrypto) {
      Object.defineProperty(globalThis, 'crypto', {
        value: originalCrypto,
        configurable: true,
      });
    }
    await resetVaultDb();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: originalIndexedDb,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'crypto', {
      value: originalCrypto,
      configurable: true,
    });
  });

  it('persists and restores encrypted tokens', async () => {
    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });

    const loaded = await loadSecureTokens();
    expect(loaded).toEqual({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });
  });

  it('stores non-plaintext payload in indexeddb', async () => {
    await saveSecureTokens({
      hfApiToken: 'hf_visible_plaintext',
      mistralApiKey: 'mistral_visible_plaintext',
    });

    const rawRecord = await readRawSecretRecord();
    const serialized = JSON.stringify(rawRecord);
    expect(serialized).not.toContain('hf_visible_plaintext');
    expect(serialized).not.toContain('mistral_visible_plaintext');
  });

  it('clears persisted tokens', async () => {
    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });

    await clearSecureTokens();
    const loaded = await loadSecureTokens();
    expect(loaded).toBeNull();
  });

  it('falls back cleanly when indexeddb is unavailable', async () => {
    Object.defineProperty(globalThis, 'indexedDB', {
      value: undefined,
      configurable: true,
    });

    expect(getSecureVaultAvailability()).toEqual({
      supported: false,
      reason: 'indexeddb_unavailable',
    });

    await expect(
      saveSecureTokens({
        hfApiToken: 'hf_secret_token',
        mistralApiKey: 'mistral_secret_key',
      })
    ).resolves.toBeUndefined();
    await expect(loadSecureTokens()).resolves.toBeNull();
    await expect(clearSecureTokens()).resolves.toBeUndefined();
  });

  it('reports webcrypto as unavailable when crypto API is missing', () => {
    Object.defineProperty(globalThis, 'crypto', {
      value: undefined,
      configurable: true,
    });

    expect(getSecureVaultAvailability()).toEqual({
      supported: false,
      reason: 'webcrypto_unavailable',
    });
  });

  it('returns null and warns for unsupported record version', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });

    const record = await readRawSecretRecord();
    expect(record).toBeDefined();
    await writeRawSecretRecord({
      ...(record as StoredTokensRecord),
      version: 999,
    });

    await expect(loadSecureTokens()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[secure-token-vault] unsupported vault record version', {
      version: 999,
    });
  });

  it('returns null and warns when encryption key is missing', async () => {
    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });
    clearSessionKey();

    vi.resetModules();
    const reloadedLogger = (await import('@/lib/logger')).default;
    const warnSpy = vi.spyOn(reloadedLogger, 'warn').mockImplementation(() => undefined as never);
    const { loadSecureTokens: loadSecureTokensAfterReload } = await import('@/lib/secure-token-vault');

    await expect(loadSecureTokensAfterReload()).resolves.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith('[secure-token-vault] encryption key missing');
    await expect(readRawSecretRecord()).resolves.toBeUndefined();
  });

  it('returns null and warns when decrypt fails', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });

    const decryptSpy = vi
      .spyOn(globalThis.crypto.subtle, 'decrypt')
      .mockRejectedValueOnce(new Error('decrypt failed'));

    await expect(loadSecureTokens()).resolves.toBeNull();
    expect(decryptSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[secure-token-vault] failed to load secure tokens', expect.any(Error));
  });

  it('clears vault when trying to save empty tokens', async () => {
    await saveSecureTokens({
      hfApiToken: 'hf_secret_token',
      mistralApiKey: 'mistral_secret_key',
    });

    await saveSecureTokens({
      hfApiToken: '',
      mistralApiKey: '',
    });

    const rawRecord = await readRawSecretRecord();
    expect(rawRecord).toBeUndefined();
    await expect(loadSecureTokens()).resolves.toBeNull();
  });

  it('warns when save fails unexpectedly', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
    const randomSpy = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(() => {
        throw new Error('rng failure');
      });

    await expect(
      saveSecureTokens({
        hfApiToken: 'hf_secret_token',
        mistralApiKey: 'mistral_secret_key',
      })
    ).resolves.toBeUndefined();

    expect(randomSpy).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[secure-token-vault] failed to save secure tokens', expect.any(Error));
  });

  it('warns when clear fails unexpectedly', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);

    Object.defineProperty(globalThis, 'indexedDB', {
      value: {
        open: () => {
          throw new Error('indexeddb open failed');
        },
      },
      configurable: true,
    });

    await expect(clearSecureTokens()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith('[secure-token-vault] failed to clear secure tokens', expect.any(Error));
  });
});
