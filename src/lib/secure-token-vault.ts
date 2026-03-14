import logger from "@/lib/logger";

const DB_NAME = "demeter-secure-vault";
const DB_VERSION = 2;
const SECRETS_STORE = "secrets";
const SESSION_KEY_STORAGE = "demeter-secure-vault-key";
const TOKENS_RECORD_ID = "tokens-v1";
const TOKENS_RECORD_VERSION = 1;
let cachedKey: CryptoKey | null = null;

export interface SecureTokens {
  hfApiToken: string;
  mistralApiKey: string;
}

type StoredTokensRecord = {
  version: number;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
};

type Availability = {
  supported: boolean;
  reason?: string;
};

function getCryptoApi() {
  if (typeof globalThis === "undefined" || !globalThis.crypto || !globalThis.crypto.subtle) {
    return null;
  }
  return globalThis.crypto;
}

function getIndexedDbApi() {
  if (typeof globalThis === "undefined" || typeof globalThis.indexedDB === "undefined") {
    return null;
  }
  return globalThis.indexedDB;
}

function getSessionStorageApi() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.sessionStorage;
  } catch (error) {
    logger.warn("[secure-token-vault] sessionStorage unavailable", error);
    return null;
  }
}

export function getSecureVaultAvailability(): Availability {
  if (!getIndexedDbApi()) {
    return { supported: false, reason: "indexeddb_unavailable" };
  }
  if (!getCryptoApi()) {
    return { supported: false, reason: "webcrypto_unavailable" };
  }
  if (!getSessionStorageApi()) {
    return { supported: false, reason: "sessionstorage_unavailable" };
  }
  return { supported: true };
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof globalThis.btoa === "function") {
    return globalThis.btoa(binary);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  throw new Error("Base64 encoding unavailable");
}

function base64ToUint8Array(value: string) {
  if (typeof globalThis.atob === "function") {
    const binary = globalThis.atob(value);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(value, "base64"));
  }
  throw new Error("Base64 decoding unavailable");
}

function openVaultDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const indexedDb = getIndexedDbApi();
    if (!indexedDb) {
      reject(new Error("IndexedDB indisponible"));
      return;
    }
    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains("keys")) {
        db.deleteObjectStore("keys");
      }
      if (!db.objectStoreNames.contains(SECRETS_STORE)) {
        db.createObjectStore(SECRETS_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  storeName: string,
  handler: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  const db = await openVaultDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const request = handler(store);
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      reject(tx.error);
      db.close();
    };
  });
}

async function clearCiphertextRecord() {
  await withStore("readwrite", SECRETS_STORE, (store) => store.delete(TOKENS_RECORD_ID));
}

async function readKey(): Promise<CryptoKey | null> {
  if (cachedKey) {
    return cachedKey;
  }
  const storage = getSessionStorageApi();
  const raw = storage?.getItem(SESSION_KEY_STORAGE);
  if (!raw) {
    return null;
  }
  const cryptoApi = getCryptoApi();
  if (!cryptoApi) {
    return null;
  }
  const imported = await cryptoApi.subtle.importKey(
    "raw",
    base64ToUint8Array(raw),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
  cachedKey = imported;
  logger.debug("[secure-token-vault] imported session key from sessionStorage");
  return imported;
}

async function writeKey(key: CryptoKey): Promise<void> {
  const cryptoApi = getCryptoApi();
  const storage = getSessionStorageApi();
  if (!cryptoApi || !storage) return;
  const exported = await cryptoApi.subtle.exportKey("raw", key);
  storage.setItem(SESSION_KEY_STORAGE, arrayBufferToBase64(exported));
  cachedKey = key;
  logger.info("[secure-token-vault] stored session-scoped encryption key", {
    bytes: exported.byteLength,
  });
}

async function getOrCreateKey(): Promise<CryptoKey | null> {
  const cryptoApi = getCryptoApi();
  if (!cryptoApi) return null;
  const existing = await readKey();
  if (existing) return existing;
  const generated = await cryptoApi.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  await writeKey(generated);
  logger.info("[secure-token-vault] generated session-scoped encryption key");
  return generated;
}

function normalizeTokens(tokens: SecureTokens): SecureTokens {
  return {
    hfApiToken: tokens.hfApiToken ?? "",
    mistralApiKey: tokens.mistralApiKey ?? "",
  };
}

function encodePayload(tokens: SecureTokens): ArrayBuffer {
  const data = JSON.stringify(normalizeTokens(tokens));
  const encoded = new TextEncoder().encode(data);
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
}

function decodePayload(bytes: ArrayBuffer): SecureTokens | null {
  try {
    const raw = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(raw) as Partial<SecureTokens>;
    return {
      hfApiToken: typeof parsed.hfApiToken === "string" ? parsed.hfApiToken : "",
      mistralApiKey: typeof parsed.mistralApiKey === "string" ? parsed.mistralApiKey : "",
    };
  } catch (error) {
    logger.warn("[secure-token-vault] failed to decode payload", error);
    return null;
  }
}

export async function loadSecureTokens(): Promise<SecureTokens | null> {
  if (!getSecureVaultAvailability().supported) return null;
  try {
    const record = await withStore<StoredTokensRecord | undefined>("readonly", SECRETS_STORE, (store) =>
      store.get(TOKENS_RECORD_ID)
    );
    if (!record) return null;
    if (record.version !== TOKENS_RECORD_VERSION) {
      logger.warn("[secure-token-vault] unsupported vault record version", {
        version: record.version,
      });
      return null;
    }
    const key = await readKey();
    if (!key) {
      logger.warn("[secure-token-vault] encryption key missing");
      await clearCiphertextRecord();
      return null;
    }
    const cryptoApi = getCryptoApi();
    if (!cryptoApi) return null;
    const decrypted = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(record.iv),
      },
      key,
      record.ciphertext
    );
    return decodePayload(decrypted);
  } catch (error) {
    logger.warn("[secure-token-vault] failed to load secure tokens", error);
    await clearCiphertextRecord().catch(() => undefined);
    return null;
  }
}

export async function saveSecureTokens(tokens: SecureTokens): Promise<void> {
  if (!getSecureVaultAvailability().supported) return;
  const normalized = normalizeTokens(tokens);
  if (!normalized.hfApiToken && !normalized.mistralApiKey) {
    await clearSecureTokens();
    return;
  }
  try {
    const key = await getOrCreateKey();
    if (!key) return;
    const cryptoApi = getCryptoApi();
    if (!cryptoApi) return;
    const iv = cryptoApi.getRandomValues(new Uint8Array(12));
    const ciphertext = await cryptoApi.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      encodePayload(normalized)
    );
    const record: StoredTokensRecord = {
      version: TOKENS_RECORD_VERSION,
      iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
      ciphertext,
    };
    await withStore("readwrite", SECRETS_STORE, (store) => store.put(record, TOKENS_RECORD_ID));
  } catch (error) {
    logger.warn("[secure-token-vault] failed to save secure tokens", error);
  }
}

export async function clearSecureTokens(): Promise<void> {
  if (!getSecureVaultAvailability().supported) return;
  try {
    cachedKey = null;
    getSessionStorageApi()?.removeItem(SESSION_KEY_STORAGE);
    await clearCiphertextRecord();
  } catch (error) {
    logger.warn("[secure-token-vault] failed to clear secure tokens", error);
  }
}
