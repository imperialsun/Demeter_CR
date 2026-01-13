import { useCallback, useRef, useState } from "react";
import { UploadCloud, FileAudio, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { AudioMetadata } from "@/lib/audio";

interface AudioUploaderProps {
  onFileSelected: (file: File) => void;
  metadata?: AudioMetadata | null;
  disabled?: boolean;
}

const WARNING_DURATION_SEC = 3600;
const HARD_WARNING_DURATION_SEC = 7200;

export function AudioUploader({ onFileSelected, metadata, disabled }: AudioUploaderProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleFiles = useCallback(
    (items: FileList | null) => {
      import("@/lib/logger").then(({ info }) => info("AudioUploader.handleFiles called", { length: items?.length }));
      if (!items || items.length === 0) return;
      const file = items[0]!;
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
      handleFiles(event.dataTransfer.files);
    },
    [handleFiles, disabled]
  );

  const pickFile = useCallback(() => {
    try {
      import("@/lib/logger").then(({ info }) => info("AudioUploader.pickFile invoked", { inputRef: !!inputRef.current }));
      const el = inputRef.current;
      if (el) {
        try {
          const visible = el instanceof HTMLElement ? (el as HTMLElement).offsetParent !== null : true;
          import("@/lib/logger").then(({ info }) => info('Audio input pre-click state', { disabled: el.disabled, visible, accept: el.getAttribute('accept') }));
          if (!visible || el.disabled) {
            import("@/lib/logger").then(({ warn }) => warn('Audio input not visible or disabled; using fallback input'));
            throw new Error('input not actionable');
          }
        } catch (err) { void err; }
        try { el.focus(); } catch (err) { void err; }
        // Clear the input value so selecting the same file again still fires onChange
        try {
          (el as HTMLInputElement).value = "";
        } catch (err) { void err; }
        el.click();
        import("@/lib/logger").then(({ info }) => info('Audio input click dispatched'));
      } else {
        import("@/lib/logger").then(({ warn }) => warn('AudioUploader.pickFile: inputRef is null, falling back'));
        throw new Error('inputRef null');
      }
    } catch (err) {
      import("@/lib/logger").then(({ error }) => error("AudioUploader.pickFile failed, using fallback input", err));
      // Fallback: create a temporary input element and trigger it
      try {
        const tmp = document.createElement("input");
        tmp.type = "file";
        tmp.accept = "audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac";
        tmp.style.display = "none";
        document.body.appendChild(tmp);
        tmp.addEventListener("change", () => handleFiles(tmp.files));
        tmp.click();
        import("@/lib/logger").then(({ info }) => info('Fallback input click dispatched'));
        setTimeout(() => { try { document.body.removeChild(tmp); } catch (e) { void e; } }, 2000);
      } catch (err2) {
        import("@/lib/logger").then(({ error }) => error("Fallback pick file creation failed", err2));
      }
    }
  }, [handleFiles]);

  const renderDurationWarning = () => {
    if (!metadata) return null;
    if (metadata.durationSec >= HARD_WARNING_DURATION_SEC) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          Fichier très long (&gt; 2 h). Préférez le mode progressif et vérifiez le chunking.
        </div>
      );
    }
    if (metadata.durationSec >= WARNING_DURATION_SEC) {
      return (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-500">
          <AlertTriangle className="h-4 w-4" />
          Durée &gt; 1 h : surveillez la mémoire et activez le mode progressif.
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>Importer un fichier audio</CardTitle>
        <CardDescription>
          Glissez-déposez un fichier MP3, WAV ou M4A. Tout est traité localement dans Chrome.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!disabled) setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          role="button"
          tabIndex={0}
          className={cn(
            "flex min-h-[200px] cursor-pointer flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/30 p-6 text-center transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDragging && !disabled ? "border-primary bg-primary/10" : "",
            disabled ? "cursor-not-allowed opacity-60" : ""
          )}
          onClick={disabled ? undefined : pickFile}
        >
          <UploadCloud className="mb-4 h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Déposez votre fichier ici ou <span className="text-primary">cliquez</span> pour parcourir.
          </p>
          <p className="text-xs text-muted-foreground/80">Formats supportés : mp3, wav, m4a.</p>
          {/* keep the input in the DOM (not display:none) so programmatic click reliably opens the file picker across browsers */}
          <Input
            ref={inputRef}
            type="file"
            accept="audio/mpeg,audio/wav,audio/x-wav,audio/mp4,audio/x-m4a,audio/aac"
            className="sr-only absolute w-0 h-0 opacity-0"
            onChange={(event) => { import("@/lib/logger").then(({ info }) => info('Audio input onChange', { files: event.target.files?.length })); handleFiles(event.target.files); }}
            onClick={() => import("@/lib/logger").then(({ info }) => info('Audio input clicked'))}
            onFocus={() => import("@/lib/logger").then(({ info }) => info('Audio input focused'))}
            disabled={disabled}
          />
        </div>

        {metadata ? (
          <div className="rounded-md border bg-background/60 p-4 text-sm">
            <div className="flex items-center gap-2 text-muted-foreground">
              <FileAudio className="h-4 w-4" />
              <span>{metadata.name ?? "Fichier choisi"}</span>
              <Badge variant="outline">{metadata.mimeType ?? "Type inconnu"}</Badge>
            </div>
            <dl className="mt-2 grid gap-1 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <dt>Durée</dt>
                <dd>{formatDuration(metadata.durationSec)}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Taille</dt>
                <dd>{metadata.sizeBytes ? formatBytes(metadata.sizeBytes) : "—"}</dd>
              </div>
              <div className="flex justify-between">
                <dt>Sample rate</dt>
                <dd>{metadata.sampleRate ? `${metadata.sampleRate} Hz` : "Inconnu"}</dd>
              </div>
            </dl>
            <div className="mt-3 flex justify-end">
              <Button variant="ghost" size="sm" onClick={pickFile} disabled={disabled}>
                Changer de fichier
              </Button>
            </div>
            <div className="mt-3">{renderDurationWarning()}</div>
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
