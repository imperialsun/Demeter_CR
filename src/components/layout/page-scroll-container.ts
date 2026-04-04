import { createContext, useContext, type RefObject } from "react";

export const PageScrollContainerContext = createContext<RefObject<HTMLElement | null> | null>(null);

export function usePageScrollContainer() {
  return useContext(PageScrollContainerContext);
}
