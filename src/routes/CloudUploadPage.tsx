import { useEffect } from "react";
import { useAsrStore } from "@/store/asr-store";

function CloudUploadPage() {
  const telemetry = useAsrStore((state) => state.telemetryCollector);

  useEffect(() => {
    console.info("Cloud upload page view", { route: "/cloudupload", mode: "cloud" });
    telemetry?.logEvent?.("CLOUD_UPLOAD_PAGE_VIEW", { route: "/cloudupload", mode: "cloud" });
  }, [telemetry]);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Transcription cloud</h2>
        <p className="text-muted-foreground">Cette section est en preparation.</p>
      </header>
      <div className="rounded-md border bg-muted/20 p-6 text-sm text-muted-foreground">
        Contenu a venir.
      </div>
    </div>
  );
}

export default CloudUploadPage;
