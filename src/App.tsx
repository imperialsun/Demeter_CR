import { Suspense, lazy, useEffect } from "react";
import { Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "@/components/layout/AppShell";
import { useBackendPermissions } from "@/hooks/useBackendPermissions";
import { isAuthenticated } from "@/lib/auth";
import { canAccessFeature, getFirstAuthorizedRoute, type FeaturePermission } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";
import LocalUploadPage from "@/routes/LocalUploadPage";
import ForgotPasswordPage from "@/routes/ForgotPasswordPage";
import LoginPage from "@/routes/LoginPage";
import ResetPasswordPage from "@/routes/ResetPasswordPage";

const CloudUploadPage = lazy(() => import("@/routes/CloudUploadPage"));
const LLMApiPage = lazy(() => import("@/routes/LLMApiPage"));
const LLMLocalPage = lazy(() => import("@/routes/LLMLocalPage"));
const SettingsPage = lazy(() => import("@/routes/SettingsPage"));
const TelemetryPage = lazy(() => import("@/routes/TelemetryPage"));
const ForbiddenPage = lazy(() => import("@/routes/ForbiddenPage"));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const authenticated = isAuthenticated();

  useEffect(() => {
    if (!authenticated) {
      logger.warn("[auth][route] redirecting to login", { path: location.pathname });
      return;
    }
    logger.debug("[auth][route] access granted", { path: location.pathname });
  }, [authenticated, location.pathname]);

  if (!authenticated) {
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
  const backendMode = isBackendMode();
  const allowed = !backendMode || canAccessFeature(permission);

  useEffect(() => {
    if (!backendMode) {
      logger.debug("[route] feature gate bypassed in standalone mode", {
        path: location.pathname,
        permission,
      });
      return;
    }
    if (allowed) {
      logger.debug("[route] feature gate granted", { path: location.pathname, permission });
      return;
    }
    logger.warn("[route] feature gate denied", { path: location.pathname, permission });
  }, [allowed, backendMode, location.pathname, permission]);

  if (!backendMode) {
    return <>{children}</>;
  }

  if (allowed) {
    return <>{children}</>;
  }

  return <Navigate to="/forbidden" replace state={{ from: location.pathname, permission }} />;
}

function PermissionAwareHomeRedirect() {
  useBackendPermissions();
  const target = isBackendMode() ? getFirstAuthorizedRoute() : "/localupload";

  useEffect(() => {
    logger.info("[route] home redirect resolved", {
      mode: isBackendMode() ? "backend" : "standalone",
      target,
    });
  }, [target]);

  return <Navigate to={target} replace />;
}

function ProtectedLayout() {
  useEffect(() => {
    logger.debug("[app-shell] protected layout mounted");
    return () => {
      logger.debug("[app-shell] protected layout unmounted");
    };
  }, []);

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
  useEffect(() => {
    logger.info("[app] route tree mounted", {
      runtimeMode: isBackendMode() ? "backend" : "standalone",
    });
    return () => {
      logger.debug("[app] route tree unmounted");
    };
  }, []);

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
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
