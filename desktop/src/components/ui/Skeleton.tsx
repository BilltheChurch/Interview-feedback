import type { HTMLAttributes } from 'react';

type Variant = 'text' | 'card' | 'circle';

const variantClasses: Record<Variant, string> = {
  text: 'h-4 w-full rounded',
  card: 'h-32 w-full rounded-[--radius-card]',
  circle: 'h-10 w-10 rounded-full',
};

type SkeletonProps = {
  variant?: Variant;
} & HTMLAttributes<HTMLDivElement>;

export function Skeleton({ variant = 'text', className = '', ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`animate-pulse bg-surface-hover ${variantClasses[variant]} ${className}`}
      {...props}
    />
  );
}
