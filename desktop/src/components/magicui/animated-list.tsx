/**
 * AnimatedList — Magic UI inspired list with entrance animations.
 * Each item animates in with stagger, slide, and opacity transitions.
 */
import { type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../../lib/utils';

type AnimatedListProps = {
  children: ReactNode[];
  className?: string;
  delay?: number;
};

export function AnimatedList({
  children,
  className,
  delay = 0.08,
}: AnimatedListProps) {
  return (
    <div className={cn('flex flex-col', className)}>
      <AnimatePresence initial={false}>
        {children.map((child, i) => (
          <AnimatedListItem key={i} delay={i * delay}>
            {child}
          </AnimatedListItem>
        ))}
      </AnimatePresence>
    </div>
  );
}

function AnimatedListItem({
  children,
  delay,
}: {
  children: ReactNode;
  delay: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.97 }}
      transition={{
        duration: 0.3,
        delay,
        ease: [0.22, 1, 0.36, 1],
      }}
      layout
    >
      {children}
    </motion.div>
  );
}
