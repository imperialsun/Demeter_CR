import { beforeEach, describe, expect, it, vi } from "vitest";
import { indexedDB as fakeIndexedDB } from "fake-indexeddb";
import {
  deleteQueueSnapshot,
  loadQueueSnapshot,
  readQueueSnapshot,
  writeQueueSnapshot,
} from "@/lib/backend-queue-storage";

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

type TestQueueEvent = {
  eventId: string;
  label: string;
};

const legacyQueueKey = "legacy-test-queue";
const indexedQueueKey = "indexed-test-queue";

function isTestQueueEvent(value: unknown): value is TestQueueEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.eventId === "string" && typeof record.label === "string";
}

describe("backend-queue-storage", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: fakeIndexedDB,
      configurable: true,
      writable: true,
    });
    window.localStorage.clear();
  });

  it("persists queue snapshots in IndexedDB", async () => {
    const events: TestQueueEvent[] = [{ eventId: "event-1", label: "alpha" }];

    expect(await writeQueueSnapshot(indexedQueueKey, events)).toBe(true);
    await expect(readQueueSnapshot<TestQueueEvent>(indexedQueueKey)).resolves.toEqual(events);

    await deleteQueueSnapshot(indexedQueueKey);
  });

  it("migrates legacy localStorage queues into IndexedDB and clears the legacy key", async () => {
    const legacyEvents: TestQueueEvent[] = [{ eventId: "event-legacy", label: "legacy" }];
    window.localStorage.setItem(legacyQueueKey, JSON.stringify(legacyEvents));

    const queue = await loadQueueSnapshot<TestQueueEvent>({
      queueKey: indexedQueueKey,
      legacyStorageKey: legacyQueueKey,
      validateLegacyItem: isTestQueueEvent,
      pendingQueue: [],
    });

    expect(queue).toEqual(legacyEvents);
    expect(window.localStorage.getItem(legacyQueueKey)).toBeNull();
    await expect(readQueueSnapshot<TestQueueEvent>(indexedQueueKey)).resolves.toEqual(legacyEvents);

    await deleteQueueSnapshot(indexedQueueKey);
  });

  it("merges pending events with an existing IndexedDB snapshot", async () => {
    const persistedEvents: TestQueueEvent[] = [{ eventId: "event-persisted", label: "persisted" }];
    const pendingEvents: TestQueueEvent[] = [{ eventId: "event-pending", label: "pending" }];

    expect(await writeQueueSnapshot(indexedQueueKey, persistedEvents)).toBe(true);

    const queue = await loadQueueSnapshot<TestQueueEvent>({
      queueKey: indexedQueueKey,
      legacyStorageKey: legacyQueueKey,
      validateLegacyItem: isTestQueueEvent,
      pendingQueue: pendingEvents,
    });

    expect(queue.map((event) => event.eventId)).toEqual(["event-persisted", "event-pending"]);

    await deleteQueueSnapshot(indexedQueueKey);
  });
});