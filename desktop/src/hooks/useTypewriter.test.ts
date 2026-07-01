import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTypewriter } from './useTypewriter';

/**
 * R-D — useTypewriter drives the per-character reveal for live partial captions.
 *
 * It takes the latest cumulative partial text and returns the substring that should be
 * visible right now, advancing a few characters per animation frame. New (longer) text
 * raises the target it chases; the visible slice only grows (except a corrected shorter
 * target, which clamps down). reduced-motion shows the whole text immediately.
 */

// Controllable requestAnimationFrame: each flushFrame() runs exactly one queued callback.
let rafCallbacks: Array<{ id: number; cb: FrameRequestCallback }> = [];
let rafId = 0;

function installRafMock() {
  rafCallbacks = [];
  rafId = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafId += 1;
    rafCallbacks.push({ id: rafId, cb });
    return rafId;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafCallbacks = rafCallbacks.filter((entry) => entry.id !== id);
  });
}

/** Run every currently-queued rAF callback once (callbacks queued during the flush run on
 *  the NEXT flush, mirroring a real frame boundary). */
function flushFrame(times = 1) {
  for (let i = 0; i < times; i += 1) {
    const pending = rafCallbacks;
    rafCallbacks = [];
    act(() => {
      for (const entry of pending) entry.cb(performance.now());
    });
  }
}

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

describe('useTypewriter (R-D)', () => {
  beforeEach(() => {
    installRafMock();
    setReducedMotion(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reveals characters progressively over several frames', () => {
    const { result } = renderHook(() => useTypewriter('hello'));
    // Nothing revealed before the first frame runs.
    expect(result.current.length).toBeLessThan('hello'.length);
    // Advance a few frames — the visible slice grows toward the full text.
    flushFrame(1);
    const afterOne = result.current.length;
    flushFrame(1);
    expect(result.current.length).toBeGreaterThanOrEqual(afterOne);
    // Enough frames → fully revealed.
    flushFrame(5);
    expect(result.current).toBe('hello');
  });

  it('is a prefix of the target at every step', () => {
    const { result } = renderHook(() => useTypewriter('the quick brown fox'));
    for (let i = 0; i < 3; i += 1) {
      flushFrame(1);
      expect('the quick brown fox'.startsWith(result.current)).toBe(true);
    }
  });

  it('keeps chasing a longer target without resetting what is already shown', () => {
    const { result, rerender } = renderHook(({ text }) => useTypewriter(text), {
      initialProps: { text: 'hello' },
    });
    flushFrame(5);
    expect(result.current).toBe('hello');
    // A longer cumulative partial arrives — already-shown prefix stays, reveal continues.
    rerender({ text: 'hello world' });
    expect(result.current.startsWith('hello')).toBe(true);
    flushFrame(10);
    expect(result.current).toBe('hello world');
  });

  it('reveals the full text immediately under prefers-reduced-motion (no frames needed)', () => {
    setReducedMotion(true);
    const { result } = renderHook(() => useTypewriter('instant full text'));
    expect(result.current).toBe('instant full text');
  });

  it('reveals CJK one character at a time', () => {
    const { result } = renderHook(() => useTypewriter('你好世界朋友'));
    flushFrame(1);
    // After one frame only a couple of characters are visible, and they are whole chars.
    expect('你好世界朋友'.startsWith(result.current)).toBe(true);
    expect(Array.from(result.current).length).toBeLessThan(6);
    flushFrame(10);
    expect(result.current).toBe('你好世界朋友');
  });

  it('returns an empty string for empty text and does not spin frames forever', () => {
    const { result } = renderHook(() => useTypewriter(''));
    flushFrame(2);
    expect(result.current).toBe('');
  });
});
