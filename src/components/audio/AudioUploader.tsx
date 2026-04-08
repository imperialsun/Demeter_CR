import { useCallback, useEffect, useRef, useState } from "react";
import { UploadCloud, FileAudio, AlertTriangle, Info } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import logger from "@/lib/logger";
import type { AudioMetadata } from "@/lib/audio";
import { TooltipButton } from "@/components/ui/tooltip-button";

interface AudioUploaderProps {
  onFileSelected: (file: File) => void;
  metadata?: AudioMetadata | null;
  disabled?: boolean;
  hideDropZoneWhenMetadata?: boolean;
  title?: string;
  description?: string;
  formatsHint?: string;
}

const WARNING_DURATION_SEC = 3600;
const HARD_WARNING_DURATION_SEC = 7200;

export function AudioUploader({
  onFileSelected,
  metadata,
  disabled,
  hideDropZoneWhenMetadata,
  title,
  description,
  formatsHint,
}: AudioUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    logger.debug("[audio-uploader] mounted", {
      disabled: Boolean(disabled),
      hasMetadata: Boolean(metadata),
    });
    return () => {
      logger.debug("[audio-uploader] unmounted");
    };
  }, [disabled, metadata]);

  useEffect(() => {
    if (!metadata) return;
    logger.info("[audio-uploader] metadata updated", {
      name: metadata.name ?? null,
      durationSec: metadata.durationSec,
      sizeBytes: metadata.sizeBytes ?? null,
      sampleRate: metadata.sampleRate ?? null,
    });
  }, [metadata]);

  const handleFiles = useCallback(
    (items: FileList | null) => {
      logger.debug("[audio-uploader] files selected", { length: items?.length });
      if (!items || items.length === 0) return;
      const file = items[0]!;
      logger.info("[audio-uploader] file accepted", {
        name: file.name,
        sizeBytes: file.size,
        type: file.type,
      });
      onFileSelected(file);
      // Clear the input value after handling so the same file can be selected again later
      try {
        if (inputRef.current) (inputRef.current as HTMLInputElement).value = "";
      } catch (err) { void err; }
    },
    [onFileSelected]
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setIsDragging(false);
      if (disabled) return;
      logger.debug("[audio-uploader] drop received", {
        fileCount: event.dataTransfer.files?.length ?? 0,
      });
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles, disabled]
  );
  const showDropZone = !(hideDropZoneWhenMetadata && metadata);

  const pickFile = useCallback(() => {
    try {
      logger.debug("[audio-uploader] pick file invoked", { inputRef: !!inputRef.current });
      const el = inputRef.current;
      if (el) {
        try {
          const visible = el instanceof HTMLElement ? (el as HTMLElement).offsetParent !== null : true;
          logger.debug("[audio-uploader] input pre-click state", {
            disabled: el.disabled,
            visible,
            accept: el.getAttribute("accept"),
          });
          if (!visible || el.disabled) {
            logger.warn('Audio input not visible or disabled; using fallback input');
            throw new Error('input not actionable');
          }
        } catch (err) { void err; }
        try { el.focus(); } catch (err) { void err; }
        // Clear the input value so selecting the same file again still fires onChange
        try {
          (el as HTMLInputElement).value = "";
        } catch (err) { void err; }
        el.click();
        logger.debug("[audio-uploader] input click dispatched");
      } else {
        logger.warn('AudioUploader.pickFile: inputRef is null, falling back');
        throw new Error('inputRef null');
      }
    } catch (err) {
      logger.error("AudioUploader.pickFile failed, using fallback input", err);
      // Fallback: create a temporary input element and trigger it
      try {
        const tmp = document.createElement("input");
        tmp.type = "file";
        tmp.accept = "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/webm";
        tmp.style.display = "none";
        document.body.appendChild(tmp);
        tmp.addEventListener("change", () => handleFiles(tmp.files));
        tmp.click();
        logger.debug("[audio-uploader] fallback input click dispatched");
        setTimeout(() => { try { document.body.removeChild(tmp); } catch (e) { void e; } }, 2000);
      } catch (err2) {
        logger.error("Fallback pick file creation failed", err2);
      }
    }
  }, [handleFiles]);

  const renderDurationWarning = () => {
    if (!metadata) return null;
    if (metadata.durationSec >= HARD_WARNING_DURATION_SEC) {
      return (
        <div className="flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] leading-snug text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Fichier très long (&gt; 2 h). Préférez le mode progressif et vérifiez le chunking.
        </div>
      );
    }
    if (metadata.durationSec >= WARNING_DURATION_SEC) {
      return (
        <div className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] leading-snug text-amber-500">
          <AlertTriangle className="h-4 w-4" />
          Durée &gt; 1 h : surveillez la mémoire et activez le mode progressif.
        </div>
      );
    }
    return null;
  };
  const durationWarning = renderDurationWarning();

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>{title ?? "Importer un fichier audio"}</CardTitle>
            <CardDescription>
              {description ?? "Glissez-déposez un fichier MP3, WAV ou M4A. Tout est traité localement dans Chrome."}
            </CardDescription>
          </div>
          <TooltipButton
            tooltip="Importez un fichier audio ou cliquez pour choisir un fichier. Vous pourrez le remplacer ensuite."
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            aria-label="Aide import audio"
          >
            <Info className="h-4 w-4" />
          </TooltipButton>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {showDropZone ? (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              if (!disabled) {
                if (!isDragging) {
                  logger.debug("[audio-uploader] drag over started");
                }
                setIsDragging(true);
              }
            }}
            onDragLeave={() => {
              logger.debug("[audio-uploader] drag leave");
              setIsDragging(false);
            }}
            onDrop={handleDrop}
            role="button"
            tabIndex={0}
            className={cn(
              "flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/30 p-6 text-center transition focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              isDragging && !disabled ? "border-primary bg-primary/10" : "",
              disabled ? "cursor-not-allowed opacity-60" : ""
            )}
            onClick={disabled ? undefined : pickFile}
          >
            <UploadCloud className="mb-4 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Déposez votre fichier ici ou <span className="text-primary">cliquez</span> pour parcourir.
            </p>
            <p className="text-xs text-muted-foreground/80">
              {formatsHint ?? "Formats supportés : mp3, wav, m4a, ogg, webm."}
            </p>
            {/* keep the input in the DOM (not display:none) so programmatic click reliably opens the file picker across browsers */}
            <Input
              ref={inputRef}
              type="file"
              accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac,audio/ogg,audio/webm"
              className="sr-only absolute w-0 h-0 opacity-0"
              onChange={(event) => { logger.debug("[audio-uploader] input change", { files: event.target.files?.length }); handleFiles(event.target.files); }}
              onClick={() => logger.debug("[audio-uploader] input clicked")}
              onFocus={() => logger.debug("[audio-uploader] input focused")}
              disabled={disabled}
            />
          </div>
        ) : null}

        {metadata ? (
          <div className="rounded-md border bg-background/60 p-3 text-xs">
            <div className="flex flex-wrap items-center gap-2">
              <FileAudio className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-all [overflow-wrap:anywhere] text-sm font-medium text-foreground">
                {metadata.name ?? "Fichier choisi"}
              </span>
              <Badge variant="outline" className="h-5 px-2 text-[10px]">
                {metadata.mimeType ?? "Type inconnu"}
              </Badge>
            </div>

            <div className="mt-2 flex flex-wrap gap-2">
              <div className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5">
                <span className="font-medium text-muted-foreground">Durée</span>
                <span className="text-foreground">{formatDuration(metadata.durationSec)}</span>
              </div>
              <div className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5">
                <span className="font-medium text-muted-foreground">Taille</span>
                <span className="text-foreground">{metadata.sizeBytes ? formatBytes(metadata.sizeBytes) : "—"}</span>
              </div>
              <div className="inline-flex items-center gap-1 rounded-full border bg-background/80 px-2 py-0.5">
                <span className="font-medium text-muted-foreground">Sample rate</span>
                <span className="text-foreground">{metadata.sampleRate ? `${metadata.sampleRate} Hz` : "Inconnu"}</span>
              </div>
            </div>

            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0 flex-1">{durationWarning}</div>
              <TooltipButton
                tooltip="Remplacer le fichier courant et repartir sur une nouvelle session."
                variant="ghost"
                size="sm"
                className="h-8 px-2 text-xs"
                onClick={pickFile}
                disabled={disabled}
              >
                Changer de fichier
              </TooltipButton>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds)) return "—";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [hrs, mins, secs]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatBytes(bytes: number) {
  const units = ["o", "Ko", "Mo", "Go"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
