import { Suspense } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import UploadPage from "@/routes/UploadPage";
import MicPage from "@/routes/MicPage";
import SettingsPage from "@/routes/SettingsPage";
import TelemetryPage from "@/routes/TelemetryPage";
import LoginPage from "@/routes/LoginPage";
import { isAuthenticated } from "@/lib/auth";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

function ProtectedLayout() {
  return (
    <RequireAuth>
      <AppShell>
        <Suspense fallback={<div>Chargement…</div>}>
          <Outlet />
        </Suspense>
      </AppShell>
    </RequireAuth>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedLayout />}>
        <Route path="/" element={<Navigate to="/upload" replace />} />
        <Route path="/upload" element={<UploadPage />} />
        <Route path="/mic" element={<MicPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/telemetry" element={<TelemetryPage />} />
      </Route>
    </Routes>
  );
}

export default App;
