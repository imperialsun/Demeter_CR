import { useId } from "react";

import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  cancelLabel?: string;
  confirmLabel?: string;
}

export function ConfirmDialog({
  open,
  title,
  description,
  onConfirm,
  onCancel,
  cancelLabel = "Annuler",
  confirmLabel = "Confirmer",
}: ConfirmDialogProps) {
  const titleId = useId();
  const descriptionId = useId();

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descriptionId : undefined}
        className="relative z-[101] w-full max-w-md rounded-lg bg-card p-6 shadow-lg"
      >
        {title ? (
          <h3 id={titleId} className="mb-2 text-lg font-semibold">
            {title}
          </h3>
        ) : null}
        {description ? (
          <p id={descriptionId} className="mb-4 text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
