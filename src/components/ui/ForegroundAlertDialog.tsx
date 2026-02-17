import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";

type ForegroundAlertSeverity = "warning" | "error";

interface ForegroundAlertDialogProps {
  open: boolean;
  title: string;
  description: string;
  severity: ForegroundAlertSeverity;
  onClose: () => void;
  ackLabel?: string;
}

export function ForegroundAlertDialog({
  open,
  title,
  description,
  severity,
  onClose,
  ackLabel = "Compris",
}: ForegroundAlertDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const acknowledgeButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;

    const rafId = window.requestAnimationFrame(() => {
      acknowledgeButtonRef.current?.focus();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [open]);

  if (!open) return null;

  const accentClass =
    severity === "error"
      ? "border-red-500/70 bg-red-500/10 text-red-700 dark:text-red-300"
      : "border-amber-500/70 bg-amber-500/10 text-amber-700 dark:text-amber-300";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-[61] w-full max-w-xl rounded-lg border bg-card p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`mb-4 rounded-md border px-3 py-2 text-xs font-semibold uppercase tracking-wide ${accentClass}`}>
          {severity === "error" ? "Erreur" : "Avertissement"}
        </div>
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        <p id={descriptionId} className="mt-3 text-sm text-muted-foreground">
          {description}
        </p>
        <div className="mt-6 flex justify-end">
          <Button ref={acknowledgeButtonRef} onClick={onClose}>
            {ackLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
