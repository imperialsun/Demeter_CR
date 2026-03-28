import { createPortal } from "react-dom";
import { useEffect, useId, useRef, useState } from "react";

import { formatBackendErrorMessage } from "@/lib/backend-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PasswordStrengthMeter } from "@/components/ui/PasswordStrengthMeter";

interface ChangePasswordDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (currentPassword: string, password: string) => Promise<void>;
}

export function ChangePasswordDialog({ open, onClose, onSubmit }: ChangePasswordDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const currentPasswordRef = useRef<HTMLInputElement | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setCurrentPassword("");
    setPassword("");
    setConfirmPassword("");
    setError(null);
    setSubmitting(false);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const rafId = window.requestAnimationFrame(() => {
      currentPasswordRef.current?.focus();
    });

    return () => {
      document.body.style.overflow = previousOverflow;
      window.cancelAnimationFrame(rafId);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !submitting) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, submitting]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  const handleDismiss = () => {
    if (!submitting) {
      onClose();
    }
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!currentPassword.trim() || !password.trim() || !confirmPassword.trim()) {
      setError("Veuillez saisir votre mot de passe actuel puis confirmer votre nouveau mot de passe.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Les mots de passe ne correspondent pas.");
      return;
    }

    setSubmitting(true);
    let succeeded = false;
    try {
      await onSubmit(currentPassword, password);
      succeeded = true;
    } catch (reason) {
      setError(formatBackendErrorMessage(reason));
    } finally {
      setSubmitting(false);
    }

    if (succeeded) {
      onClose();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={handleDismiss}>
      <div className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm" aria-hidden="true" />
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="relative z-[71] w-full max-w-lg rounded-xl border bg-card p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="space-y-2">
          <h2 id={titleId} className="text-lg font-semibold">
            Changer le mot de passe
          </h2>
          <p id={descriptionId} className="text-sm text-muted-foreground">
            Saisissez votre mot de passe actuel puis choisissez un nouveau mot de passe. La session sera fermée après
            validation.
          </p>
        </div>

        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="current-password">Mot de passe actuel</Label>
            <Input
              autoComplete="current-password"
              id="current-password"
              onChange={(event) => setCurrentPassword(event.target.value)}
              ref={currentPasswordRef}
              type="password"
              value={currentPassword}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="new-password">Nouveau mot de passe</Label>
            <Input
              autoComplete="new-password"
              id="new-password"
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
            <PasswordStrengthMeter password={password} />
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
          <div className="flex flex-wrap items-center justify-end gap-3 pt-2">
            <Button disabled={submitting} variant="outline" type="button" onClick={handleDismiss}>
              Fermer
            </Button>
            <Button disabled={submitting} type="submit">
              {submitting ? "Validation..." : "Mettre à jour"}
            </Button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
}
