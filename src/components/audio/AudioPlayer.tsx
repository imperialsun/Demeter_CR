import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAsrStore } from "@/store/asr-store";
import type { AudioMetadata } from "@/lib/audio";
import { Play, Pause, SkipBack, SkipForward, Repeat, Volume2, ChevronLeft, ChevronRight } from "lucide-react";

interface AudioPlayerProps {
  file?: File | null;
  metadata?: AudioMetadata | null;
}

export function AudioPlayer({ file, metadata }: AudioPlayerProps) {
  const objectUrl = useMemo(() => {
    if (!file) return undefined;
    return URL.createObjectURL(file);
  }, [file]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(1);
  const [loop, setLoop] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);

  const segments = useAsrStore((s) => s.segments);

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
    el.loop = loop;
  }, [playbackRate, volume, loop]);

  const onLoaded = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    setDuration(el.duration || undefined);
  }, []);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!isSeeking) setCurrentTime(el.currentTime || 0);
  }, [isSeeking]);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, []);

  const skip = useCallback((secs: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min((el.duration || 0), el.currentTime + secs));
    setCurrentTime(el.currentTime);
  }, []);

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

  const formattedCurrent = useMemo(() => formatShortTime(currentTime), [currentTime]);
  const formattedDuration = useMemo(() => (typeof duration === "number" ? formatShortTime(duration) : "--:--"), [duration]);

  if (!file) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pré-écoute</CardTitle>
        <CardDescription>Contrôlez rapidement le fichier importé avant de lancer la transcription.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <audio
          ref={audioRef}
          preload="metadata"
          className="w-full hidden"
          onLoadedMetadata={onLoaded}
          onTimeUpdate={onTimeUpdate}
        >
          <source src={objectUrl} type={file.type || "audio/mpeg"} />
          Votre navigateur ne supporte pas la balise audio.
        </audio>

        <div className="w-full min-w-[240px]">
          <input
            aria-label="Progression"
            type="range"
            min={0}
            max={duration ?? 0}
            step={0.01}
            value={Math.min(duration ?? 0, currentTime)}
            onChange={(e) => {
              const val = Number((e.target as HTMLInputElement).value);
              setCurrentTime(val);
            }}
            onPointerDown={() => setIsSeeking(true)}
            onPointerUp={(e) => {
              const val = Number((e.target as HTMLInputElement).value);
              const el = audioRef.current;
              if (el) el.currentTime = val;
              setIsSeeking(false);
            }}
            className="w-full h-2"
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

          <div className="flex items-center gap-2 flex-1 min-w-0">
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
              {formattedCurrent} / {formattedDuration}
            </div>
          </div>
        </div>

        {metadata ? (
          <div className="grid gap-1 text-sm text-muted-foreground">
            <span>Nom : {metadata.name}</span>
            <span>Durée : {formatDuration(metadata.durationSec)}</span>
            <span>Sample rate : {metadata.sampleRate ? `${metadata.sampleRate} Hz` : "Inconnu"}</span>
          </div>
        ) : null}
      </CardContent>
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
