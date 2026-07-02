import { describe, it, expect } from 'vitest';
import {
  advanceReveal,
  clampRevealToCommonPrefix,
  commonPrefixLength,
  revealedSlice,
  TYPEWRITER_CHARS_PER_TICK,
} from './typewriter';

/**
 * R-D — typewriter reveal for live partial captions.
 *
 * Speechmatics partials carry the CUMULATIVE full text of the in-progress utterance
 * (each frame is more complete, not an incremental delta). The reveal logic keeps a
 * per-partial "revealed character count" that grows tick-by-tick toward the latest
 * target text, so characters appear to be typed one-by-one at the tail. These tests
 * pin the monotonic, catch-up, and clamp behaviour, plus the reduced-motion shortcut.
 */

describe('advanceReveal (R-D)', () => {
  it('advances by charsPerTick toward a longer target, never overshooting it', () => {
    // Reveal 0 → 2 chars into a 5-char target with a 2-char step.
    expect(advanceReveal({ prev: 0, targetLen: 5, charsPerTick: 2, reduced: false })).toBe(2);
    expect(advanceReveal({ prev: 2, targetLen: 5, charsPerTick: 2, reduced: false })).toBe(4);
    // The final step clamps to the target length rather than overshooting to 6.
    expect(advanceReveal({ prev: 4, targetLen: 5, charsPerTick: 2, reduced: false })).toBe(5);
  });

  it('stays put once the whole target is revealed (idempotent at the tail)', () => {
    expect(advanceReveal({ prev: 5, targetLen: 5, charsPerTick: 2, reduced: false })).toBe(5);
  });

  it('is monotonic within a target: never returns fewer chars than already revealed', () => {
    // Even with a big step, prev already at 4 of 5 only moves forward.
    const next = advanceReveal({ prev: 4, targetLen: 5, charsPerTick: 10, reduced: false });
    expect(next).toBeGreaterThanOrEqual(4);
    expect(next).toBe(5);
  });

  it('clamps down to the target length when a new (shorter) target arrives — never over-reveals', () => {
    // Speechmatics may correct a partial to shorter text. We must not render characters
    // past the end of the current target, so reveal is clamped to targetLen even though
    // the raw counter was higher. This is the ONLY case where the returned value < prev.
    expect(advanceReveal({ prev: 8, targetLen: 3, charsPerTick: 2, reduced: false })).toBe(3);
  });

  it('reveals the full target instantly when reduced-motion is set', () => {
    expect(advanceReveal({ prev: 0, targetLen: 42, charsPerTick: 2, reduced: true })).toBe(42);
  });

  it('never returns a negative or NaN count for an empty target', () => {
    expect(advanceReveal({ prev: 0, targetLen: 0, charsPerTick: 2, reduced: false })).toBe(0);
    expect(advanceReveal({ prev: 5, targetLen: 0, charsPerTick: 2, reduced: false })).toBe(0);
  });

  it('exposes a sane default per-tick step (fast enough to keep up, still per-character)', () => {
    expect(TYPEWRITER_CHARS_PER_TICK).toBeGreaterThanOrEqual(1);
    expect(TYPEWRITER_CHARS_PER_TICK).toBeLessThanOrEqual(4);
  });
});

describe('revealedSlice (R-D)', () => {
  it('returns the leading N characters of the target', () => {
    expect(revealedSlice('hello world', 5)).toBe('hello');
    expect(revealedSlice('hello world', 0)).toBe('');
    expect(revealedSlice('hello', 99)).toBe('hello');
  });

  it('counts CJK characters one-by-one (code points, tail reveal per character)', () => {
    // Chinese should reveal a character at a time; slicing by count must land on
    // whole characters, not split surrogate/byte boundaries.
    expect(revealedSlice('你好世界', 2)).toBe('你好');
    expect(revealedSlice('你好世界', 4)).toBe('你好世界');
  });

  it('handles astral code points (emoji) without splitting them', () => {
    // A single emoji is one visual character; revealing 1 unit yields the whole emoji.
    expect(revealedSlice('👍ok', 1)).toBe('👍');
    expect(revealedSlice('👍ok', 2)).toBe('👍o');
  });
});

describe('commonPrefixLength (R-D rewrite guard)', () => {
  it('returns the full length for identical strings', () => {
    expect(commonPrefixLength('hello', 'hello')).toBe(5);
  });

  it('returns the shorter length for a pure append', () => {
    expect(commonPrefixLength('Imperial', 'Imperial College')).toBe(8);
  });

  it('stops at the first diverging character', () => {
    // "Imperial Killedge" → "Imperial College London": shared head is "Imperial " (9 chars).
    expect(commonPrefixLength('Imperial Killedge', 'Imperial College London')).toBe(9);
  });

  it('counts code points so CJK / emoji never split the prefix mid-surrogate', () => {
    expect(commonPrefixLength('你好世界', '你好朋友')).toBe(2);
    expect(commonPrefixLength('👍ok', '👍no')).toBe(1);
  });
});

describe('clampRevealToCommonPrefix (R-D rewrite guard)', () => {
  it('leaves the reveal untouched for a pure append (the common case)', () => {
    expect(clampRevealToCommonPrefix('Imperial', 'Imperial College', 6)).toBe(6);
    expect(clampRevealToCommonPrefix('same text', 'same text', 4)).toBe(4);
  });

  it('clamps the reveal back to the common prefix when the head is rewritten', () => {
    // 15 chars were shown, but the texts diverge at code point 9 — retype the tail only.
    expect(clampRevealToCommonPrefix('Imperial Killedge', 'Imperial College London', 15)).toBe(9);
    // A shorter corrected text clamps the same way (divergence at its end).
    expect(clampRevealToCommonPrefix('abcdef', 'abc', 6)).toBe(3);
  });

  it('never raises the reveal: a rewrite beyond the revealed point is a no-op', () => {
    // Only 4 chars were shown; the divergence at code point 9 has not been revealed yet.
    expect(clampRevealToCommonPrefix('Imperial Killedge', 'Imperial College London', 4)).toBe(4);
  });
});
