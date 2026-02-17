import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { useSearchParams } from "react-router-dom";

type SettingsTabQuery = "local" | "mic" | "cloud" | "llm";

function normalizeSettingsTab(value: string | null): SettingsTabQuery {
  if (value === "local" || value === "mic" || value === "cloud" || value === "llm") {
    return value;
  }
  return "local";
}

function SettingsPage() {
  const [searchParams] = useSearchParams();
  const initialTab = normalizeSettingsTab(searchParams.get("tab"));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Paramètres</h2>
        <p className="text-muted-foreground">
          Ajustez les modèles, les modes mémoire et les paramètres de segmentation avant vos transcriptions.
        </p>
      </header>
      <SettingsPanel
        showReminders={false}
        showMicSettings={false}
        initialModelOpen
        initialChunkingOpen
        initialTab={initialTab}
      />
    </div>
  );
}

export default SettingsPage;
