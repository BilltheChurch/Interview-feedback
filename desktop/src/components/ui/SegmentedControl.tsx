import { type ReactNode, useRef } from 'react';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';

gsap.registerPlugin(useGSAP);

/**
 * SegmentedControl — glass segmented toggle (e.g. 1 v 1 / Group).
 *
 * The active segment is a tangerine pill that physically slides between options. The slide
 * is driven by GSAP with a `back.out(1.7)` ease, so it buffers, accelerates, overshoots the
 * target slightly, then settles. Position/width are read live from the target button
 * (offsetLeft / offsetWidth) so it stays correct at any width. First paint and
 * prefers-reduced-motion both place the pill instantly (duration 0). useGSAP scopes the
 * animation to this component and reverts on unmount.
 */
type Option<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: {
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const firstRun = useRef(true);
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));

  useGSAP(
    () => {
      const pill = pillRef.current;
      const btn = btnRefs.current[activeIdx];
      if (!pill || !btn) return;
      const reduce =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      gsap.to(pill, {
        x: btn.offsetLeft,
        width: btn.offsetWidth,
        duration: firstRun.current || reduce ? 0 : 0.55,
        ease: 'back.out(1.7)',
      });
      firstRun.current = false;
    },
    { dependencies: [activeIdx], scope: rootRef },
  );

  return (
    <div
      ref={rootRef}
      role="group"
      className={`relative flex gap-1 p-1 rounded-xl bg-[rgba(20,22,40,0.05)] shadow-[inset_0_1px_2px_rgba(20,22,40,0.06)] ${className}`}
    >
      <span
        ref={pillRef}
        aria-hidden="true"
        className="absolute top-1 bottom-1 left-0 w-0 rounded-[9px] bg-accent shadow-[0_4px_14px_-4px_rgba(255,122,26,0.5)]"
      />
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`relative z-10 flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-[9px] transition-colors duration-200 cursor-pointer ${
              active ? 'text-on-accent' : 'text-ink-secondary hover:text-ink'
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
