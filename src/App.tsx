import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import LocalUploadPage from "@/routes/LocalUploadPage";
import LoginPage from "@/routes/LoginPage";
import { isAuthenticated } from "@/lib/auth";

const CloudUploadPage = lazy(() => import("@/routes/CloudUploadPage"));
const LLMApiPage = lazy(() => import("@/routes/LLMApiPage"));
const LLMLocalPage = lazy(() => import("@/routes/LLMLocalPage"));
const SettingsPage = lazy(() => import("@/routes/SettingsPage"));
const TelemetryPage = lazy(() => import("@/routes/TelemetryPage"));

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
        <Route path="/" element={<Navigate to="/localupload" replace />} />
        <Route path="/localupload" element={<LocalUploadPage />} />
        <Route path="/cloudupload" element={<CloudUploadPage />} />
        <Route path="/llmlocal" element={<LLMLocalPage />} />
        <Route path="/llmapi" element={<LLMApiPage />} />
        <Route path="/upload" element={<Navigate to="/localupload" replace />} />
        <Route path="/mic" element={<Navigate to="/localupload" replace />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/telemetry" element={<TelemetryPage />} />
      </Route>
    </Routes>
  );
}

export default App;
