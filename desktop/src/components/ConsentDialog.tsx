import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';

// localStorage key for consent state
export const RECORDING_CONSENT_KEY = 'chorus_consent_acknowledged';

// Consent is stored as JSON: { acknowledged: true, expiresAt: number, permanent: boolean }
type ConsentRecord = {
  acknowledged: boolean;
  expiresAt: number;   // unix ms — 0 means permanent
  permanent: boolean;
};

/** Returns true if the user has a valid (non-expired) consent on record. */
export function hasValidConsent(): boolean {
  try {
    const raw = localStorage.getItem(RECORDING_CONSENT_KEY);
    if (!raw) return false;
    const record: ConsentRecord = JSON.parse(raw);
    if (!record.acknowledged) return false;
    if (record.permanent) return true;
    return record.expiresAt > Date.now();
  } catch {
    return false;
  }
}

/** Persists consent. If permanent=true it never re-prompts; otherwise expires at end of day. */
export function saveConsent(permanent: boolean): void {
  const now = new Date();
  // Expire at midnight tonight (same-day session = no re-prompt)
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
  const record: ConsentRecord = {
    acknowledged: true,
    expiresAt: permanent ? 0 : midnight,
    permanent,
  };
  localStorage.setItem(RECORDING_CONSENT_KEY, JSON.stringify(record));
}

/* ─── ConsentDialog ─────────────────────────── */

type ConsentDialogProps = {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
};

export function ConsentDialog({ open, onAccept, onCancel }: ConsentDialogProps) {
  const [checked, setChecked] = useState(false);
  const [dontAskAgain, setDontAskAgain] = useState(false);

  const handleAccept = () => {
    if (!checked) return;
    saveConsent(dontAskAgain);
    onAccept();
  };

  const handleCancel = () => {
    setChecked(false);
    setDontAskAgain(false);
    onCancel();
  };

  return (
    <Modal open={open} onClose={handleCancel} size="sm">
      <div className="space-y-4">
        {/* Icon + heading */}
        <div className="flex items-start gap-3">
          <div className="shrink-0 w-9 h-9 rounded-full bg-accent-soft flex items-center justify-center">
            <ShieldCheck className="w-5 h-5 text-accent" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-ink leading-snug">Recording Consent</h2>
            <p className="text-xs text-ink-secondary mt-0.5">Required before recording begins</p>
          </div>
        </div>

        {/* Body */}
        <p className="text-sm text-ink-secondary leading-relaxed">
          This session will record audio for analysis. All participants should be informed
          and consent to recording.
        </p>

        <ul className="text-sm text-ink-secondary space-y-1 list-disc pl-5">
          <li>Audio is processed in real-time for transcription and feedback</li>
          <li>Recordings are stored temporarily and deleted after 30 days</li>
          <li>You can delete session data at any time from History</li>
        </ul>

        {/* Primary checkbox — required to proceed */}
        <label className="flex items-start gap-3 cursor-pointer select-none group">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="
              mt-0.5 w-4 h-4 shrink-0
              accent-[var(--color-accent)]
              cursor-pointer
            "
          />
          <span className="text-sm text-ink leading-snug group-hover:text-ink-secondary transition-colors">
            I confirm all participants have been informed and consent to this recording
          </span>
        </label>

        {/* Secondary checkbox — "Don't ask again today" */}
        <label className="flex items-center gap-3 cursor-pointer select-none group">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(e) => setDontAskAgain(e.target.checked)}
            className="
              w-4 h-4 shrink-0
              accent-[var(--color-accent)]
              cursor-pointer
            "
          />
          <span className="text-xs text-ink-secondary group-hover:text-ink transition-colors">
            Don't ask again on this device
          </span>
        </label>

        {/* Actions */}
        <div className="flex gap-3 pt-1 border-t border-border">
          <Button variant="ghost" onClick={handleCancel} className="flex-1">
            Cancel
          </Button>
          <Button
            onClick={handleAccept}
            disabled={!checked}
            className="flex-1"
          >
            Start Recording
          </Button>
        </div>
      </div>
    </Modal>
  );
}
