import * as React from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { cn } from "@/lib/utils";
import { useAsrStore } from "@/store/asr-store";

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ children, className }: AppShellProps) {
  const isTranscribing = useAsrStore((state) => state.isTranscribing);
  const progress = useAsrStore((state) => state.progress);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const baseTitle = "Demeter Speech";
    if (isTranscribing) {
      const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
      document.title = `${baseTitle} (${pct}%)`;
    } else {
      document.title = baseTitle;
    }
  }, [isTranscribing, progress]);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <Sidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <Topbar />
        <main className={cn("flex-1 overflow-y-auto p-4 md:p-8", className)}>
          {children}
        </main>
      </div>
    </div>
  );
}
