import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface SegmentEditorDialogProps {
  open: boolean;
  segmentNumber: number;
  initialText: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function SegmentEditorDialog({
  open,
  segmentNumber,
  initialText,
  onSave,
  onCancel,
}: SegmentEditorDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const textareaId = useId();
  const [draftText, setDraftText] = useState(initialText);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraftText(initialText);
  }, [initialText, open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onCancel]);

  useEffect(() => {
    if (!open) return;

    const rafId = window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-[61] w-full max-w-2xl rounded-lg border bg-card p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="text-lg font-semibold">
          Modifier le segment #{segmentNumber}
        </h3>
        <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
          Les changements restent locaux à la session et alimentent les exports ainsi que les rapports.
        </p>

        <div className="mt-4 space-y-2">
          <label className="text-sm font-medium" htmlFor={textareaId}>
            Texte du segment
          </label>
          <Textarea
            id={textareaId}
            ref={textareaRef}
            value={draftText}
            onChange={(event) => setDraftText(event.target.value)}
            rows={10}
            className="min-h-48 resize-y"
          />
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Annuler
          </Button>
          <Button
            size="sm"
            onClick={() => {
              onSave(draftText);
            }}
          >
            Enregistrer
          </Button>
        </div>
      </div>
    </div>
  );
}
