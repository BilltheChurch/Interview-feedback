import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';

type SplitButtonOption = {
  label: string;
  value: string;
  icon?: React.ReactNode;
};

type SplitButtonProps = {
  options: SplitButtonOption[];
  onSelect: (value: string) => void;
  loading?: boolean;
  disabled?: boolean;
  className?: string;
};

export function SplitButton({ options, onSelect, loading, disabled, className = '' }: SplitButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const primary = options[0];
  if (!primary) return null;

  return (
    <div ref={ref} className={`relative inline-flex ${className}`}>
      {/* Main action */}
      <button
        onClick={() => onSelect(primary.value)}
        disabled={disabled || loading}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-l-[--radius-button] bg-accent text-white hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
      >
        {loading ? (
          <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
        ) : primary.icon ? (
          <span className="w-3.5 h-3.5 flex items-center justify-center">{primary.icon}</span>
        ) : null}
        {primary.label}
      </button>

      {/* Dropdown toggle */}
      {options.length > 1 && (
        <button
          onClick={() => setOpen(!open)}
          disabled={disabled || loading}
          className="inline-flex items-center px-1.5 py-1.5 rounded-r-[--radius-button] bg-accent text-white hover:bg-accent/90 border-l border-white/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}

      {/* Dropdown menu */}
      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-[--radius-card] shadow-lg border border-border z-50">
          {options.slice(1).map((opt) => (
            <button
              key={opt.value}
              onClick={() => {
                onSelect(opt.value);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface-hover transition-colors first:rounded-t-[--radius-card] last:rounded-b-[--radius-card] flex items-center gap-2 cursor-pointer"
            >
              {opt.icon && <span className="w-4 h-4 flex items-center justify-center">{opt.icon}</span>}
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
