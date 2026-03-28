import { cn } from "@/lib/utils";

import { getPasswordStrength } from "@/lib/password-strength";

interface PasswordStrengthMeterProps {
  password: string;
  className?: string;
}

const BAR_CLASSES: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "bg-muted-foreground/50",
  1: "bg-destructive",
  2: "bg-orange-500",
  3: "bg-amber-500",
  4: "bg-emerald-500",
};

export function PasswordStrengthMeter({ password, className }: PasswordStrengthMeterProps) {
  const strength = getPasswordStrength(password);
  const widthPercent = `${(strength.score / 4) * 100}%`;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-muted-foreground">Sécurité du mot de passe</span>
        <span className={cn("font-semibold", strength.score >= 3 ? "text-foreground" : "text-muted-foreground")}>
          {strength.label}
        </span>
      </div>
      <div
        aria-label="Sécurité du mot de passe"
        aria-valuemax={4}
        aria-valuemin={0}
        aria-valuenow={strength.score}
        aria-valuetext={`${strength.label}. ${strength.hint}`}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div
          className={cn("h-full rounded-full transition-all", BAR_CLASSES[strength.score])}
          style={{ width: widthPercent }}
        />
      </div>
      <p className="text-xs text-muted-foreground">{strength.hint}</p>
    </div>
  );
}
