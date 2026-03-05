import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { getAuthorizedSettingsTabs, type SettingsTabId } from "@/lib/backend-permissions";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { useSearchParams } from "react-router-dom";

type SettingsTabQuery = "local" | "mic" | "cloud" | "llm" | "llmlocal";

function normalizeSettingsTab(value: string | null): SettingsTabQuery {
  if (value === "local" || value === "mic" || value === "cloud" || value === "llm" || value === "llmlocal") {
    return value;
  }
  return "local";
}

function SettingsPage() {
  useBackendPermissions();
  const [searchParams] = useSearchParams();
  const requestedTab = normalizeSettingsTab(searchParams.get("tab"));
  const authorizedTabs = getAuthorizedSettingsTabs();
  const firstAuthorizedTab = authorizedTabs[0] ?? "local";
  const initialTab = authorizedTabs.includes(requestedTab as SettingsTabId)
    ? (requestedTab as SettingsTabId)
    : firstAuthorizedTab;

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
        showLocalSettings={authorizedTabs.includes("local")}
        showCloudSettings={authorizedTabs.includes("cloud")}
        showLlmLocalSettings={authorizedTabs.includes("llmlocal")}
        showLlmCloudSettings={authorizedTabs.includes("llm")}
        initialModelOpen
        initialChunkingOpen
        initialTab={initialTab}
      />
    </div>
  );
}

export default SettingsPage;
