import type { HTMLAttributes, ReactNode } from 'react';

/**
 * GlassCard — a translucent liquid-glass panel (Midnight vibrancy).
 *
 * Uses the `.glass` utility (blur + saturate + hairline + depth shadow) on the card
 * radius. `hoverable` adds a subtle lift on hover (CSS-only, respects reduced-motion via
 * the global media query). For staggered entrance, wrap in a `motion.div` with the shared
 * `staggerItem` variant — kept separate so the card itself stays presentational.
 */
type GlassCardProps = {
  hoverable?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

export function GlassCard({ hoverable = false, className = '', children, ...props }: GlassCardProps) {
  return (
    <div
      className={`glass rounded-[--radius-card] ${
        hoverable
          ? 'transition-all duration-300 hover:-translate-y-1 hover:shadow-card-hover hover:border-white/20'
          : ''
      } ${className}`}
      {...props}
    >
      {children}
    </div>
  );
}
