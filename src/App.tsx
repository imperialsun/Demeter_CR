import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import UploadPage from "@/routes/UploadPage";
import MicPage from "@/routes/MicPage";
import SettingsPage from "@/routes/SettingsPage";
import TelemetryPage from "@/routes/TelemetryPage";

function App() {
  return (
    <AppShell>
      <Suspense fallback={<div>Chargement…</div>}>
        <Routes>
          <Route path="/" element={<Navigate to="/upload" replace />} />
          <Route path="/upload" element={<UploadPage />} />
          <Route path="/mic" element={<MicPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/telemetry" element={<TelemetryPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

export default App;
