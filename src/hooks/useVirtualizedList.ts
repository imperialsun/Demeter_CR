import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { VirtualItem } from "@tanstack/virtual-core";

export interface UseVirtualizedListOptions<TItem> {
  items: readonly TItem[];
  estimateSize: (index: number) => number;
  getItemKey?: (item: TItem, index: number) => string | number;
  overscan?: number;
  fallbackHeight?: number;
  enabled?: boolean;
}

export function useVirtualizedList<TItem>({
  items,
  estimateSize,
  getItemKey,
  overscan = 8,
  fallbackHeight,
  enabled = true,
}: UseVirtualizedListOptions<TItem>) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize,
    overscan,
    enabled,
    getItemKey: getItemKey
      ? (index) => getItemKey(items[index]!, index)
      : undefined,
    initialRect: typeof fallbackHeight === "number" && fallbackHeight > 0 ? { width: 0, height: fallbackHeight } : undefined,
  });

  const liveVirtualItems = virtualizer.getVirtualItems();
  const fallbackVirtualItems = buildFallbackVirtualItems({
    count: items.length,
    estimateSize,
    fallbackHeight,
  });
  const virtualItems = liveVirtualItems.length > 0 ? liveVirtualItems : fallbackVirtualItems;
  const totalSize =
    liveVirtualItems.length > 0 ? virtualizer.getTotalSize() : estimateTotalSize(items.length, estimateSize);

  return {
    parentRef,
    virtualizer,
    virtualItems,
    totalSize,
    measureElement: virtualizer.measureElement,
  };
}

function buildFallbackVirtualItems(args: {
  count: number;
  estimateSize: (index: number) => number;
  fallbackHeight?: number;
}): VirtualItem[] {
  const { count, estimateSize, fallbackHeight } = args;
  if (count <= 0) {
    return [];
  }

  const targetHeight = typeof fallbackHeight === "number" && fallbackHeight > 0 ? fallbackHeight * 1.5 : 0;
  const virtualItems: VirtualItem[] = [];
  let offset = 0;

  for (let index = 0; index < count; index += 1) {
    const size = Math.max(1, estimateSize(index));
    virtualItems.push({
      index,
      start: offset,
      size,
      end: offset + size,
      key: index,
      lane: 0,
    });
    offset += size;
    if (targetHeight > 0 && offset >= targetHeight) {
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
