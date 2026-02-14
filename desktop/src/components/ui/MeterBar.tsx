type MeterBarProps = {
  label: string;
  value: number;
  showValue?: boolean;
};

export function MeterBar({ label, value, showValue }: MeterBarProps) {
  const clamped = Math.max(0, Math.min(100, value));

  // Green at low values, amber at mid, red at high
  const fillColor =
    clamped < 50 ? 'bg-emerald-500' :
    clamped < 80 ? 'bg-amber-500' :
    'bg-red-500';

  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-ink-secondary w-14 shrink-0">{label}</span>
      <div className="flex-1 h-2.5 rounded-full bg-surface-hover overflow-hidden">
        <div
          className={`h-full rounded-full ${fillColor} transition-all duration-100`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showValue && (
        <span className="text-xs text-ink-secondary tabular-nums w-10 text-right shrink-0">
          {Math.round(clamped)}%
        </span>
      )}
    </div>
  );
}
