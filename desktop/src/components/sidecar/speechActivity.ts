/**
 * Speech-activity silence gate for the SPEAKER ACTIVITY panel.
 *
 * The audio levels compared here come from `readRmsLevel` in
 * `src/services/AudioService.ts`, which returns **0–100 integers**
 * (`Math.min(100, Math.round(rms * 200))`). The value below MUST be read on
 * that same 0–100 scale.
 *
 * R7 background: the old gate used a literal `1` (≈ −42 dBFS on this scale),
 * which sits *below* the AnalyserNode noise floor of an idle system-audio track
 * (rms ≈ 0.0075 → level ≈ 2). That let ambient noise intermittently satisfy the
 * gate, so silent students' talk-time percentages crept upward with nobody
 * speaking.
 *
 * Threshold rationale:
 *   - Idle noise floor lands around level 2–3.
 *   - Real speech (even quiet talkers) lands in the teens and above.
 *   - 8 leaves margin above the noise floor while staying comfortably below
 *     normal/soft speech, so genuine (including quiet) speech is still credited.
 */
export const SPEECH_ACTIVITY_LEVEL_THRESHOLD = 8;

/**
 * Whether a single audio-level sample (0–100 scale from `readRmsLevel`) should
 * count as active speech for talk-time accumulation.
 *
 * Uses strict-greater comparison, so a sample exactly at the threshold is not
 * counted (unambiguous boundary).
 */
export function isSpeechActive(level: number): boolean {
  return level > SPEECH_ACTIVITY_LEVEL_THRESHOLD;
}
