import { motion, AnimatePresence } from 'motion/react';
import { X, Radio, AudioLines, Check } from 'lucide-react';
import { StatusDot } from '../ui/StatusDot';
import type { AcsStatus } from '../../stores/sessionStore';
import { formatTime, type IncrementalBadgeStatus } from './types';

/* ─── ACS Status Badge ─────────────────────── */

const acsStatusConfig: Record<AcsStatus, { label: string; color: string; dotColor: string; animate?: boolean }> = {
  off: { label: '', color: '', dotColor: '' },
  connecting: { label: 'Teams', color: 'text-amber-600 bg-amber-50', dotColor: 'bg-amber-400', animate: true },
  connected: { label: 'Teams', color: 'text-blue-600 bg-blue-50', dotColor: 'bg-blue-400' },
  receiving: { label: 'Teams', color: 'text-emerald-600 bg-emerald-50', dotColor: 'bg-emerald-400', animate: true },
  error: { label: 'Teams', color: 'text-red-600 bg-red-50', dotColor: 'bg-red-400' },
};

export function AcsStatusBadge({ status, captionCount }: { status: AcsStatus; captionCount: number }) {
  if (status === 'off') return null;

  const cfg = acsStatusConfig[status];

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.color} select-none`}
      title={
        status === 'connecting' ? 'Connecting to Teams meeting...'
        : status === 'connected' ? 'Connected — waiting for captions'
        : status === 'receiving' ? `Receiving captions (${captionCount})`
        : 'ACS connection error'
      }
    >
      <span className="relative flex h-2 w-2">
        {cfg.animate && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${cfg.dotColor}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${cfg.dotColor}`} />
      </span>
      <Radio className="w-3 h-3" />
      <span>{cfg.label}</span>
      {status === 'receiving' && (
        <span className="tabular-nums opacity-75">{captionCount}</span>
      )}
      {status === 'error' && (
        <X className="w-3 h-3" />
      )}
    </motion.div>
  );
}

/* ─── Incremental Processing Badge ─────────── */

export function IncrementalStatusBadge({
  status,
  speakersDetected,
  incrementsCompleted,
  stableSpeakerMap,
}: {
  status: IncrementalBadgeStatus;
  speakersDetected: number;
  incrementsCompleted: number;
  stableSpeakerMap: boolean;
}) {
  if (status === 'idle') return null;

  const isProcessing = status === 'processing';
  const color = status === 'failed' ? 'text-red-600 bg-red-50'
    : stableSpeakerMap ? 'text-emerald-600 bg-emerald-50'
    : 'text-blue-600 bg-blue-50';
  const dotColor = status === 'failed' ? 'bg-red-400'
    : stableSpeakerMap ? 'bg-emerald-400'
    : 'bg-blue-400';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      className={`flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${color} select-none`}
      title={
        isProcessing ? `Processing increment ${incrementsCompleted + 1}...`
        : stableSpeakerMap ? `${speakersDetected} speakers identified (stable)`
        : `${speakersDetected} speakers detected`
      }
    >
      <span className="relative flex h-2 w-2">
        {isProcessing && (
          <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotColor}`} />
        )}
        <span className={`relative inline-flex rounded-full h-2 w-2 ${dotColor}`} />
      </span>
      <AudioLines className="w-3 h-3" />
      {speakersDetected > 0 && (
        <span className="tabular-nums">{speakersDetected}</span>
      )}
      {stableSpeakerMap && <Check className="w-3 h-3" />}
      {status === 'failed' && <X className="w-3 h-3" />}
    </motion.div>
  );
}

/* ─── SidecarHeader ──────────────────────────── */

export function SidecarHeader({
  elapsed,
  sessionName,
  audioActive,
  currentStage,
  stages,
  acsStatus,
  acsCaptionCount,
  incrementalStatus,
  onEndSession,
}: {
  elapsed: number;
  sessionName: string;
  audioActive: boolean;
  currentStage: number;
  stages: string[];
  acsStatus: AcsStatus;
  acsCaptionCount: number;
  incrementalStatus?: {
    status: IncrementalBadgeStatus;
    speakersDetected: number;
    incrementsCompleted: number;
    stableSpeakerMap: boolean;
  };
  onEndSession: () => void;
}) {
  return (
    <header
      className={`h-10 flex items-center justify-between px-3 bg-surface border-b shrink-0 transition-colors duration-1000 ${
        audioActive ? 'border-accent/60' : 'border-border'
      }`}
    >
      {/* Left: status + session name + ACS badge */}
      <div className="flex items-center gap-2 min-w-0 overflow-hidden">
        <StatusDot status="recording" />
        <span className="text-sm text-ink truncate max-w-[120px]">
          {sessionName}
        </span>
        <div className="shrink-0">
          <AcsStatusBadge status={acsStatus} captionCount={acsCaptionCount} />
        </div>
        {incrementalStatus && incrementalStatus.status !== 'idle' && (
          <div className="shrink-0">
            <IncrementalStatusBadge {...incrementalStatus} />
          </div>
        )}
      </div>

      {/* Center: timer + compact stage */}
      <div className="flex items-center gap-3">
        <AnimatePresence mode="popLayout">
          <motion.span
            key={elapsed}
            initial={{ opacity: 0.5, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.2 }}
            className="text-sm font-mono text-ink-secondary tabular-nums"
          >
            {formatTime(elapsed)}
          </motion.span>
        </AnimatePresence>
        <span className="text-xs text-ink-tertiary">
          <AnimatePresence mode="wait">
            <motion.span
              key={currentStage}
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15 }}
              className="text-accent font-medium"
            >
              {stages[currentStage]}
            </motion.span>
          </AnimatePresence>
          {' '}
          <span className="tabular-nums">{currentStage + 1}/{stages.length}</span>
        </span>
      </div>

      {/* Right: end session */}
      <button
        onClick={onEndSession}
        className="px-3 py-1.5 text-xs font-medium rounded-[--radius-button] text-ink-secondary hover:bg-error hover:text-white transition-colors duration-150"
      >
        End Session
      </button>
    </header>
  );
}
