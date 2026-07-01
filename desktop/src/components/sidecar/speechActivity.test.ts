import { describe, it, expect } from 'vitest';
import { SPEECH_ACTIVITY_LEVEL_THRESHOLD, isSpeechActive } from './speechActivity';

/**
 * R7 regression: SPEAKER ACTIVITY panel credited silent students because the
 * silence gate (level > 1 on a 0–100 scale) sat below the AnalyserNode noise
 * floor. `readRmsLevel` (AudioService) outputs 0–100 integers; the noise floor
 * of an idle system-audio track lands around 2–3, real speech in the teens+.
 */
describe('isSpeechActive (R7 silence gate)', () => {
  it('exposes a threshold aligned to the 0–100 readRmsLevel scale', () => {
    // Must clear the noise floor (~2–3) with margin, but stay well below real
    // speech (~15+) so quiet talkers are not dropped.
    expect(SPEECH_ACTIVITY_LEVEL_THRESHOLD).toBeGreaterThan(3);
    expect(SPEECH_ACTIVITY_LEVEL_THRESHOLD).toBeLessThan(15);
  });

  it('does NOT count noise-floor levels as active (silent student stays 0)', () => {
    expect(isSpeechActive(0)).toBe(false);
    expect(isSpeechActive(2)).toBe(false); // idle system-audio noise floor
    expect(isSpeechActive(3)).toBe(false); // noise floor upper edge
  });

  it('counts real speech levels as active', () => {
    expect(isSpeechActive(15)).toBe(true); // quiet/normal speech
    expect(isSpeechActive(40)).toBe(true); // clear speech
    expect(isSpeechActive(100)).toBe(true); // loud speech
  });

  it('has an unambiguous boundary at the threshold', () => {
    // Strictly-greater comparison: exactly at the threshold is NOT active.
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD + 1)).toBe(true);
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD - 1)).toBe(false);
  });
});
