/* eslint-disable react-refresh/only-export-components */
import { useRef, type ReactElement, type ReactNode } from "react";
import { render } from "@testing-library/react";

import { PageScrollContainerContext } from "@/components/layout/page-scroll-container";
import { useAsrStore } from "@/store/asr-store";

function TestPageScrollContainer({ children }: { children: ReactNode }) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  return (
    <PageScrollContainerContext.Provider value={scrollContainerRef}>
      <div ref={scrollContainerRef} className="h-screen overflow-y-auto">
        {children}
      </div>
    </PageScrollContainerContext.Provider>
  );
}

// Simple render helper that allows passing a partial store state by applying it
export function renderWithStore(ui: ReactElement, storeState: Partial<ReturnType<typeof useAsrStore>> = {}) {
  // Apply overrides to the Zustand store before render
  Object.assign(useAsrStore.getState(), storeState);
  return render(ui, { wrapper: TestPageScrollContainer });
}
