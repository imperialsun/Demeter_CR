import { cn } from "@/lib/utils";

type BrandMarkProps = {
  className?: string;
  size?: "sm" | "md";
  showTagline?: boolean;
};

export function BrandMark({ className, size = "sm", showTagline = false }: BrandMarkProps) {
  const imageSizeClass = size === "md" ? "h-14 w-14" : "h-10 w-10";
  const titleSizeClass =
    size === "md" ? "text-[clamp(1rem,1.1vw+0.7rem,1.5rem)]" : "text-[clamp(0.95rem,0.9vw+0.65rem,1.25rem)]";
  const taglineSizeClass = size === "md" ? "text-sm" : "text-xs";

  return (
    <div className={cn("flex items-center gap-4", className)}>
      <img
        src="/logo.png"
        alt="Logo Demeter Speech"
        className={cn(
          "shrink-0 rounded-md border border-border/60 bg-background/70 p-1 object-contain shadow-xs",
          imageSizeClass
        )}
        loading="eager"
      />
      <div className="min-w-0">
        <p className={cn("wrap-break-word whitespace-normal font-semibold leading-tight", titleSizeClass)}>
          Demeter Speech
        </p>
        {showTagline ? <p className={cn("text-muted-foreground", taglineSizeClass)}>100% navigateur</p> : null}
      </div>
    </div>
  );
}
