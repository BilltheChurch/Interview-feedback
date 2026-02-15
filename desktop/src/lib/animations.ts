/**
 * Shared motion variants for consistent animations across the app.
 * Uses motion/react (Framer Motion) format.
 */

/* ── Page-level transitions ──────────────────── */

export const pageTransition = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
};

/* ── Card entrance ───────────────────────────── */

export const cardEnter = {
  initial: { opacity: 0, scale: 0.98 },
  animate: { opacity: 1, scale: 1 },
  transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] as const },
};

/* ── Slide in from right ─────────────────────── */

export const slideIn = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  transition: { duration: 0.2, ease: [0.22, 1, 0.36, 1] as const },
};

/* ── Staggered list items ────────────────────── */

export const staggerContainer = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

export const staggerItem = {
  hidden: { opacity: 0, y: 12 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.35, ease: [0.22, 1, 0.36, 1] as const },
  },
};

/* ── Card hover (consistent across all hoverable cards) ── */

export const cardHover = {
  whileHover: { y: -2, transition: { duration: 0.15 } },
  whileTap: { scale: 0.98 },
};

/* ── Wizard step slide ───────────────────────── */

export const stepSlideLeft = {
  initial: { opacity: 0, x: 40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -40 },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const },
};

export const stepSlideRight = {
  initial: { opacity: 0, x: -40 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 40 },
  transition: { duration: 0.3, ease: [0.22, 1, 0.36, 1] as const },
};

/* ── Expand/collapse ─────────────────────────── */

export const expandCollapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto' as const, opacity: 1 },
  exit: { height: 0, opacity: 0 },
  transition: { duration: 0.25 },
};

/* ── Fade in up (for sequential sections) ────── */

export const fadeInUp = {
  hidden: { opacity: 0, y: 16 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      delay: i * 0.08,
      duration: 0.35,
      ease: [0.22, 1, 0.36, 1] as const,
    },
  }),
};
