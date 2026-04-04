import * as React from "react";
import { useLocation } from "react-router-dom";
import { Sidebar } from "@/components/layout/Sidebar";
import { Topbar } from "@/components/layout/Topbar";
import { PageScrollContainerContext } from "@/components/layout/page-scroll-container";
import { getCloudProgressTitleLabel } from "@/lib/cloudStatusMeta";
import logger from "@/lib/logger";
import { cn } from "@/lib/utils";
import { useAsrStore } from "@/store/asr-store";

interface AppShellProps {
  children: React.ReactNode;
  className?: string;
}

export function AppShell({ children, className }: AppShellProps) {
  const location = useLocation();
  const mainRef = React.useRef<HTMLElement | null>(null);
  const isTranscribing = useAsrStore((state) => state.isTranscribing);
  const progress = useAsrStore((state) => state.progress);
  const cloudStatus = useAsrStore((state) => state.cloudStatus);
  const resetSession = useAsrStore((state) => state.resetSession);
  const normalizedPathname = location.pathname.replace(/\/+$/, "") || "/";
  const isCloudUploadRoute = normalizedPathname === "/cloudupload";

  React.useEffect(() => {
    logger.info("[app-shell] mounted");
    return () => {
      logger.debug("[app-shell] unmounted");
    };
  }, []);

  React.useEffect(() => {
    if (typeof document === "undefined") return;
    const baseTitle = "Demeter Speech";
    if (isCloudUploadRoute) {
      const cloudTitleLabel = getCloudProgressTitleLabel(cloudStatus);
      if (cloudTitleLabel) {
        const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
        document.title = `${baseTitle} - ${cloudTitleLabel} (${pct}%)`;
      } else {
        document.title = baseTitle;
      }
    } else if (isTranscribing) {
      const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
      document.title = `${baseTitle} (${pct}%)`;
    } else {
      document.title = baseTitle;
    }
  }, [cloudStatus, isCloudUploadRoute, isTranscribing, progress]);

  React.useEffect(() => {
    logger.info("[app-shell] resetting session state on shell mount");
    resetSession();
  }, [resetSession]);

  React.useEffect(() => {
    logger.debug("[app-shell] transcription state updated", {
      isTranscribing,
      progress,
    });
  }, [isTranscribing, progress]);

  return (
    <PageScrollContainerContext.Provider value={mainRef}>
      <div className="flex min-h-screen bg-background text-foreground">
        <Sidebar />
        <div className="flex min-h-screen flex-1 flex-col">
          <Topbar />
          <main ref={mainRef} className={cn("flex-1 overflow-y-auto p-4 md:p-8", className)}>
            {children}
          </main>
        </div>
      </div>
    </PageScrollContainerContext.Provider>
  );
}
