import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function overallConfidenceVariant(value: number | null) {
  if (value === null) return "outline";
  if (value >= 0.85) return "success";
  if (value >= 0.6) return "warning";
  return "destructive";
}
