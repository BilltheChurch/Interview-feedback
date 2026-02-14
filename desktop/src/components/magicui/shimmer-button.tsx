/**
 * ShimmerButton — Magic UI inspired button with animated shimmer effect.
 * A premium-feeling CTA button with a sweeping light animation.
 */
import { type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

type ShimmerButtonProps = {
  children: ReactNode;
  shimmerColor?: string;
  shimmerSize?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>;

export function ShimmerButton({
  children,
  shimmerColor = 'rgba(255,255,255,0.3)',
  shimmerSize = '0.1em',
  className,
  ...props
}: ShimmerButtonProps) {
  return (
    <button
      className={cn(
        'group relative inline-flex items-center justify-center gap-2 overflow-hidden',
        'rounded-[--radius-button] px-5 py-2.5',
        'bg-accent text-white font-medium text-sm',
        'transition-all duration-300',
        'hover:shadow-lg hover:scale-[1.02] active:scale-[0.98]',
        'disabled:opacity-50 disabled:pointer-events-none',
        'cursor-pointer',
        className,
      )}
      {...props}
    >
      {/* Shimmer sweep */}
      <div
        className="absolute inset-0 overflow-hidden rounded-[inherit]"
        style={{ '--shimmer-color': shimmerColor, '--shimmer-size': shimmerSize } as React.CSSProperties}
      >
        <div
          className="absolute inset-[-100%] animate-[shimmer-sweep_2.5s_ease-in-out_infinite]"
          style={{
            background: `linear-gradient(
              120deg,
              transparent 25%,
              ${shimmerColor} 50%,
              transparent 75%
            )`,
          }}
        />
      </div>
      {/* Content */}
      <span className="relative z-10 flex items-center gap-2">{children}</span>
    </button>
  );
}
