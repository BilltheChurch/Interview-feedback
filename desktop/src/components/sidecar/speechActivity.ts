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
 * System (loopback) stream gate. Kept at the R7 value: the system-audio noise
 * floor is level and lands around 2–3, so 8 leaves margin to keep a silent
 * loopback (idle students) at 0% while still crediting real speakers (teens+).
 */
export const SYSTEM_ACTIVITY_LEVEL_THRESHOLD = SPEECH_ACTIVITY_LEVEL_THRESHOLD;

/**
 * Microphone stream gate — lower than the system gate.
 *
 * R-C background: the mic runs `noiseSuppression:true` + `autoGainControl:false`
 * (see AudioService.initMic). Noise suppression trims the interviewer's own soft
 * passages and speech gaps, so the mic RMS frequently dips below the system
 * gate of 8 even while they are actively talking — starving the interviewer's
 * talk-time (0%) and handing 100% to the students. The mic noise floor sits
 * around ~2, so 4 clears it with margin while still crediting soft/gapped
 * interviewer speech (level ≥ 5). NOT lowered to 1 (that would re-admit the mic
 * noise floor).
 */
export const MIC_ACTIVITY_LEVEL_THRESHOLD = 4;

/**
 * Whether a single audio-level sample (0–100 scale from `readRmsLevel`) should
 * count as active speech for talk-time accumulation.
 *
 * `threshold` selects the per-stream gate — pass `MIC_ACTIVITY_LEVEL_THRESHOLD`
 * for the microphone and `SYSTEM_ACTIVITY_LEVEL_THRESHOLD` for the loopback
 * stream. Defaults to the system-grade gate for back-compat.
 *
 * Uses strict-greater comparison, so a sample exactly at the threshold is not
 * counted (unambiguous boundary).
 */
export function isSpeechActive(
  level: number,
  threshold: number = SYSTEM_ACTIVITY_LEVEL_THRESHOLD,
): boolean {
  return level > threshold;
}
