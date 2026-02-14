/**
 * NumberTicker — Magic UI inspired animated number counter.
 * Smoothly animates from 0 to the target value using spring physics.
 */
import { useEffect, useRef } from 'react';
import { useInView, useMotionValue, useSpring } from 'motion/react';
import { cn } from '../../lib/utils';

type NumberTickerProps = {
  value: number;
  direction?: 'up' | 'down';
  delay?: number;
  format?: (n: number) => string;
  className?: string;
};

export function NumberTicker({
  value,
  direction = 'up',
  delay = 0,
  format,
  className,
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const motionValue = useMotionValue(direction === 'down' ? value : 0);
  const springValue = useSpring(motionValue, {
    damping: 40,
    stiffness: 200,
  });
  const isInView = useInView(ref, { once: true, margin: '0px' });

  useEffect(() => {
    if (isInView) {
      const timeout = setTimeout(() => {
        motionValue.set(direction === 'down' ? 0 : value);
      }, delay * 1000);
      return () => clearTimeout(timeout);
    }
  }, [motionValue, isInView, delay, value, direction]);

  useEffect(
    () =>
      springValue.on('change', (latest) => {
        if (ref.current) {
          const rounded = Math.round(latest);
          ref.current.textContent = format ? format(rounded) : String(rounded);
        }
      }),
    [springValue, format],
  );

  return (
    <span
      ref={ref}
      className={cn('tabular-nums', className)}
    >
      {format ? format(0) : '0'}
    </span>
  );
}
