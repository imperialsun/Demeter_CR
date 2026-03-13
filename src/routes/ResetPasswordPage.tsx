import { useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { BrandMark } from "@/components/branding/BrandMark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/use-toast";
import { backendResetPassword } from "@/lib/backend-auth";
import { formatBackendErrorMessage } from "@/lib/backend-api";
import { isAuthenticated } from "@/lib/auth";
import { getFirstAuthorizedRoute } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isBackendMode()) {
    return <Navigate replace to="/login" />;
  }

  if (isAuthenticated()) {
    return <Navigate replace to={getFirstAuthorizedRoute()} />;
  }

  const token = searchParams.get("token")?.trim() ?? "";

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!token) {
      setError("Le lien de reinitialisation est invalide ou incomplet.");
      return;
    }
    if (!password.trim() || !confirmPassword.trim()) {
      setError("Veuillez saisir puis confirmer votre nouveau mot de passe.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }

    setSubmitting(true);
    try {
      await backendResetPassword(token, password);
      toast("Mot de passe reinitialise.");
      navigate("/login", { replace: true });
    } catch (reason) {
      const message = formatBackendErrorMessage(reason);
      setError(message);
      logger.warn("[auth] password reset apply failed", { message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <BrandMark className="mb-3" size="md" />
          <CardTitle>Nouveau mot de passe</CardTitle>
          <CardDescription>Choisissez un nouveau mot de passe pour votre compte.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Nouveau mot de passe</Label>
              <Input
                autoComplete="new-password"
                id="password"
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                value={password}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirmer le mot de passe</Label>
              <Input
                autoComplete="new-password"
                id="confirm-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
                type="password"
                value={confirmPassword}
              />
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="flex items-center justify-between">
            <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" to="/login">
              Retour a la connexion
            </Link>
            <Button disabled={submitting} type="submit">
              {submitting ? "Validation..." : "Mettre a jour"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
