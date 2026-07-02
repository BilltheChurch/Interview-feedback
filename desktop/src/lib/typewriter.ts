/**
 * typewriter.ts — pure reveal logic for the live "typing" partial captions (R-D).
 *
 * Speechmatics partials carry the CUMULATIVE full text of the in-progress utterance:
 * every frame is a more-complete version of the same sentence, not an incremental delta.
 * To get a per-character "typing" feel we keep a REVEALED-CHARACTER COUNT that grows a
 * few characters per animation tick toward the latest target text, and render only the
 * leading `count` characters. New (longer) partials simply raise the target the count
 * chases; the count itself only ever moves forward within a target. The single exception
 * is a shorter corrected target, where the count is clamped down to the target length so
 * we never render characters past the end of the current text.
 *
 * The count is measured in Unicode code points (Array.from), so CJK characters reveal one
 * at a time and astral code points (emoji) are never split mid-surrogate.
 */

/** Characters revealed per animation tick. At ~60fps (rAF), 2 chars/tick ≈ 120 chars/s —
 *  fast enough to keep up with fast speech while still reading as per-character typing. */
export const TYPEWRITER_CHARS_PER_TICK = 2;

/**
 * Advance the revealed-character count one tick toward `targetLen`.
 *
 * - reduced-motion → jump straight to the full target length (no typing animation).
 * - otherwise → move forward by `charsPerTick`, clamped to `[0, targetLen]`.
 * - monotonic within a target: the result is >= prev UNLESS the target shrank below prev
 *   (a corrected, shorter partial), in which case it clamps down to `targetLen` so the
 *   rendered slice never runs past the end of the current text.
 */
export function advanceReveal(opts: {
  prev: number;
  targetLen: number;
  charsPerTick?: number;
  reduced: boolean;
}): number {
  const { prev, targetLen, reduced } = opts;
  const step = opts.charsPerTick ?? TYPEWRITER_CHARS_PER_TICK;
  const safeTarget = Math.max(0, Math.floor(targetLen));
  if (reduced) return safeTarget;
  const safePrev = Math.max(0, Math.floor(prev));
  // Clamp down when the target shrank (corrected shorter partial), otherwise step forward.
  const next = safePrev >= safeTarget ? safeTarget : Math.min(safeTarget, safePrev + step);
  return next;
}

/**
 * Return the leading `count` code points of `text`.
 * Uses Array.from so CJK / emoji count as one unit each and are never split.
 */
export function revealedSlice(text: string, count: number): string {
  if (count <= 0) return '';
  const chars = Array.from(text);
  if (count >= chars.length) return text;
  return chars.slice(0, count).join('');
}

/** Code-point length of a string (CJK / emoji counted as one unit each). */
export function codePointLength(text: string): number {
  return Array.from(text).length;
}

/**
 * Code-point length of the longest common prefix of `a` and `b`.
 * Compares whole code points (Array.from) so CJK / emoji are never split mid-surrogate.
 */
export function commonPrefixLength(a: string, b: string): number {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const max = Math.min(ca.length, cb.length);
  let i = 0;
  while (i < max && ca[i] === cb[i]) i += 1;
  return i;
}

/**
 * Clamp the revealed count when a new partial REWRITES text that was already shown.
 *
 * Speechmatics may correct the head of an in-progress utterance mid-stream
 * ("Imperial Killedge" → "Imperial College London"). A pure append keeps the reveal
 * untouched, but a prefix divergence clamps the reveal back to the common prefix so
 * only the changed tail is retyped — characters the user already read are never
 * replaced in place.
 */
export function clampRevealToCommonPrefix(
  prevText: string,
  text: string,
  revealed: number,
): number {
  if (prevText === text) return revealed;
  const prefix = commonPrefixLength(prevText, text);
  // Pure append: everything previously shown is unchanged — keep the reveal as is.
  if (prefix === codePointLength(prevText)) return revealed;
  // Head diverged (or text shrank): anything revealed past the common prefix is stale.
  return Math.min(revealed, prefix);
}
