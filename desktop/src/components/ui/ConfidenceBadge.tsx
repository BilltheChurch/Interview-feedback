type ConfidenceBadgeProps = {
  score: number;
};

export function ConfidenceBadge({ score }: ConfidenceBadgeProps) {
  const pct = Math.round(score * 100);

  const colorClass =
    score >= 0.8 ? 'bg-emerald-50 text-success border-emerald-200' :
    score >= 0.5 ? 'bg-amber-50 text-amber-700 border-amber-200' :
    'bg-red-50 text-error border-red-200';

  return (
    <span
      className={`
        inline-flex items-center text-xs font-medium
        rounded-[--radius-chip] border px-2 py-0.5
        ${colorClass}
      `}
    >
      {pct}%
    </span>
  );
}
