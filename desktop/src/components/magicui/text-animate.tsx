/**
 * TextAnimate — Magic UI inspired text entrance animation.
 * Animates text word-by-word or character-by-character with stagger.
 */
import { motion, type Variants } from 'motion/react';
import { cn } from '../../lib/utils';

type AnimationType = 'fadeIn' | 'blurIn' | 'slideUp' | 'scaleUp';
type ByType = 'word' | 'character';

type TextAnimateProps = {
  children: string;
  animation?: AnimationType;
  by?: ByType;
  delay?: number;
  duration?: number;
  staggerDelay?: number;
  className?: string;
};

const animationVariants: Record<AnimationType, Variants> = {
  fadeIn: {
    hidden: { opacity: 0 },
    visible: { opacity: 1 },
  },
  blurIn: {
    hidden: { opacity: 0, filter: 'blur(8px)' },
    visible: { opacity: 1, filter: 'blur(0px)' },
  },
  slideUp: {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, y: 0 },
  },
  scaleUp: {
    hidden: { opacity: 0, scale: 0.85 },
    visible: { opacity: 1, scale: 1 },
  },
};

export function TextAnimate({
  children,
  animation = 'blurIn',
  by = 'word',
  delay = 0,
  duration = 0.35,
  staggerDelay = 0.06,
  className,
}: TextAnimateProps) {
  const segments = by === 'word' ? children.split(' ') : children.split('');
  const separator = by === 'word' ? '\u00A0' : '';

  const container: Variants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: staggerDelay,
        delayChildren: delay,
      },
    },
  };

  const child: Variants = {
    hidden: animationVariants[animation].hidden,
    visible: {
      ...animationVariants[animation].visible,
      transition: { duration, ease: [0.22, 1, 0.36, 1] },
    },
  };

  return (
    <motion.div
      className={cn('inline-block', className)}
      variants={container}
      initial="hidden"
      animate="visible"
    >
      {segments.map((segment, i) => (
        <motion.span
          key={`${segment}-${i}`}
          variants={child}
          style={{ display: 'inline-block' }}
        >
          {segment}
          {i < segments.length - 1 ? separator : ''}
        </motion.span>
      ))}
    </motion.div>
  );
}
