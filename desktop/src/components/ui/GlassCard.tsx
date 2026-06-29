import { type ReactNode, type HTMLAttributes } from 'react';

/**
 * GlassCard — translucent liquid-glass panel.
 *
 * Multi-layer material lives in the `.glass` utility (backdrop blur + saturate, layered
 * translucent fill, inner top/bottom highlights, plus a `::before` specular sheen).
 * Intentionally inert: no cursor spotlight, no per-card motion. Entrance/stagger is the
 * parent's job (wrap in a motion element with `staggerItem`).
 */
export function GlassCard({
  className = '',
  children,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`glass rounded-[--radius-card] ${className}`} {...rest}>
      {children}
    </div>
  );
}
