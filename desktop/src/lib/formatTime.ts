/** Format a session-relative offset in milliseconds as `mm:ss`.
 *
 *  Shared by the live caption panel (CaptionPanel) and the post-session
 *  transcript view (TranscriptSection) so both surface each utterance's
 *  start time in the same format. Clamps negatives to 0. */
export function formatSessionTime(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
