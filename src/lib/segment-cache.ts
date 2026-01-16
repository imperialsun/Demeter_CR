import logger from "@/lib/logger";

const DB_NAME = "demeter-segment-cache";
const DB_VERSION = 1;
const STORE_NAME = "segments";

export interface CachedSegment {
  key: string;
  sessionId: string;
  index: number;
  startSec: number;
  endSec: number;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB n'est pas disponible."));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "key" });
        store.createIndex("sessionId", "sessionId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        const request = handler(store);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          void tx.error;
        };
      })
      .catch(reject);
  });
}

export async function putSegment(record: CachedSegment): Promise<void> {
  await withStore("readwrite", (store) => store.put(record));
}

export async function getSegment(sessionId: string, index: number): Promise<CachedSegment | null> {
  const key = `${sessionId}:${index}`;
  const result = await withStore<CachedSegment | undefined>("readonly", (store) => store.get(key));
  return result ?? null;
}

export async function deleteSegment(sessionId: string, index: number): Promise<void> {
  const key = `${sessionId}:${index}`;
  await withStore("readwrite", (store) => store.delete(key));
}

export async function deleteSessionSegments(sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const index = store.index("sessionId");
        const request = index.openCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
            return;
          }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          logger.warn("[segment-cache] delete session failed", tx.error);
          db.close();
          reject(tx.error);
        };
      })
      .catch(reject);
  });
}

export async function clearAllSegments(): Promise<void> {
  await withStore("readwrite", (store) => store.clear());
}
