import { render } from '@testing-library/react';
import { useAsrStore } from '@/store/asr-store';

// Simple render helper that allows passing a partial store state by applying it
export function renderWithStore(ui: React.ReactElement, storeState: Partial<ReturnType<typeof useAsrStore>> = {}) {
  // Apply overrides to the Zustand store before render
  Object.assign(useAsrStore.getState(), storeState);
  return render(ui);
}
