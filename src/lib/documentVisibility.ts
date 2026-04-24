import { useSyncExternalStore } from "react";

import logger from "@/lib/logger";

export type DocumentVisibilityState = "visible" | "hidden";
export type DocumentVisibilityEventType = "initial" | "visibilitychange" | "pagehide" | "pageshow";

export interface DocumentVisibilitySnapshot {
  version: number;
  visibilityState: DocumentVisibilityState;
  hidden: boolean;
  pageHidden: boolean;
  eventType: DocumentVisibilityEventType;
  persisted: boolean;
  lastChangedAt: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let listenersInstalled = false;

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function readDocumentHidden(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return Boolean(document.hidden);
}

function buildSnapshot(overrides?: Partial<DocumentVisibilitySnapshot>): DocumentVisibilitySnapshot {
  const hidden = overrides?.hidden ?? readDocumentHidden();
  return {
    version: overrides?.version ?? 0,
    visibilityState: overrides?.visibilityState ?? (hidden ? "hidden" : "visible"),
    hidden,
    pageHidden: overrides?.pageHidden ?? false,
    eventType: overrides?.eventType ?? "initial",
    persisted: overrides?.persisted ?? false,
    lastChangedAt: overrides?.lastChangedAt ?? nowMs(),
  };
}

let snapshot = buildSnapshot();

function syncSnapshotFromDocument() {
  if (typeof document === "undefined") {
    return;
  }
  const hidden = readDocumentHidden();
  const visibilityState: DocumentVisibilityState = hidden ? "hidden" : "visible";
  if (snapshot.hidden === hidden && snapshot.visibilityState === visibilityState) {
    return;
  }
  snapshot = {
    ...snapshot,
    visibilityState,
    hidden,
    lastChangedAt: nowMs(),
  };
}

function logSnapshot(next: DocumentVisibilitySnapshot) {
  const payload = {
    version: next.version,
    visibilityState: next.visibilityState,
    hidden: next.hidden,
    pageHidden: next.pageHidden,
    persisted: next.persisted,
    lastChangedAt: Math.round(next.lastChangedAt),
  };

  if (next.eventType === "pagehide") {
    logger.warn("[visibility] pagehide", payload);
    return;
  }

  if (next.eventType === "pageshow") {
    logger.info("[visibility] pageshow", payload);
    return;
  }

  if (next.hidden) {
    logger.info("[visibility] hidden", payload);
    return;
  }

  logger.info("[visibility] visible", payload);
}

function emitSnapshot(eventType: Exclude<DocumentVisibilityEventType, "initial">, event?: Event) {
  const hidden = readDocumentHidden();
  const pageTransitionEvent = event as PageTransitionEvent | undefined;
  const next: DocumentVisibilitySnapshot = {
    version: snapshot.version + 1,
    visibilityState: hidden ? "hidden" : "visible",
    hidden,
    pageHidden: eventType === "pagehide" ? true : eventType === "pageshow" ? false : snapshot.pageHidden,
    eventType,
    persisted: typeof pageTransitionEvent !== "undefined" ? Boolean(pageTransitionEvent.persisted) : false,
    lastChangedAt: nowMs(),
  };

  snapshot = next;
  logSnapshot(next);

  for (const listener of listeners) {
    try {
      listener();
    } catch (error) {
      logger.warn("[visibility] listener failed", error);
    }
  }
}

function installDocumentVisibilityListeners() {
  if (listenersInstalled || typeof document === "undefined") {
    return;
  }
  listenersInstalled = true;

  const onVisibilityChange = () => emitSnapshot("visibilitychange");
  const onPageHide = (event: PageTransitionEvent) => emitSnapshot("pagehide", event);
  const onPageShow = (event: PageTransitionEvent) => emitSnapshot("pageshow", event);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", onPageHide);
  window.addEventListener("pageshow", onPageShow);
}

function ensureSnapshotCurrent() {
  if (typeof document === "undefined") {
    return;
  }
  syncSnapshotFromDocument();
}

export function getDocumentVisibilitySnapshot(): DocumentVisibilitySnapshot {
  ensureSnapshotCurrent();
  installDocumentVisibilityListeners();
  return snapshot;
}

export function isDocumentHidden() {
  return getDocumentVisibilitySnapshot().hidden;
}

export function subscribeDocumentVisibility(listener: Listener) {
  installDocumentVisibilityListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDocumentVisibility() {
  return useSyncExternalStore(subscribeDocumentVisibility, getDocumentVisibilitySnapshot, () => buildSnapshot());
}
