import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { usePageScrollContainer } from "@/components/layout/page-scroll-container";
import { useAsrStore } from "@/store/asr-store";
import type { TranscriptionSegment } from "@/lib/export";
import logger from "@/lib/logger";
import { estimateTokenCount } from "@/lib/tokens";
import { resolveSegmentSpeakerLabel } from "@/lib/speakerAssignments";
import { SegmentEditorDialog } from "@/components/results/SegmentEditorDialog";
import { useVirtualizedList } from "@/hooks/useVirtualizedList";
import { cn } from "@/lib/utils";

interface ResultsTableProps {
  segments: TranscriptionSegment[];
  enableWordTimestamps?: boolean;
  showSegmentConfidence?: boolean;
  showSpeaker?: boolean;
  speakerOptions?: Array<{ value: string; label: string }>;
  mode?: "upload" | "mic" | "cloud";
  onSegmentTextChange?: (segmentIndex: number, text: string) => void;
  onSegmentSpeakerChange?: (segmentIndex: number, speakerId: string) => void;
  segmentEditingDisabled?: boolean;
  expandToFill?: boolean;
}

const RESULTS_TABLE_FALLBACK_HEIGHT = 360;

export const ResultsTable = memo(function ResultsTable({
  segments,
  enableWordTimestamps,
  showSegmentConfidence,
  showSpeaker,
  speakerOptions,
  mode = "upload",
  onSegmentTextChange,
  onSegmentSpeakerChange,
  segmentEditingDisabled = false,
  expandToFill = false,
}: ResultsTableProps) {
  const [query, setQuery] = useState("");
  const [editingSegment, setEditingSegment] = useState<{ index: number; text: string } | null>(null);
  const storeEnableWordTimestamps = useAsrStore((s) => s.enableWordTimestamps);
  const storeShowSegmentConfidence = useAsrStore((s) => s.showSegmentConfidence);
  const speakerAssignments = useAsrStore((s) => s.speakerAssignments[mode]);
  const pageScrollContainerRef = usePageScrollContainer();
  const resolvedSpeakerOptions = speakerOptions ?? [];
  const resolvedEnableWordTimestamps =
    typeof enableWordTimestamps === "boolean" ? enableWordTimestamps : storeEnableWordTimestamps;
  const resolvedShowSegmentConfidence =
    typeof showSegmentConfidence === "boolean" ? showSegmentConfidence : storeShowSegmentConfidence;
  const hasSpeaker = useMemo(
    () => segments.some((segment) => typeof segment.speaker === "string" && segment.speaker.trim().length > 0),
    [segments]
  );
  const resolvedShowSpeaker =
    typeof showSpeaker === "boolean" ? showSpeaker : hasSpeaker || resolvedSpeakerOptions.length > 0;
  const canEditSegments = Boolean(onSegmentTextChange) && !segmentEditingDisabled;
  const canSelectSpeaker = mode === "cloud" && Boolean(onSegmentSpeakerChange) && resolvedSpeakerOptions.length > 0;
  const canEditSpeaker = canSelectSpeaker && !segmentEditingDisabled && resolvedSpeakerOptions.length > 1;
  const filtered = useMemo(() => {
    if (!query) return segments;
    const lower = query.toLowerCase();
    return segments.filter((segment) => segment.text.toLowerCase().includes(lower));
  }, [query, segments]);
  const totalTokenCount = useMemo(
    () => segments.reduce((acc, segment) => acc + estimateTokenCount(segment.text), 0),
    [segments]
  );

  const gridTemplateColumns = useMemo(() => {
    const columns = ["3rem", "6rem", "6rem"];
    if (resolvedShowSpeaker) {
      columns.push("14rem");
    }
    if (resolvedShowSegmentConfidence) {
      columns.push("6rem");
    }
    columns.push("8rem", "minmax(0, 1fr)");
    return columns.join(" ");
  }, [resolvedShowSegmentConfidence, resolvedShowSpeaker]);

  const estimateRowSize = useCallback(
    (index: number) => {
      const segment = filtered[index];
      if (!segment) {
        return 72;
      }
      let size = 72;
      if (resolvedShowSegmentConfidence) {
        size += 4;
      }
      if (resolvedShowSpeaker) {
        size += 4;
      }
      if (resolvedEnableWordTimestamps && segment.words?.length) {
        size += 24 + Math.min(segment.words.length, 12) * 18;
      }
      if (canEditSegments) {
        size += 8;
      }
      return size;
    },
    [canEditSegments, filtered, resolvedEnableWordTimestamps, resolvedShowSegmentConfidence, resolvedShowSpeaker]
  );

  const {
    parentRef,
    virtualItems,
    totalSize,
    scrollMargin,
    measureElement,
  } = useVirtualizedList({
    items: filtered,
    estimateSize: estimateRowSize,
    getItemKey: (segment) => segment.index,
    overscan: 2,
    fallbackHeight: RESULTS_TABLE_FALLBACK_HEIGHT,
    scrollElementRef: expandToFill ? undefined : pageScrollContainerRef ?? undefined,
  });
  const shouldUsePageScroll = !expandToFill && Boolean(pageScrollContainerRef);

  useEffect(() => {
    if (!editingSegment) return;
    if (!canEditSegments) {
      setEditingSegment(null);
      return;
    }
    const stillVisible = segments.some((segment) => segment.index === editingSegment.index);
    if (!stillVisible) {
      setEditingSegment(null);
    }
  }, [canEditSegments, editingSegment, segments]);

  useEffect(() => {
    logger.info("[results] table mounted", {
      mode,
      segmentCount: segments.length,
      showSpeaker: resolvedShowSpeaker,
      showSegmentConfidence: resolvedShowSegmentConfidence,
      enableWordTimestamps: resolvedEnableWordTimestamps,
    });
    return () => {
      logger.debug("[results] table unmounted", { mode });
    };
  }, [mode, resolvedEnableWordTimestamps, resolvedShowSegmentConfidence, resolvedShowSpeaker, segments.length]);

  useEffect(() => {
    logger.debug("[results] table filter updated", {
      mode,
      query,
      visibleSegments: filtered.length,
      totalSegments: segments.length,
    });
  }, [filtered.length, mode, query, segments.length]);

  const handleSaveSegmentText = useCallback(
    (text: string) => {
      if (!editingSegment || !onSegmentTextChange) return;
      onSegmentTextChange(editingSegment.index, text);
      setEditingSegment(null);
    },
    [editingSegment, onSegmentTextChange]
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className={cn(expandToFill ? "flex h-full min-h-0 flex-col gap-3" : "space-y-3")}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{segments.length} segments</span>
        <span>Tokens (est.) : {totalTokenCount}</span>
      </div>
      {canEditSegments ? (
        <p className="text-xs text-muted-foreground">
          Cliquez sur le texte d’un segment pour modifier sa transcription localement.
        </p>
      ) : null}
      <Input
        placeholder="Rechercher un mot clé…"
        value={query}
        onChange={(event) => {
          logger.debug("[results] search query changed", {
            mode,
            query: event.target.value,
          });
          setQuery(event.target.value);
        }}
      />

      <div
        ref={parentRef}
        data-testid="results-table-scroll"
        className={cn(
          "rounded-md border",
          expandToFill ? "flex-1 min-h-0 overflow-auto" : shouldUsePageScroll ? "overflow-x-auto" : "h-[360px] overflow-auto"
        )}
      >
        <div className="min-w-[860px]" role="table" aria-label="Résultats de transcription">
          <div
            role="row"
            className="sticky top-0 z-10 grid border-b bg-background/95 text-xs font-medium uppercase tracking-wide text-muted-foreground"
            style={{ gridTemplateColumns }}
          >
            <div role="columnheader" className="px-3 py-2">
              #
            </div>
            <div role="columnheader" className="px-3 py-2">
              Début
            </div>
            <div role="columnheader" className="px-3 py-2">
              Fin
            </div>
            {resolvedShowSpeaker ? (
              <div role="columnheader" className="px-3 py-2">
                Intervenant
              </div>
            ) : null}
            {resolvedShowSegmentConfidence ? (
              <div role="columnheader" className="px-3 py-2">
                Conf.
              </div>
            ) : null}
            <div role="columnheader" className="px-3 py-2">
              Tokens (est.)
            </div>
            <div role="columnheader" className="px-3 py-2">
              Texte
            </div>
          </div>

          {filtered.length ? (
            <div className="relative" style={{ height: totalSize }}>
              {virtualItems.map((virtualRow) => {
                const segment = filtered[virtualRow.index];
                if (!segment) {
                  return null;
                }

                return (
                  <div
                    key={segment.index}
                    ref={measureElement}
                      data-index={virtualRow.index}
                      role="row"
                      className="absolute left-0 top-0 grid w-full items-start border-b bg-background/60 text-sm"
                      style={{
                        gridTemplateColumns,
                        transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                      }}
                    >
                    <div role="cell" className="px-3 py-2 font-medium">
                      {segment.index + 1}
                    </div>
                    <div role="cell" className="px-3 py-2 font-mono text-xs">
                      {formatTimestamp(segment.start)}
                    </div>
                    <div role="cell" className="px-3 py-2 font-mono text-xs">
                      {formatTimestamp(segment.end)}
                    </div>
                    {resolvedShowSpeaker ? (
                      <div role="cell" className="px-3 py-2 align-top">
                        {canSelectSpeaker && normalizeSpeakerId(segment.speaker) ? (
                          <Select
                            value={normalizeSpeakerId(segment.speaker) ?? undefined}
                            onValueChange={(value) => {
                              if (!canEditSpeaker || !onSegmentSpeakerChange) return;
                              onSegmentSpeakerChange(segment.index, value);
                            }}
                          >
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <SelectTrigger
                                  aria-label={`Intervenant du segment ${segment.index + 1}`}
                                  className="h-8 w-full text-xs"
                                  disabled={!canEditSpeaker}
                                >
                                  <SelectValue placeholder="Intervenant" />
                                </SelectTrigger>
                              </TooltipTrigger>
                              <TooltipContent side="top" className="max-w-72 text-balance">
                                Changer l&apos;intervenant de ce segment. La modification est enregistrée immédiatement.
                              </TooltipContent>
                            </Tooltip>
                            <SelectContent>
                              {resolvedSpeakerOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <div className="text-sm">
                            {resolveSegmentSpeakerLabel(segment, speakerAssignments, mode) || "—"}
                          </div>
                        )}
                      </div>
                    ) : null}
                    {resolvedShowSegmentConfidence ? (
                      <div role="cell" className="px-3 py-2">
                        {typeof segment.confidence === "number" ? (
                          <div className="text-sm font-mono">
                            <span
                              className={
                                segment.confidence >= 0.85
                                  ? "text-emerald-600"
                                  : segment.confidence >= 0.6
                                    ? "text-amber-600"
                                    : "text-destructive-600"
                              }
                            >
                              {Math.round(segment.confidence * 100)}%
                            </span>
                          </div>
                        ) : (
                          <div className="text-sm text-muted-foreground">—</div>
                        )}
                      </div>
                    ) : null}
                    <div role="cell" className="px-3 py-2 font-mono text-sm">
                      {estimateTokenCount(segment.text)}
                    </div>
                    <div role="cell" className="max-w-xl whitespace-pre-wrap px-3 py-2 text-sm">
                      {canEditSegments ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="group w-full cursor-pointer rounded-md px-2 py-1 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Modifier le segment ${segment.index + 1}`}
                              onClick={() => {
                                setEditingSegment({ index: segment.index, text: segment.text });
                              }}
                            >
                              <div>{segment.text}</div>
                              {resolvedEnableWordTimestamps && segment.words && segment.words.length ? (
                                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                                  {segment.words.map((word, wordIndex) => (
                                    <span key={wordIndex} className="rounded bg-muted/10 px-1 py-0.5">
                                      <span className="font-medium">{word.word}</span>
                                      <span className="ml-1 text-xs text-muted-foreground">
                                        [{formatTimestamp(word.start)} - {formatTimestamp(word.end)}]
                                      </span>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" className="max-w-72 text-balance">
                            Ouvrir l’éditeur du texte de ce segment. Les modifications sont sauvegardées à la validation.
                          </TooltipContent>
                        </Tooltip>
                      ) : (
                        <div className="space-y-2">
                          <div>{segment.text}</div>
                          {resolvedEnableWordTimestamps && segment.words && segment.words.length ? (
                            <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                              {segment.words.map((word, wordIndex) => (
                                <span key={wordIndex} className="rounded bg-muted/10 px-1 py-0.5">
                                  <span className="font-medium">{word.word}</span>
                                  <span className="ml-1 text-xs text-muted-foreground">
                                    [{formatTimestamp(word.start)} - {formatTimestamp(word.end)}]
                                  </span>
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[240px] items-center justify-center px-4 text-sm text-muted-foreground">
              Aucun segment ne correspond à « {query} ».
            </div>
          )}
        </div>
      </div>

      {editingSegment ? (
        <SegmentEditorDialog
          open
          segmentNumber={editingSegment.index + 1}
          initialText={editingSegment.text}
          onSave={handleSaveSegmentText}
          onCancel={() => setEditingSegment(null)}
        />
      ) : null}
      </div>
    </TooltipProvider>
  );
});

function formatTimestamp(seconds: number) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${secs
    .toString()
    .padStart(2, "0")}.${ms.toString().padStart(3, "0")}`;
}

function normalizeSpeakerId(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
