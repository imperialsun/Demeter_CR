import { useState } from "react";
import { Link, Navigate } from "react-router-dom";

import { BrandMark } from "@/components/branding/BrandMark";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { backendRequestPasswordReset } from "@/lib/backend-auth";
import { formatBackendErrorMessage } from "@/lib/backend-api";
import { isAuthenticated } from "@/lib/auth";
import { getFirstAuthorizedRoute } from "@/lib/backend-permissions";
import logger from "@/lib/logger";
import { isBackendMode } from "@/lib/runtime-config";

const GENERIC_SUCCESS_MESSAGE =
  "Si un compte actif correspond a cet email, un lien de reinitialisation vient d etre envoye.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!isBackendMode()) {
    return <Navigate replace to="/login" />;
  }

  if (isAuthenticated()) {
    return <Navigate replace to={getFirstAuthorizedRoute()} />;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!email.trim()) {
      setError("Veuillez saisir votre email.");
      return;
    }

    setSubmitting(true);
    try {
      await backendRequestPasswordReset(email.trim());
      setSuccess(GENERIC_SUCCESS_MESSAGE);
    } catch (reason) {
      const message = formatBackendErrorMessage(reason);
      setError(message);
      logger.warn("[auth] password reset request failed", { message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md">
        <CardHeader>
          <BrandMark className="mb-3" size="md" />
          <CardTitle>Mot de passe oublié</CardTitle>
          <CardDescription>Entrez votre email pour recevoir un lien de reinitialisation.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                autoComplete="email"
                id="email"
                onChange={(event) => setEmail(event.target.value)}
                type="email"
                value={email}
              />
            </div>
            {success ? <p className="text-sm text-muted-foreground">{success}</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </CardContent>
          <CardFooter className="flex items-center justify-between">
            <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" to="/login">
              Retour a la connexion
            </Link>
            <Button disabled={submitting} type="submit">
              {submitting ? "Envoi..." : "Envoyer le lien"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
