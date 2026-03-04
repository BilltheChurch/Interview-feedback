import { motion, AnimatePresence } from 'motion/react';
import { Check, AlertTriangle, X } from 'lucide-react';
import { StatusDot } from '../ui/StatusDot';
import { ConfidenceBadge } from '../ui/ConfidenceBadge';
import type { Participant, ParticipantStatus } from './types';

/* ─── EnrollmentStatusIndicator ──────────────── */

function EnrollmentStatusIndicator({ status }: { status: ParticipantStatus }) {
  switch (status) {
    case 'pending':
      return <StatusDot status="idle" />;
    case 'capturing':
      return <StatusDot status="reconnecting" />;
    case 'matched':
      return <Check className="w-3 h-3 text-success" />;
    case 'needs_confirm':
      return <AlertTriangle className="w-3 h-3 text-warning" />;
    case 'not_enrolled':
      return <X className="w-3 h-3 text-ink-tertiary" />;
    case 'unknown':
      return <X className="w-3 h-3 text-error" />;
  }
}

/* ─── EnrollmentPanel ────────────────────────── */

export function EnrollmentPanel({
  participants,
  onEnroll,
  onConfirm,
}: {
  participants: Participant[];
  onEnroll: (name: string) => void;
  onConfirm: (name: string) => void;
}) {
  return (
    <>
      {participants.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <EnrollmentStatusIndicator status={p.status} />
          <span className="text-xs text-ink truncate flex-1">{p.name}</span>
          <AnimatePresence mode="wait">
            {p.status === 'capturing' && (
              <motion.span
                key="capturing"
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 8 }}
                className="text-xs text-warning animate-pulse"
              >
                Speaking...
              </motion.span>
            )}
            {p.status === 'matched' && p.confidence != null && (
              <motion.div
                key="matched"
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.8 }}
              >
                <ConfidenceBadge score={p.confidence} />
              </motion.div>
            )}
          </AnimatePresence>
          {p.status === 'needs_confirm' && (
            <button
              onClick={(e) => { e.stopPropagation(); onConfirm(p.name); }}
              className="text-xs text-accent font-medium hover:underline transition-colors duration-150 cursor-pointer"
            >
              Confirm
            </button>
          )}
          {(p.status === 'pending' || p.status === 'not_enrolled') && (
            <button
              onClick={(e) => { e.stopPropagation(); onEnroll(p.name); }}
              className="text-xs text-accent font-medium hover:underline transition-colors duration-150 cursor-pointer"
            >
              {p.status === 'not_enrolled' ? 'Retry' : 'Enroll'}
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/* ─── ParticipationSignals ───────────────────── */

export function ParticipationSignals({ participants }: { participants: Participant[] }) {
  return (
    <>
      {participants.map((p) => (
        <div key={p.name} className="flex flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-ink-secondary truncate overflow-hidden whitespace-nowrap max-w-[100px]" title={p.name}>
              {p.name}
            </span>
            <span className="text-xs text-ink-tertiary tabular-nums shrink-0 ml-1">
              {p.talkTimePct}% / {p.turnCount}t
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${p.talkTimePct}%` }}
            />
          </div>
        </div>
      ))}
    </>
  );
}
