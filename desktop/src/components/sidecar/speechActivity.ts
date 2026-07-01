/**
 * Speech-activity silence gate for the audio-activity indicator (the pulsing
 * header border in the Sidecar). It is the only remaining consumer; talk-time /
 * speaker-activity is now computed from transcript segments, not audio level.
 *
 * The audio levels compared here come from `readRmsLevel` in
 * `src/services/AudioService.ts`, which returns **0–100 integers** via
 * `rmsToLevel` (`Math.min(100, Math.round(rms * 500))`). The values below MUST
 * be read on that same 0–100 scale.
 *
 * R7 background: an idle system-audio track has an AnalyserNode noise floor of
 * rms ≈ 0.0075 (→ level ≈ 4 on the current scale). Gating below that let
 * ambient noise intermittently read as "active".
 *
 * Threshold rationale (current `rms * 500` scale):
 *   - Idle noise floor lands around level 4–7.
 *   - Real speech (even quiet talkers) lands around level 25 and above.
 *   - 20 leaves margin above the noise floor while staying comfortably below
 *     normal/soft speech, so genuine (including quiet) speech still counts.
 *
 * (These gates were originally tuned to the older `rms * 200` scale with values
 * 8 / 4; they were scaled by 2.5× alongside the meter mapping change so the
 * effective dBFS behavior is unchanged.)
 */
export const SPEECH_ACTIVITY_LEVEL_THRESHOLD = 20;

/**
 * System (loopback) stream gate. The system-audio noise floor lands around
 * level 4–7 on the current scale, so 20 leaves margin to keep a silent loopback
 * inactive while still crediting real speakers (level 25+).
 */
export const SYSTEM_ACTIVITY_LEVEL_THRESHOLD = SPEECH_ACTIVITY_LEVEL_THRESHOLD;

/**
 * Microphone stream gate — lower than the system gate.
 *
 * R-C background: the mic runs `noiseSuppression:true` + `autoGainControl:false`
 * (see AudioService.initMic). Noise suppression trims the interviewer's own soft
 * passages and speech gaps, so the mic RMS frequently dips below the system
 * gate even while they are actively talking. The mic noise floor sits around
 * level ~5 on the current scale, so 10 clears it with margin while still
 * crediting soft/gapped interviewer speech.
 */
export const MIC_ACTIVITY_LEVEL_THRESHOLD = 10;

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
