import { useMemo, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { isAuthenticated, isPasswordValid, setAuthenticated } from "@/lib/auth";
import logger from "@/lib/logger";
import { useAsrStore } from "@/store/asr-store";
import { BrandMark } from "@/components/branding/BrandMark";

type LocationState = { from?: { pathname?: string } };

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const telemetry = useAsrStore((state) => state.telemetryCollector);

  const redirectTo = useMemo(() => {
    const state = location.state as LocationState | null;
    return state?.from?.pathname ?? "/localupload";
  }, [location.state]);

  if (isAuthenticated()) {
    return <Navigate to={redirectTo} replace />;
  }

  const handleSubmit = (event: React.FormEvent) => {
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
          <CardDescription>Entrez le mot de passe pour accéder à l'application.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Mot de passe</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
              />
            </div>
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
