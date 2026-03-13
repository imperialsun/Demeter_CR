import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { isAuthenticated, isPasswordValid, setAuthenticated } from "@/lib/auth";
import logger from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";
import { BrandMark } from "@/components/branding/BrandMark";
import { canAccessRoutePath, getFirstAuthorizedRoute } from "@/lib/backend-permissions";
import { isBackendMode } from "@/lib/runtime-config";
import { backendLogin } from "@/lib/backend-auth";
import { pullBackendSettings } from "@/lib/backend-settings-sync";
import { flushBackendActivityQueueNow } from "@/lib/backend-activity-sync";
import { replaceSettingsCacheFromBackend } from "@/lib/storage";

type LocationState = { from?: { pathname?: string } };

function resolveRedirectTarget(backendMode: boolean, state: LocationState | null): string {
  const fromPath = state?.from?.pathname;
  if (backendMode) {
    if (fromPath && fromPath !== "/forbidden" && canAccessRoutePath(fromPath)) {
      return fromPath;
    }
    return getFirstAuthorizedRoute();
  }
  return fromPath ?? "/localupload";
}

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const backendMode = isBackendMode();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const telemetry = useAsrStore((state) => state.telemetryCollector);

  const redirectTo = resolveRedirectTarget(backendMode, location.state as LocationState | null);

  if (isAuthenticated()) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      logger.info("Auth login attempt");
      telemetry?.logEvent("AUTH_LOGIN_ATTEMPT", { source: "login_page" });
    } catch (err) {
      void err;
    }
    if (!password.trim()) {
      setError("Veuillez saisir le mot de passe.");
      try {
        logger.warn("Auth login failed", { reason: "empty_password" });
        telemetry?.logEvent("AUTH_LOGIN_FAILED", { reason: "empty_password" });
      } catch (err) {
        void err;
      }
      return;
    }

    if (backendMode) {
      if (!email.trim()) {
        setError("Veuillez saisir votre email.");
        return;
      }

      try {
        await backendLogin(email.trim(), password);
        setAuthenticated(true);
        try {
          const serverSettings = await pullBackendSettings();
          if (serverSettings?.settings) {
            replaceSettingsCacheFromBackend(serverSettings.settings);
            useAsrStore.getState().hydrateFromStorage();
          }
        } catch (syncError) {
          logger.warn("[auth] backend settings sync after login failed", syncError);
        }
        await flushBackendActivityQueueNow();
        logger.info("Auth login success");
        telemetry?.logEvent("AUTH_LOGIN_SUCCESS", { source: "login_page", mode: "backend" });
        toast("Connexion réussie.");
        navigate(resolveRedirectTarget(true, location.state as LocationState | null), { replace: true });
      } catch (loginError) {
        const message = loginError instanceof Error ? loginError.message : "Connexion backend impossible.";
        setError(message);
        logger.warn("Auth login failed", { reason: "backend_login_failed", message });
        telemetry?.logEvent("AUTH_LOGIN_FAILED", { reason: "backend_login_failed" });
      }
      return;
    }

    if (!isPasswordValid(password)) {
      setError("Mot de passe incorrect.");
      try {
        logger.warn("Auth login failed", { reason: "invalid_password" });
        telemetry?.logEvent("AUTH_LOGIN_FAILED", { reason: "invalid_password" });
      } catch (err) {
        void err;
      }
      return;
    }

    setAuthenticated(true);
    try {
      logger.info("Auth login success");
      telemetry?.logEvent("AUTH_LOGIN_SUCCESS", { source: "login_page" });
    } catch (err) {
      void err;
    }
    toast("Connexion réussie.");
    navigate(redirectTo, { replace: true });
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <BrandMark className="mb-3" size="md" />
          <CardTitle>Connexion</CardTitle>
          <CardDescription>
            {backendMode
              ? "Entrez votre email et votre mot de passe pour accéder à l'application."
              : "Entrez le mot de passe pour accéder à l'application."}
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              {backendMode ? (
                <>
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoFocus
                  />
                </>
              ) : null}
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus={!backendMode}
              />
            </div>
            {backendMode ? (
              <div className="flex justify-end">
                <Link className="text-sm text-primary underline-offset-4 hover:underline" to="/forgot-password">
                  Mot de passe oublié ?
                </Link>
              </div>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="flex justify-end">
            <Button type="submit">Se connecter</Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
