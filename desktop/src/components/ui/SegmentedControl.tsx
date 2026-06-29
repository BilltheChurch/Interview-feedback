import type { ReactNode } from 'react';

/**
 * SegmentedControl — glass segmented toggle (e.g. 1 v 1 / Group).
 *
 * The active segment is filled with the accent gradient; inactive segments are quiet and
 * lift on hover. Generic over the value type so callers get type-safe onChange.
 */
type Option<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      className={`flex gap-1 p-1 rounded-xl bg-black/25 border border-white/10 ${className}`}
      role="group"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-[9px] transition-all duration-200 cursor-pointer ${
              active
                ? 'text-[#0c0d18] shadow-[0_4px_14px_-4px_rgba(124,107,255,0.6)]'
                : 'text-ink-secondary hover:text-ink hover:bg-white/5'
            }`}
            style={active ? { backgroundImage: 'var(--gradient-accent)' } : undefined}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
