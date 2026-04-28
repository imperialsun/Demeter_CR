import logger from "@/lib/logger";

const DB_NAME = "demeter-backend-queue-store";
const DB_VERSION = 1;
const STORE_NAME = "queues";

type PersistedQueueRecord<T> = {
  key: string;
  events: T[];
  updatedAt: string;
};

function getIndexedDbApi() {
  if (typeof globalThis === "undefined" || typeof globalThis.indexedDB === "undefined") {
    return null;
  }
  return globalThis.indexedDB;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const indexedDb = getIndexedDbApi();
    if (!indexedDb) {
      reject(new Error("IndexedDB indisponible"));
      return;
    }

    const request = indexedDb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

function withStore<T>(mode: IDBTransactionMode, handler: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = handler(store);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB transaction failed"));
        };
      })
      .catch(reject);
  });
}

export async function readQueueSnapshot<T>(queueKey: string): Promise<T[] | null> {
  try {
    const record = await withStore<PersistedQueueRecord<T> | undefined>("readonly", (store) => store.get(queueKey));
    return record?.events ?? [];
  } catch (error) {
    logger.warn("[backend-queue-storage] read failed", {
      queueKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function writeQueueSnapshot<T>(queueKey: string, events: T[]): Promise<boolean> {
  try {
    const record: PersistedQueueRecord<T> = {
      key: queueKey,
      events,
      updatedAt: new Date().toISOString(),
    };
    await withStore("readwrite", (store) => store.put(record));
    return true;
  } catch (error) {
    logger.warn("[backend-queue-storage] write failed", {
      queueKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteQueueSnapshot(queueKey: string): Promise<boolean> {
  try {
    await withStore("readwrite", (store) => store.delete(queueKey));
    return true;
  } catch (error) {
    logger.warn("[backend-queue-storage] delete failed", {
      queueKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export function readLegacyQueueSnapshot<T>(storageKey: string, validateItem: (item: unknown) => item is T): T[] | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed.filter(validateItem);
  } catch (error) {
    logger.warn("[backend-queue-storage] legacy read failed", {
      storageKey,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function clearLegacyQueueSnapshot(storageKey: string): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(storageKey);
  } catch (error) {
    logger.warn("[backend-queue-storage] legacy clear failed", {
      storageKey,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function mergeQueueSnapshots<T extends { eventId: string }>(persisted: T[], pending: T[]): T[] {
  const merged = new Map<string, T>();
  for (const event of persisted) {
    merged.set(event.eventId, event);
  }
  for (const event of pending) {
    merged.set(event.eventId, event);
  }
  return [...merged.values()];
}

export async function loadQueueSnapshot<T extends { eventId: string }>(params: {
  queueKey: string;
  legacyStorageKey: string;
  validateLegacyItem: (item: unknown) => item is T;
  pendingQueue: T[];
}): Promise<T[]> {
  const persistedQueue = await readQueueSnapshot<T>(params.queueKey);
  const baseQueue = persistedQueue === null ? [...params.pendingQueue] : mergeQueueSnapshots(persistedQueue, params.pendingQueue);

  if (persistedQueue !== null && persistedQueue.length > 0) {
    clearLegacyQueueSnapshot(params.legacyStorageKey);
    return baseQueue;
  }

  const legacyQueue = readLegacyQueueSnapshot<T>(params.legacyStorageKey, params.validateLegacyItem);
  if (legacyQueue === null || legacyQueue.length === 0) {
    return baseQueue;
  }

  const migratedQueue = mergeQueueSnapshots(legacyQueue, params.pendingQueue);
  const saved = await writeQueueSnapshot(params.queueKey, migratedQueue);
  if (saved) {
    clearLegacyQueueSnapshot(params.legacyStorageKey);
    logger.info("[backend-queue-storage] migrated legacy queue", {
      queueKey: params.queueKey,
      legacyStorageKey: params.legacyStorageKey,
      itemCount: migratedQueue.length,
    });
  }
  return migratedQueue;
}