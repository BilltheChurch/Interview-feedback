import { describe, it, expect } from 'vitest';
import {
  SPEECH_ACTIVITY_LEVEL_THRESHOLD,
  MIC_ACTIVITY_LEVEL_THRESHOLD,
  SYSTEM_ACTIVITY_LEVEL_THRESHOLD,
  isSpeechActive,
} from './speechActivity';

/**
 * R7 regression: the audio-activity indicator lit up on silence because the
 * silence gate sat below the AnalyserNode noise floor. `readRmsLevel`
 * (AudioService) outputs 0–100 integers via `rmsToLevel` (`rms * 500`); on this
 * scale the noise floor of an idle system-audio track lands around 4–7, real
 * speech around 25+.
 */
describe('isSpeechActive (R7 silence gate)', () => {
  it('exposes a threshold aligned to the 0–100 readRmsLevel scale', () => {
    // Must clear the noise floor (~4–7) with margin, but stay well below real
    // speech (~25+) so quiet talkers are not dropped.
    expect(SPEECH_ACTIVITY_LEVEL_THRESHOLD).toBeGreaterThan(7);
    expect(SPEECH_ACTIVITY_LEVEL_THRESHOLD).toBeLessThan(25);
  });

  it('does NOT count noise-floor levels as active (silent stream stays inactive)', () => {
    expect(isSpeechActive(0)).toBe(false);
    expect(isSpeechActive(5)).toBe(false); // idle system-audio noise floor
    expect(isSpeechActive(7)).toBe(false); // noise floor upper edge
  });

  it('counts real speech levels as active', () => {
    expect(isSpeechActive(30)).toBe(true); // quiet/normal speech
    expect(isSpeechActive(60)).toBe(true); // clear speech
    expect(isSpeechActive(100)).toBe(true); // loud speech
  });

  it('has an unambiguous boundary at the threshold', () => {
    // Strictly-greater comparison: exactly at the threshold is NOT active.
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD + 1)).toBe(true);
    expect(isSpeechActive(SPEECH_ACTIVITY_LEVEL_THRESHOLD - 1)).toBe(false);
  });
});

/**
 * R-C regression: the interviewer (mic) indicator stayed dark while the system
 * stream was active. The mic runs `noiseSuppression:true` +
 * `autoGainControl:false`, so speech gaps and softer voices routinely drop the
 * mic level below the system gate. The system/loopback stream is level and
 * easily clears it. Fix: separate thresholds — a lower one for the
 * noise-suppressed mic, a higher one for the system stream (still guarding its
 * noise floor). Both scaled by 2.5× when the meter mapping moved to `rms * 500`.
 */
describe('isSpeechActive (R-C split mic/system thresholds)', () => {
  it('uses a lower threshold for the mic than for the system stream', () => {
    expect(MIC_ACTIVITY_LEVEL_THRESHOLD).toBeLessThan(SYSTEM_ACTIVITY_LEVEL_THRESHOLD);
    // The mic threshold must stay above the mic noise floor (~5) but low enough
    // to credit soft/gapped interviewer speech that dips under the system gate.
    expect(MIC_ACTIVITY_LEVEL_THRESHOLD).toBeGreaterThan(5);
    expect(MIC_ACTIVITY_LEVEL_THRESHOLD).toBeLessThan(SPEECH_ACTIVITY_LEVEL_THRESHOLD);
    // The system threshold keeps the R7 protection against a silent loopback.
    expect(SYSTEM_ACTIVITY_LEVEL_THRESHOLD).toBe(SPEECH_ACTIVITY_LEVEL_THRESHOLD);
  });

  it('credits soft/gapped mic speech that the system gate would drop', () => {
    // Level 15: below the system gate (20), but real interviewer speech under
    // noise suppression. With the mic threshold it counts; with system it would not.
    expect(isSpeechActive(15, MIC_ACTIVITY_LEVEL_THRESHOLD)).toBe(true);
    expect(isSpeechActive(15, SYSTEM_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
  });

  it('still rejects mic noise floor under the mic threshold', () => {
    expect(isSpeechActive(5, MIC_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
  });

  it('keeps R7 protection on the system stream (silent loopback stays inactive)', () => {
    expect(isSpeechActive(5, SYSTEM_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
    expect(isSpeechActive(7, SYSTEM_ACTIVITY_LEVEL_THRESHOLD)).toBe(false);
    expect(isSpeechActive(30, SYSTEM_ACTIVITY_LEVEL_THRESHOLD)).toBe(true); // real speaker
  });

  it('defaults to the shared (system) threshold when none is passed', () => {
    // Back-compat: the single-arg form behaves as before (system-grade gate).
    expect(isSpeechActive(15)).toBe(false);
    expect(isSpeechActive(21)).toBe(true);
  });
});
