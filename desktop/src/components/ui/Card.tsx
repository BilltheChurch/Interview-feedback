import type { HTMLAttributes, ReactNode } from 'react';

type CardProps = {
  hoverable?: boolean;
  glass?: boolean;
  children: ReactNode;
} & HTMLAttributes<HTMLDivElement>;

export function Card({ hoverable, glass, className = '', children, ...props }: CardProps) {
  const base = glass
    ? 'glass rounded-[--radius-card]'
    : 'bg-surface rounded-[--radius-card] border border-border shadow-card';

  return (
    <div
      className={`
        ${base}
        ${hoverable ? 'hover:shadow-card-hover hover:-translate-y-0.5 transition-all duration-200 cursor-pointer' : ''}
        ${className}
      `}
      {...props}
    >
      {children}
    </div>
  );
}
