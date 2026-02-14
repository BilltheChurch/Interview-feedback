import type { ReactNode } from 'react';

type TooltipProps = {
  content: string;
  children: ReactNode;
  position?: 'top' | 'bottom';
};

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <div className="group relative inline-flex" title={content}>
      {children}
    </div>
  );
}
