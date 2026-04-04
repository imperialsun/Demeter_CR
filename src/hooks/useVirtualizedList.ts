import { useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/virtual-core";

export interface UseVirtualizedListOptions<TItem> {
  items: readonly TItem[];
  estimateSize: (index: number) => number;
  getItemKey?: (item: TItem, index: number) => string | number;
  overscan?: number;
  fallbackHeight?: number;
  enabled?: boolean;
  scrollElementRef?: RefObject<HTMLElement | null>;
}

export function useVirtualizedList<TItem>({
  items,
  estimateSize,
  getItemKey,
  overscan = 8,
  fallbackHeight,
  enabled = true,
  scrollElementRef,
}: UseVirtualizedListOptions<TItem>) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const contentElement = parentRef.current;
    const scrollElement = scrollElementRef?.current ?? null;

    if (!enabled || !scrollElement || !contentElement) {
      setScrollMargin((current) => (current === 0 ? current : 0));
      return;
    }

    const measureScrollMargin = () => {
      const scrollRect = scrollElement.getBoundingClientRect();
      const contentRect = contentElement.getBoundingClientRect();
      const nextMargin = Math.max(
        0,
        Math.round(contentRect.top - scrollRect.top + scrollElement.scrollTop)
      );
      setScrollMargin((current) => (current === nextMargin ? current : nextMargin));
    };

    measureScrollMargin();

    const cleanupFns: Array<() => void> = [];

    if (typeof ResizeObserver !== "undefined") {
      const resizeObserver = new ResizeObserver(measureScrollMargin);
      resizeObserver.observe(contentElement);
      resizeObserver.observe(scrollElement);
      cleanupFns.push(() => resizeObserver.disconnect());
    }

    if (typeof MutationObserver !== "undefined") {
      const mutationObserver = new MutationObserver(measureScrollMargin);
      mutationObserver.observe(scrollElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      cleanupFns.push(() => mutationObserver.disconnect());
    }

    if (typeof window !== "undefined") {
      window.addEventListener("resize", measureScrollMargin);
      cleanupFns.push(() => window.removeEventListener("resize", measureScrollMargin));
    }

    return () => {
      for (const cleanup of cleanupFns) {
        cleanup();
      }
    };
  }, [enabled, scrollElementRef, items.length]);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => (scrollElementRef ? scrollElementRef.current : parentRef.current),
    estimateSize,
    overscan,
    enabled,
    scrollMargin,
    getItemKey: getItemKey
      ? (index) => getItemKey(items[index]!, index)
      : undefined,
    initialRect:
      typeof fallbackHeight === "number" && fallbackHeight > 0 ? { width: 0, height: fallbackHeight } : undefined,
  });

  const liveVirtualItems = virtualizer.getVirtualItems();
  const fallbackVirtualItems = buildFallbackVirtualItems({
    count: items.length,
    estimateSize,
    fallbackHeight,
    scrollMargin,
  });
  const virtualItems = liveVirtualItems.length > 0 ? liveVirtualItems : fallbackVirtualItems;
  const totalSize =
    liveVirtualItems.length > 0 ? virtualizer.getTotalSize() : estimateTotalSize(items.length, estimateSize);

  return {
    parentRef,
    virtualizer,
    virtualItems,
    totalSize,
    scrollMargin,
    measureElement: virtualizer.measureElement,
  };
}

function buildFallbackVirtualItems(args: {
  count: number;
  estimateSize: (index: number) => number;
  fallbackHeight?: number;
  scrollMargin?: number;
}): VirtualItem[] {
  const { count, estimateSize, fallbackHeight, scrollMargin = 0 } = args;
  if (count <= 0) {
    return [];
  }

  const targetHeight = typeof fallbackHeight === "number" && fallbackHeight > 0 ? fallbackHeight * 1.5 : 0;
  const virtualItems: VirtualItem[] = [];
  let contentOffset = 0;
  let renderOffset = scrollMargin;

  for (let index = 0; index < count; index += 1) {
    const size = Math.max(1, estimateSize(index));
    virtualItems.push({
      index,
      start: renderOffset,
      size,
      end: renderOffset + size,
      key: index,
      lane: 0,
    });
    contentOffset += size;
    renderOffset += size;
    if (targetHeight > 0 && contentOffset >= targetHeight) {
      break;
    }
  }

  return virtualItems;
}

function estimateTotalSize(count: number, estimateSize: (index: number) => number) {
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    total += Math.max(1, estimateSize(index));
  }
  return total;
}
