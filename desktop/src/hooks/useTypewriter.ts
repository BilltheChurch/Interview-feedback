import { useEffect, useRef, useState } from 'react';
import {
  advanceReveal,
  clampRevealToCommonPrefix,
  codePointLength,
  revealedSlice,
} from '../lib/typewriter';

/**
 * useTypewriter (R-D) — drive a per-character "typing" reveal for live partial captions.
 *
 * Speechmatics partials are the CUMULATIVE full text of the in-progress utterance (each
 * frame is more complete, not a delta). Feed the latest partial text in; the hook returns
 * the leading substring that should be visible right now, advancing a few code points per
 * animation frame so characters appear to be typed at the tail. As longer partials arrive
 * the target grows and the reveal keeps chasing it; the visible slice only moves forward
 * (a corrected shorter partial clamps down so we never render past the end of the text).
 *
 * prefers-reduced-motion → the full text is shown immediately with no animation, and no
 * animation frames are scheduled. The rAF loop also stops once the tail is caught up, so
 * an idle/steady partial does not spin frames.
 */
export function useTypewriter(text: string): string {
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const targetLen = codePointLength(text);
  const [revealed, setRevealed] = useState<number>(() =>
    prefersReducedMotion ? targetLen : 0,
  );

  // Keep the newest target reachable from inside the rAF loop without re-subscribing.
  const targetLenRef = useRef(targetLen);
  targetLenRef.current = targetLen;

  // Previous partial text, used to detect mid-stream rewrites (prefix divergence).
  const prevTextRef = useRef(text);

  useEffect(() => {
    const prevText = prevTextRef.current;
    prevTextRef.current = text;
    if (prevText !== text) {
      // Rewritten head → clamp the reveal back to the common prefix so only the
      // changed tail is retyped; pure appends leave the reveal untouched.
      setRevealed((prev) => clampRevealToCommonPrefix(prevText, text, prev));
    }

    if (prefersReducedMotion) {
      // No animation: show everything, and re-sync instantly as the text grows.
      setRevealed(targetLen);
      return;
    }

    let rafHandle = 0;
    const tick = () => {
      let done = false;
      setRevealed((prev) => {
        const next = advanceReveal({ prev, targetLen: targetLenRef.current, reduced: false });
        done = next >= targetLenRef.current;
        return next;
      });
      // Stop the loop when the tail is caught up; a new/longer text restarts this effect.
      if (!done) {
        rafHandle = requestAnimationFrame(tick);
      }
    };
    rafHandle = requestAnimationFrame(tick);

    return () => {
      if (rafHandle) cancelAnimationFrame(rafHandle);
    };
    // Re-run whenever the target text changes so the loop chases the newest partial.
  }, [text, targetLen, prefersReducedMotion]);

  return revealedSlice(text, revealed);
}
