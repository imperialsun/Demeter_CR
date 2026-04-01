import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  SpeakerAssignment,
  SpeakerAssignmentEntry,
  SpeakerAssignmentMap,
  SpeakerAssignmentMode,
} from "@/lib/speakerAssignments";

interface SpeakerAssignmentDialogProps {
  mode: SpeakerAssignmentMode;
  entries: SpeakerAssignmentEntry[];
  assignments: SpeakerAssignmentMap;
  onApply: (assignments: SpeakerAssignmentMap) => void;
  onCancel: () => void;
}

type AssignmentDraft = Record<string, SpeakerAssignment>;

type ChunkGroup = {
  chunkId: string;
  chunkLabel: string;
  start: number;
  end: number;
  entries: SpeakerAssignmentEntry[];
};

const buildDraft = (entries: SpeakerAssignmentEntry[], assignments: SpeakerAssignmentMap): AssignmentDraft => {
  const next: AssignmentDraft = {};
  for (const entry of entries) {
    const current = assignments[entry.assignmentKey];
    next[entry.assignmentKey] = {
      firstName: current?.firstName ?? "",
      lastName: current?.lastName ?? "",
    };
  }
  return next;
};

export function SpeakerAssignmentDialog({
  mode,
  entries,
  assignments,
  onApply,
  onCancel,
}: SpeakerAssignmentDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState<AssignmentDraft>(() => buildDraft(entries, assignments));
  const firstNameInputRef = useRef<HTMLInputElement | null>(null);
  const applyButtonRef = useRef<HTMLButtonElement | null>(null);
  const groupedEntries = useMemo(() => groupEntriesByChunk(entries), [entries]);
  const isCloudMode = mode === "cloud";
  const title = isCloudMode ? "Assigner les speakers par chunk" : "Assigner les speakers";
  const description = isCloudMode
    ? "Les labels speaker sont locaux à chaque chunk. SPEAKER_00 d’un chunk n’est pas supposé être la même personne dans un autre chunk."
    : "Renseignez le nom et le prénom pour remplacer les IDs techniques dans les segments et exports.";

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
      if (entries.length > 0) {
        firstNameInputRef.current?.focus();
      } else {
        applyButtonRef.current?.focus();
      }
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [entries.length]);

  const handleValueChange = (assignmentKey: string, key: keyof SpeakerAssignment, value: string) => {
    setDraft((current) => ({
      ...current,
      [assignmentKey]: {
        firstName: current[assignmentKey]?.firstName ?? "",
        lastName: current[assignmentKey]?.lastName ?? "",
        [key]: value,
      },
    }));
  };

  const handleApply = () => {
    const nextAssignments: SpeakerAssignmentMap = {};
    for (const entry of entries) {
      const row = draft[entry.assignmentKey];
      const firstName = row?.firstName.trim() ?? "";
      const lastName = row?.lastName.trim() ?? "";
      if (!firstName && !lastName) continue;
      nextAssignments[entry.assignmentKey] = { firstName, lastName };
    }

    onApply(nextAssignments);
  };

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/55" aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="relative z-[91] w-full max-w-2xl rounded-lg border bg-card p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h3 id={titleId} className="text-lg font-semibold">
          {title}
        </h3>
        <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">
          {description}
        </p>

        {entries.length ? (
          <div className="mt-4 max-h-[50vh] space-y-3 overflow-auto pr-1">
            {isCloudMode
              ? groupedEntries.map((group, groupIndex) => (
                  <section key={group.chunkId} className="rounded-md border p-3">
                    <div className="border-b pb-2">
                      <div className="text-sm font-medium text-foreground">{group.chunkLabel}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatTimestamp(group.start)} - {formatTimestamp(group.end)}
                      </div>
                      <div className="text-xs text-muted-foreground">ID technique: {group.chunkId}</div>
                    </div>
                    <div className="mt-3 space-y-3">
                      {group.entries.map((entry, entryIndex) => {
                        const values = draft[entry.assignmentKey] ?? { firstName: "", lastName: "" };
                        const domId = toDomId(entry.assignmentKey);
                        const focusInput = groupIndex === 0 && entryIndex === 0;
                        return (
                          <div key={entry.assignmentKey} className="rounded-md border p-3">
                            <div className="text-xs font-medium text-muted-foreground">{entry.speakerId}</div>
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <div className="space-y-1">
                                <label className="text-xs text-muted-foreground" htmlFor={`speaker-last-name-${domId}`}>
                                  Nom
                                </label>
                                <Input
                                  id={`speaker-last-name-${domId}`}
                                  aria-label={`Nom ${group.chunkLabel} ${entry.speakerId}`}
                                  ref={focusInput ? firstNameInputRef : undefined}
                                  value={values.lastName}
                                  onChange={(event) => handleValueChange(entry.assignmentKey, "lastName", event.target.value)}
                                />
                              </div>
                              <div className="space-y-1">
                                <label className="text-xs text-muted-foreground" htmlFor={`speaker-first-name-${domId}`}>
                                  Prénom
                                </label>
                                <Input
                                  id={`speaker-first-name-${domId}`}
                                  aria-label={`Prénom ${group.chunkLabel} ${entry.speakerId}`}
                                  value={values.firstName}
                                  onChange={(event) => handleValueChange(entry.assignmentKey, "firstName", event.target.value)}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))
              : entries.map((entry, index) => {
                  const values = draft[entry.assignmentKey] ?? { firstName: "", lastName: "" };
                  const domId = toDomId(entry.assignmentKey);
                  return (
                    <div key={entry.assignmentKey} className="rounded-md border p-3">
                      <div className="text-xs font-medium text-muted-foreground">{entry.speakerId}</div>
                      <div className="mt-2 grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground" htmlFor={`speaker-last-name-${domId}`}>
                            Nom
                          </label>
                          <Input
                            id={`speaker-last-name-${domId}`}
                            aria-label={`Nom ${entry.speakerId}`}
                            ref={index === 0 ? firstNameInputRef : undefined}
                            value={values.lastName}
                            onChange={(event) => handleValueChange(entry.assignmentKey, "lastName", event.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs text-muted-foreground" htmlFor={`speaker-first-name-${domId}`}>
                            Prénom
                          </label>
                          <Input
                            id={`speaker-first-name-${domId}`}
                            aria-label={`Prénom ${entry.speakerId}`}
                            value={values.firstName}
                            onChange={(event) => handleValueChange(entry.assignmentKey, "firstName", event.target.value)}
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

function groupEntriesByChunk(entries: SpeakerAssignmentEntry[]): ChunkGroup[] {
  const groups: ChunkGroup[] = [];
  const groupByChunkId = new Map<string, ChunkGroup>();

  for (const entry of entries) {
    const normalizedChunkId = entry.chunkId || "__default__";
    const existing = groupByChunkId.get(normalizedChunkId);
    if (existing) {
      existing.entries.push(entry);
      existing.start = Math.min(existing.start, entry.start);
      existing.end = Math.max(existing.end, entry.end);
      continue;
    }

    const nextGroup: ChunkGroup = {
      chunkId: entry.chunkId,
      chunkLabel: entry.chunkLabel,
      start: entry.start,
      end: entry.end,
      entries: [entry],
    };
    groupByChunkId.set(normalizedChunkId, nextGroup);
    groups.push(nextGroup);
  }

  return groups;
}

function formatTimestamp(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds - Math.floor(seconds)) * 1000);
  return `${hrs.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${millis.toString().padStart(3, "0")}`;
}

function toDomId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
