import { Label } from "@/components/ui/label";

interface SliderFieldProps {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  help?: string;
  disabled?: boolean;
}

export function SliderField({ id, label, value, min, max, step, onChange, help, disabled = false }: SliderFieldProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <span className="text-xs text-muted-foreground">{value.toFixed(step < 1 ? 2 : 0)}</span>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className={disabled ? "w-full opacity-60 pointer-events-none" : "w-full"}
        disabled={disabled}
      />
      {help ? <p className="text-[11px] text-muted-foreground">{help}</p> : null}
    </div>
  );
}
