import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SpeakerAssignment, SpeakerAssignmentMap } from "@/lib/speakerAssignments";

interface SpeakerAssignmentDialogProps {
  speakerIds: string[];
  assignments: SpeakerAssignmentMap;
  onApply: (assignments: SpeakerAssignmentMap) => void;
  onCancel: () => void;
}

type AssignmentDraft = Record<string, SpeakerAssignment>;

const buildDraft = (speakerIds: string[], assignments: SpeakerAssignmentMap): AssignmentDraft => {
  const next: AssignmentDraft = {};
  for (const speakerId of speakerIds) {
    const current = assignments[speakerId];
    next[speakerId] = {
      firstName: current?.firstName ?? "",
      lastName: current?.lastName ?? "",
    };
  }
  return next;
};

export function SpeakerAssignmentDialog({
  speakerIds,
  assignments,
  onApply,
  onCancel,
}: SpeakerAssignmentDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<AssignmentDraft>(() => buildDraft(speakerIds, assignments));
  const firstNameInputRef = useRef<HTMLInputElement | null>(null);
  const applyButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
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
  }, [onCancel]);

  useEffect(() => {
    const rafId = window.requestAnimationFrame(() => {
      if (speakerIds.length > 0) {
        firstNameInputRef.current?.focus();
      } else {
        applyButtonRef.current?.focus();
      }
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [speakerIds.length]);

  const handleValueChange = (speakerId: string, key: keyof SpeakerAssignment, value: string) => {
    setDraft((current) => ({
      ...current,
      [speakerId]: {
        firstName: current[speakerId]?.firstName ?? "",
        lastName: current[speakerId]?.lastName ?? "",
        [key]: value,
      },
    }));
  };

  const handleApply = () => {
    const nextAssignments: SpeakerAssignmentMap = {};
    for (const speakerId of speakerIds) {
      const row = draft[speakerId];
      const firstName = row?.firstName.trim() ?? "";
      const lastName = row?.lastName.trim() ?? "";
      if (!firstName && !lastName) continue;
      nextAssignments[speakerId] = { firstName, lastName };
    }

    onApply(nextAssignments);
  };

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
          Assigner les speakers
        </h3>
        <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
          Renseignez le nom et le prénom pour remplacer les IDs techniques dans les segments et exports.
        </p>

        {speakerIds.length ? (
          <div className="mt-4 max-h-[50vh] space-y-3 overflow-auto pr-1">
            {speakerIds.map((speakerId, index) => {
              const values = draft[speakerId] ?? { firstName: "", lastName: "" };
              return (
                <div key={speakerId} className="rounded-md border p-3">
                  <div className="text-xs font-medium text-muted-foreground">{speakerId}</div>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`speaker-last-name-${speakerId}`}>
                        Nom
                      </label>
                      <Input
                        id={`speaker-last-name-${speakerId}`}
                        aria-label={`Nom ${speakerId}`}
                        ref={index === 0 ? firstNameInputRef : undefined}
                        value={values.lastName}
                        onChange={(event) => handleValueChange(speakerId, "lastName", event.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs text-muted-foreground" htmlFor={`speaker-first-name-${speakerId}`}>
                        Prénom
                      </label>
                      <Input
                        id={`speaker-first-name-${speakerId}`}
                        aria-label={`Prénom ${speakerId}`}
                        value={values.firstName}
                        onChange={(event) => handleValueChange(speakerId, "firstName", event.target.value)}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 text-sm text-muted-foreground">Aucun speaker détecté.</p>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Annuler
          </Button>
          <Button ref={applyButtonRef} size="sm" onClick={handleApply}>
            Appliquer
          </Button>
        </div>
      </div>
    </div>
  );
}
