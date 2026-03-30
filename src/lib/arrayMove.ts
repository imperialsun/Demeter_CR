export function moveArrayItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  if (fromIndex === toIndex) {
    return [...items];
  }
  if (fromIndex < 0 || fromIndex >= items.length) {
    return [...items];
  }

  const nextItems = [...items];
  const [item] = nextItems.splice(fromIndex, 1);
  if (item === undefined) {
    return [...items];
  }

  const boundedIndex = Math.max(0, Math.min(toIndex, nextItems.length));
  nextItems.splice(boundedIndex, 0, item);
  return nextItems;
}
