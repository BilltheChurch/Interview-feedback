import type { ReactNode } from 'react';

const variantStyles = {
  default: 'bg-surface-hover border-border text-ink-secondary',
  accent: 'bg-accent-soft border-accent/20 text-accent',
  info: 'bg-blue-50 border-blue-200 text-blue-700',
  warning: 'bg-amber-50 border-amber-200 text-amber-700',
  error: 'bg-red-50 border-red-200 text-error',
  success: 'bg-emerald-50 border-emerald-200 text-success',
} as const;

type ChipProps = {
  variant?: keyof typeof variantStyles;
  children: ReactNode;
  className?: string;
};

export function Chip({ variant = 'default', children, className = '' }: ChipProps) {
  return (
    <span
      className={`
        inline-flex items-center rounded-[--radius-pill] border
        text-xs font-medium px-2.5 py-0.5
        ${variantStyles[variant]}
        ${className}
      `}
    >
      {children}
    </span>
  );
}
