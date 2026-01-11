import { SettingsPanel } from "@/components/settings/SettingsPanel";

function SettingsPage() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-2xl font-semibold">Paramètres</h2>
        <p className="text-muted-foreground">
          Ajustez les modèles, les modes mémoire et les paramètres de segmentation avant vos transcriptions.
        </p>
      </header>
      <SettingsPanel showReminders={false} initialModelOpen initialChunkingOpen />
    </div>
  );
}

export default SettingsPage;
