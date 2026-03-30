import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAsrStore } from "@/store/asr-store";
import type { AudioMetadata } from "@/lib/audio";
import type { TranscriptionSegment } from "@/lib/export";
import { Play, Pause, SkipBack, SkipForward, Repeat, Volume2, ChevronLeft, ChevronRight } from "lucide-react";

interface AudioPlayerProps {
  file?: File | null;
  metadata?: AudioMetadata | null;
  previewUrl?: string | null;
  segments?: TranscriptionSegment[];
  rangeStart?: number;
  rangeEnd?: number;
  timeDisplayMode?: "relative" | "absolute";
  variant?: "card" | "inline";
}

export function AudioPlayer({
  file,
  metadata,
  previewUrl,
  segments: segmentsProp,
  rangeStart,
  rangeEnd,
  timeDisplayMode = "relative",
  variant = "card",
}: AudioPlayerProps) {
  const objectUrl = useMemo(() => {
    if (!file || previewUrl) return undefined;
    return URL.createObjectURL(file);
  }, [file, previewUrl]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [loop, setLoop] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);

  const storeSegments = useAsrStore((s) => s.segments);
  const hasRangePlayback =
    typeof rangeStart === "number" && typeof rangeEnd === "number" && Number.isFinite(rangeStart) && Number.isFinite(rangeEnd) && rangeEnd > rangeStart;
  const playbackStart = hasRangePlayback ? Math.max(0, rangeStart) : 0;
  const playbackEnd = hasRangePlayback ? Math.max(playbackStart, rangeEnd) : duration ?? 0;
  const segments = useMemo(() => {
    const sourceSegments = segmentsProp ?? storeSegments;
    if (!hasRangePlayback) return sourceSegments;
    return sourceSegments.filter((segment) => segment.end > playbackStart && segment.start < playbackEnd);
  }, [hasRangePlayback, playbackEnd, playbackStart, segmentsProp, storeSegments]);

  useEffect(() => {
    return () => {
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [objectUrl]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.playbackRate = playbackRate;
    el.volume = volume;
    el.loop = hasRangePlayback ? false : loop;
  }, [hasRangePlayback, playbackRate, volume, loop]);

  useEffect(() => {
    if (!hasRangePlayback) return;
    setCurrentTime(playbackStart);
    const el = audioRef.current;
    if (!el) return;
    if (el.readyState > 0) {
      el.currentTime = playbackStart;
    }
  }, [hasRangePlayback, playbackStart]);

  const onLoaded = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    setDuration(el.duration || undefined);
    if (hasRangePlayback) {
      el.currentTime = playbackStart;
      setCurrentTime(playbackStart);
    }
  }, [hasRangePlayback, playbackStart]);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    const current = el.currentTime || 0;
    if (hasRangePlayback && current >= playbackEnd - 0.01) {
      if (loop) {
        el.currentTime = playbackStart;
        setCurrentTime(playbackStart);
        void el.play();
        return;
      }
      el.currentTime = playbackEnd;
      el.pause();
      setIsPlaying(false);
      setCurrentTime(playbackEnd);
      return;
    }
    if (!isSeeking) setCurrentTime(current);
  }, [hasRangePlayback, isSeeking, loop, playbackEnd, playbackStart]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (hasRangePlayback && (el.currentTime < playbackStart || el.currentTime >= playbackEnd)) {
      el.currentTime = playbackStart;
      setCurrentTime(playbackStart);
    }
    if (el.paused) {
      void el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, [hasRangePlayback, playbackEnd, playbackStart]);

  const skip = useCallback((secs: number) => {
    const el = audioRef.current;
    if (!el) return;
    const minTime = hasRangePlayback ? playbackStart : 0;
    const maxTime = hasRangePlayback ? playbackEnd : el.duration || 0;
    el.currentTime = Math.max(minTime, Math.min(maxTime, el.currentTime + secs));
    setCurrentTime(el.currentTime);
  }, [hasRangePlayback, playbackEnd, playbackStart]);

  const prevSegment = useCallback(() => {
    if (!segments.length) return;
    const t = currentTime;
    const prev = [...segments].reverse().find((s) => s.start < t - 0.05);
    if (prev && audioRef.current) {
      audioRef.current.currentTime = prev.start;
      setCurrentTime(prev.start);
    }
  }, [segments, currentTime]);

  const nextSegment = useCallback(() => {
    if (!segments.length) return;
    const t = currentTime;
    const next = segments.find((s) => s.start > t + 0.05);
    if (next && audioRef.current) {
      audioRef.current.currentTime = next.start;
      setCurrentTime(next.start);
    }
  }, [segments, currentTime]);

  const displayCurrent = hasRangePlayback
    ? timeDisplayMode === "relative"
      ? Math.max(0, Math.min(playbackEnd - playbackStart, currentTime - playbackStart))
      : Math.max(playbackStart, Math.min(playbackEnd, currentTime))
    : currentTime;
  const displayDuration = hasRangePlayback
    ? timeDisplayMode === "relative"
      ? Math.max(0, playbackEnd - playbackStart)
      : playbackEnd
    : duration;
  const sliderMax = hasRangePlayback ? (duration ? Math.min(playbackEnd, duration) : playbackEnd) : duration ?? 0;
  const formattedDisplayCurrent = useMemo(() => formatShortTime(displayCurrent), [displayCurrent]);
  const formattedDisplayDuration = useMemo(
    () => (typeof displayDuration === "number" ? formatShortTime(displayDuration) : "--:--"),
    [displayDuration]
  );

  if (!file) {
    return null;
  }

  const src = previewUrl ?? objectUrl;
  if (!src) {
    return null;
  }

  const body = (
    <>
      <audio ref={audioRef} preload="metadata" className="hidden" onLoadedMetadata={onLoaded} onTimeUpdate={onTimeUpdate}>
        <source src={src} type={file.type || "audio/mpeg"} />
        Votre navigateur ne supporte pas la balise audio.
      </audio>

      <div className="w-full min-w-[240px]">
        <input
          aria-label="Progression"
          type="range"
          min={hasRangePlayback ? playbackStart : 0}
          max={sliderMax}
          step={0.01}
          value={Math.min(sliderMax, Math.max(hasRangePlayback ? playbackStart : 0, currentTime))}
          onChange={(e) => {
            const val = Number((e.target as HTMLInputElement).value);
            setCurrentTime(val);
          }}
          onPointerDown={() => setIsSeeking(true)}
          onPointerUp={(e) => {
            const val = Number((e.target as HTMLInputElement).value);
            const el = audioRef.current;
            if (el) {
              const maxTime = hasRangePlayback ? sliderMax : el.duration || 0;
              el.currentTime = Math.max(hasRangePlayback ? playbackStart : 0, Math.min(maxTime, val));
            }
            setIsSeeking(false);
          }}
          className="h-2 w-full"
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => skip(-5)} title="Recule de 5s">
            <SkipBack className="h-4 w-4" />
          </Button>
          <Button size="sm" onClick={togglePlay} className="gap-2">
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {isPlaying ? "Pause" : "Lecture"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => skip(5)} title="Avance de 5s">
            <SkipForward className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={prevSegment} title="Segment précédent">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" onClick={nextSegment} title="Segment suivant">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <Select value={String(playbackRate)} onValueChange={(v) => setPlaybackRate(Number(v))}>
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0.5">0.5×</SelectItem>
              <SelectItem value="0.75">0.75×</SelectItem>
              <SelectItem value="1">1×</SelectItem>
              <SelectItem value="1.25">1.25×</SelectItem>
              <SelectItem value="1.5">1.5×</SelectItem>
              <SelectItem value="2">2×</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="flex items-center gap-2">
            <Button size="sm" variant={loop ? "secondary" : "ghost"} onClick={() => setLoop((l) => !l)} title="Boucle">
              <Repeat className="h-4 w-4" />
            </Button>
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-muted-foreground" />
              <input
                aria-label="Volume"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="ml-auto text-sm text-muted-foreground">
            {formattedDisplayCurrent} / {formattedDisplayDuration}
          </div>
        </div>
      </div>

      {metadata ? (
        <div className="grid gap-1 text-sm text-muted-foreground">
          <span className="min-w-0 break-all [overflow-wrap:anywhere]">Nom : {metadata.name}</span>
          <span>Durée : {formatDuration(metadata.durationSec)}</span>
          <span>Sample rate : {metadata.sampleRate ? `${metadata.sampleRate} Hz` : "Inconnu"}</span>
        </div>
      ) : null}
    </>
  );

  if (variant === "inline") {
    return <div className="space-y-3 rounded-md border bg-muted/20 p-4">{body}</div>;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pré-écoute</CardTitle>
        <CardDescription>Contrôlez rapidement le fichier importé avant de lancer la transcription.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">{body}</CardContent>
    </Card>
  );
}

function formatDuration(seconds?: number) {
  if (!seconds && seconds !== 0) return "—";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return [hrs, mins, secs]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function formatShortTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}
