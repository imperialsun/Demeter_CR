import { Suspense, lazy } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { isAuthenticated } from "@/lib/auth";
import { canAccessFeature, getFirstAuthorizedRoute, type FeaturePermission } from "@/lib/backend-permissions";
import { isBackendMode } from "@/lib/runtime-config";
import LocalUploadPage from "@/routes/LocalUploadPage";
import LoginPage from "@/routes/LoginPage";

const CloudUploadPage = lazy(() => import("@/routes/CloudUploadPage"));
const LLMApiPage = lazy(() => import("@/routes/LLMApiPage"));
const LLMLocalPage = lazy(() => import("@/routes/LLMLocalPage"));
const SettingsPage = lazy(() => import("@/routes/SettingsPage"));
const TelemetryPage = lazy(() => import("@/routes/TelemetryPage"));
const ForbiddenPage = lazy(() => import("@/routes/ForbiddenPage"));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  if (!isAuthenticated()) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return <>{children}</>;
}

function RequireFeature({
  permission,
  children,
}: {
  permission: FeaturePermission;
  children: React.ReactNode;
}) {
  const location = useLocation();
  useBackendPermissions();

  if (!isBackendMode()) {
    return <>{children}</>;
  }

  if (canAccessFeature(permission)) {
    return <>{children}</>;
  }

  return <Navigate to="/forbidden" replace state={{ from: location.pathname, permission }} />;
}

function PermissionAwareHomeRedirect() {
  useBackendPermissions();
  const target = isBackendMode() ? getFirstAuthorizedRoute() : "/localupload";
  return <Navigate to={target} replace />;
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
        <Route path="/" element={<PermissionAwareHomeRedirect />} />
        <Route
          path="/localupload"
          element={
            <RequireFeature permission="feature.localupload">
              <LocalUploadPage />
            </RequireFeature>
          }
        />
        <Route
          path="/cloudupload"
          element={
            <RequireFeature permission="feature.cloudupload">
              <CloudUploadPage />
            </RequireFeature>
          }
        />
        <Route
          path="/llmlocal"
          element={
            <RequireFeature permission="feature.llmlocal">
              <LLMLocalPage />
            </RequireFeature>
          }
        />
        <Route
          path="/llmapi"
          element={
            <RequireFeature permission="feature.llmapi">
              <LLMApiPage />
            </RequireFeature>
          }
        />
        <Route path="/upload" element={<PermissionAwareHomeRedirect />} />
        <Route path="/mic" element={<PermissionAwareHomeRedirect />} />
        <Route
          path="/settings"
          element={
            <RequireFeature permission="feature.settings">
              <SettingsPage />
            </RequireFeature>
          }
        />
        <Route
          path="/telemetry"
          element={
            <RequireFeature permission="feature.telemetry">
              <TelemetryPage />
            </RequireFeature>
          }
        />
        <Route path="/forbidden" element={<ForbiddenPage />} />
      </Route>
    </Routes>
  );
}

export default App;
