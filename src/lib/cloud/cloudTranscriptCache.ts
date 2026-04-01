import logger from "@/lib/logger";
import type { TranscriptionSegment } from "@/lib/export";
import {
  buildCloudTranscriptionChunkGroup,
  mergeCloudTranscriptionChunkGroup,
  type CloudTranscriptionChunkGroup,
} from "@/lib/cloud/transcriptionChunks";

const DB_NAME = "demeter-cloud-transcript-cache";
const DB_VERSION = 1;
const SUMMARY_STORE = "chunkSummaries";
const SEGMENT_STORE = "chunkSegments";

type ChunkKey = string;

type StoredChunkSummaryRecord = CloudTranscriptionChunkGroup & {
  key: ChunkKey;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
};

type StoredChunkSegmentRecord = {
  key: ChunkKey;
  sessionId: string;
  chunkId: string;
  chunkIndex: number;
  segments: TranscriptionSegment[];
  createdAt: string;
  updatedAt: string;
};

export type CloudTranscriptChunkUpdateResult = {
  summary: CloudTranscriptionChunkGroup;
  segmentCount: number;
};

function buildChunkKey(sessionId: string, chunkId: string): ChunkKey {
  return `${sessionId}::${chunkId}`;
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
      if (!db.objectStoreNames.contains(SUMMARY_STORE)) {
        const summaryStore = db.createObjectStore(SUMMARY_STORE, { keyPath: "key" });
        summaryStore.createIndex("sessionId", "sessionId", { unique: false });
      }
      if (!db.objectStoreNames.contains(SEGMENT_STORE)) {
        const segmentStore = db.createObjectStore(SEGMENT_STORE, { keyPath: "key" });
        segmentStore.createIndex("sessionId", "sessionId", { unique: false });
        segmentStore.createIndex("chunkId", "chunkId", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  handler: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        const request = handler(store);
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          logger.warn("[cloud-transcript-cache] transaction failed", {
            storeName,
            message: tx.error instanceof Error ? tx.error.message : String(tx.error),
          });
          db.close();
          reject(tx.error);
        };
      })
      .catch(reject);
  });
}

function sortSegments(segments: TranscriptionSegment[]): TranscriptionSegment[] {
  return [...segments].sort((left, right) => left.index - right.index || left.start - right.start);
}

function toSummaryRecord(sessionId: string, summary: CloudTranscriptionChunkGroup, createdAt: string): StoredChunkSummaryRecord {
  const now = new Date().toISOString();
  return {
    ...summary,
    key: buildChunkKey(sessionId, summary.chunkId),
    sessionId,
    createdAt,
    updatedAt: now,
  };
}

function toSegmentRecord(
  sessionId: string,
  chunkId: string,
  chunkIndex: number,
  segments: TranscriptionSegment[],
  existing?: StoredChunkSegmentRecord
): StoredChunkSegmentRecord {
  const now = new Date().toISOString();
  return {
    key: buildChunkKey(sessionId, chunkId),
    sessionId,
    chunkId,
    chunkIndex,
    segments: sortSegments(segments),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
}

async function persistChunkSummary(sessionId: string, summary: CloudTranscriptionChunkGroup, existing?: StoredChunkSummaryRecord) {
  const record = toSummaryRecord(sessionId, summary, existing?.createdAt ?? new Date().toISOString());
  await withStore(SUMMARY_STORE, "readwrite", (store) => store.put(record));
}

async function persistChunkSegments(record: StoredChunkSegmentRecord) {
  await withStore(SEGMENT_STORE, "readwrite", (store) => store.put(record));
}

async function readChunkSummary(sessionId: string, chunkId: string): Promise<StoredChunkSummaryRecord | undefined> {
  const key = buildChunkKey(sessionId, chunkId);
  return withStore<StoredChunkSummaryRecord | undefined>(SUMMARY_STORE, "readonly", (store) => store.get(key));
}

async function readChunkRecord(sessionId: string, chunkId: string): Promise<StoredChunkSegmentRecord | undefined> {
  const key = buildChunkKey(sessionId, chunkId);
  return withStore<StoredChunkSegmentRecord | undefined>(SEGMENT_STORE, "readonly", (store) => store.get(key));
}

async function readSessionStore<T extends { sessionId: string }>(storeName: string, sessionId: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(storeName, "readonly");
        const store = tx.objectStore(storeName);
        const index = store.index("sessionId");
        const results: T[] = [];
        const request = index.openCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            results.push(cursor.value as T);
            cursor.continue();
          }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
          db.close();
          resolve(results);
        };
        tx.onerror = () => {
          logger.warn("[cloud-transcript-cache] read session failed", {
            storeName,
            sessionId,
            message: tx.error instanceof Error ? tx.error.message : String(tx.error),
          });
          db.close();
          reject(tx.error);
        };
      })
      .catch(reject);
  });
}

async function upsertChunkSegments(
  sessionId: string,
  chunkId: string,
  chunkIndex: number,
  nextSegments: TranscriptionSegment[],
  strategy: "append" | "replace"
): Promise<CloudTranscriptChunkUpdateResult> {
  const existingRecord = await readChunkRecord(sessionId, chunkId);
  const existingSummary = await readChunkSummary(sessionId, chunkId);
  const mergedSegments =
    strategy === "append" && existingRecord ? [...existingRecord.segments, ...nextSegments] : [...nextSegments];
  const nextRecord = toSegmentRecord(sessionId, chunkId, chunkIndex, mergedSegments, existingRecord);
  const nextSummary =
    strategy === "append" && existingRecord && existingSummary
      ? mergeCloudTranscriptionChunkGroup(existingSummary, nextSegments, chunkIndex, chunkId)
      : buildCloudTranscriptionChunkGroup(mergedSegments, chunkIndex, chunkId);

  await persistChunkSegments(nextRecord);
  await persistChunkSummary(sessionId, nextSummary, existingSummary);

  return {
    summary: nextSummary,
    segmentCount: nextRecord.segments.length,
  };
}

export async function appendCloudTranscriptChunkSegments(args: {
  sessionId: string;
  chunkId: string;
  chunkIndex: number;
  segments: TranscriptionSegment[];
}): Promise<CloudTranscriptChunkUpdateResult> {
  if (!args.segments.length) {
    const existingSummary = await readChunkSummary(args.sessionId, args.chunkId);
    if (existingSummary) {
      return {
        summary: existingSummary,
        segmentCount: existingSummary.segmentCount,
      };
    }
    const emptySummary = buildCloudTranscriptionChunkGroup([], args.chunkIndex, args.chunkId);
    await persistChunkSummary(args.sessionId, emptySummary);
    await persistChunkSegments(toSegmentRecord(args.sessionId, args.chunkId, args.chunkIndex, []));
    return {
      summary: emptySummary,
      segmentCount: 0,
    };
  }

  return upsertChunkSegments(args.sessionId, args.chunkId, args.chunkIndex, args.segments, "append");
}

export async function replaceCloudTranscriptChunkSegments(args: {
  sessionId: string;
  chunkId: string;
  chunkIndex: number;
  segments: TranscriptionSegment[];
}): Promise<CloudTranscriptChunkUpdateResult> {
  return upsertChunkSegments(args.sessionId, args.chunkId, args.chunkIndex, args.segments, "replace");
}

export async function loadCloudTranscriptChunkSegments(sessionId: string, chunkId: string): Promise<TranscriptionSegment[]> {
  const record = await readChunkRecord(sessionId, chunkId);
  return record ? sortSegments(record.segments) : [];
}

export async function loadCloudTranscriptChunkSummary(
  sessionId: string,
  chunkId: string
): Promise<CloudTranscriptionChunkGroup | null> {
  const record = await readChunkSummary(sessionId, chunkId);
  return record ? stripSummaryMetadata(record) : null;
}

export async function loadCloudTranscriptChunkSummaries(sessionId: string): Promise<CloudTranscriptionChunkGroup[]> {
  const records = await readSessionStore<StoredChunkSummaryRecord>(SUMMARY_STORE, sessionId);
  return records
    .map(stripSummaryMetadata)
    .sort((left, right) => left.chunkIndex - right.chunkIndex || left.start - right.start);
}

export async function loadCloudTranscriptSegmentsForExport(sessionId: string): Promise<TranscriptionSegment[]> {
  const summaries = await loadCloudTranscriptChunkSummaries(sessionId);
  const exported: TranscriptionSegment[] = [];
  for (const summary of summaries) {
    const segments = await loadCloudTranscriptChunkSegments(sessionId, summary.chunkId);
    exported.push(...segments);
  }
  return exported;
}

export async function updateCloudTranscriptSegment(
  sessionId: string,
  chunkId: string,
  segmentIndex: number,
  updater: (segment: TranscriptionSegment) => TranscriptionSegment
): Promise<CloudTranscriptChunkUpdateResult | null> {
  const record = await readChunkRecord(sessionId, chunkId);
  if (!record) {
    logger.warn("[cloud-transcript-cache] update skipped, chunk missing", { sessionId, chunkId, segmentIndex });
    return null;
  }

  const existingSummary = await readChunkSummary(sessionId, chunkId);

  const existingSegment = record.segments.find((segment) => segment.index === segmentIndex);
  if (!existingSegment) {
    logger.warn("[cloud-transcript-cache] update skipped, segment missing", { sessionId, chunkId, segmentIndex });
    return null;
  }

  const nextSegment = updater(existingSegment);
  if (nextSegment === existingSegment) {
    const summary = existingSummary ?? buildCloudTranscriptionChunkGroup(record.segments, record.chunkIndex, record.chunkId);
    return {
      summary,
      segmentCount: record.segments.length,
    };
  }

  const nextSegments = record.segments.map((segment) => (segment.index === segmentIndex ? nextSegment : segment));
  const nextRecord = toSegmentRecord(sessionId, chunkId, record.chunkIndex, nextSegments, record);
  const nextSummary = buildCloudTranscriptionChunkGroup(nextRecord.segments, record.chunkIndex, record.chunkId);
  await persistChunkSegments(nextRecord);
  await persistChunkSummary(sessionId, nextSummary, existingSummary);
  return {
    summary: nextSummary,
    segmentCount: nextRecord.segments.length,
  };
}

export async function deleteCloudTranscriptSession(sessionId: string): Promise<void> {
  await Promise.all([
    deleteSessionFromStore(SUMMARY_STORE, sessionId),
    deleteSessionFromStore(SEGMENT_STORE, sessionId),
  ]);
}

export async function clearAllCloudTranscriptCache(): Promise<void> {
  await Promise.all([
    withStore(SUMMARY_STORE, "readwrite", (store) => store.clear()),
    withStore(SEGMENT_STORE, "readwrite", (store) => store.clear()),
  ]);
}

async function deleteSessionFromStore(storeName: string, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    openDb()
      .then((db) => {
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        const index = store.index("sessionId");
        const request = index.openCursor(IDBKeyRange.only(sessionId));
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          logger.warn("[cloud-transcript-cache] delete session failed", {
            storeName,
            sessionId,
            message: tx.error instanceof Error ? tx.error.message : String(tx.error),
          });
          db.close();
          reject(tx.error);
        };
      })
      .catch(reject);
  });
}

function stripSummaryMetadata(record: StoredChunkSummaryRecord): CloudTranscriptionChunkGroup {
  const { key, sessionId, createdAt, updatedAt, ...summary } = record;
  void key;
  void sessionId;
  void createdAt;
  void updatedAt;
  return summary;
}
