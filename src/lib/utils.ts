import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function overallConfidenceVariant(value: number | null) {
  if (value === null) return "outline";
  // Green (success) now at 65% and above
  if (value >= 0.65) return "success";
  if (value >= 0.6) return "warning";
  return "destructive";
}
