import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  description?: string;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

export function ConfirmDialog({ open, title, description, onConfirm, onCancel }: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
        {title ? <h3 className="mb-2 text-lg font-semibold">{title}</h3> : null}
        {description ? <p className="mb-4 text-sm text-muted-foreground">{description}</p> : null}
        <div className="flex justify-end gap-3">
          <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>Confirmer</Button>
        </div>
      </div>
    </div>
  );
}
