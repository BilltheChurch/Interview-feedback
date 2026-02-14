import { useState, useCallback } from 'react';
import {
  Mic,
  Check,
  RotateCcw,
  SkipForward,
  Lock,
  Unlock,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { Button } from './ui/Button';
import { StatusDot } from './ui/StatusDot';
import { ConfidenceBadge } from './ui/ConfidenceBadge';
import { Chip } from './ui/Chip';
import { Select } from './ui/Select';

/* ─── Types ─────────────────────────────────── */

type EnrollmentStatus = 'pending' | 'capturing' | 'captured' | 'confirmed' | 'skipped';

type ParticipantEnrollment = {
  id: string;
  name: string;
  status: EnrollmentStatus;
  speakerId?: string;
  confidence?: number;
  locked: boolean;
};

type EnrollmentWizardProps = {
  participants: Array<{ id: string; name: string }>;
  /** Available speaker IDs from clustering */
  availableSpeakers?: Array<{ id: string; label: string }>;
  /** Called when enrollment capture starts for a person */
  onStartCapture?: (participantId: string) => void;
  /** Called when enrollment capture stops */
  onStopCapture?: (participantId: string) => void;
  /** Called when speaker mapping is confirmed */
  onConfirm?: (participantId: string, speakerId: string) => void;
  /** Called when speaker mapping is manually changed */
  onReassign?: (participantId: string, newSpeakerId: string) => void;
  /** Compact mode for drawer */
  compact?: boolean;
};

/* ─── Helpers ───────────────────────────────── */

const statusConfig: Record<EnrollmentStatus, { label: string; dotStatus: 'recording' | 'reconnecting' | 'idle' }> = {
  pending: { label: 'Waiting', dotStatus: 'idle' },
  capturing: { label: 'Capturing...', dotStatus: 'recording' },
  captured: { label: 'Review', dotStatus: 'reconnecting' },
  confirmed: { label: 'Confirmed', dotStatus: 'recording' },
  skipped: { label: 'Skipped', dotStatus: 'idle' },
};

/* ─── WizardStep (per person) ───────────────── */

function WizardStep({
  enrollment,
  isActive,
  availableSpeakers,
  onStartCapture,
  onStopCapture,
  onConfirm,
  onRetry,
  onSkip,
  onToggleLock,
  onReassign,
}: {
  enrollment: ParticipantEnrollment;
  isActive: boolean;
  availableSpeakers: Array<{ id: string; label: string }>;
  onStartCapture: () => void;
  onStopCapture: () => void;
  onConfirm: () => void;
  onRetry: () => void;
  onSkip: () => void;
  onToggleLock: () => void;
  onReassign: (speakerId: string) => void;
}) {
  const cfg = statusConfig[enrollment.status];
  const [expanded, setExpanded] = useState(isActive);

  return (
    <div
      className={`border rounded-[--radius-button] transition-colors ${
        isActive ? 'border-accent bg-accent-soft/30' : 'border-border bg-surface'
      }`}
    >
      {/* Header row */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 cursor-pointer"
      >
        <StatusDot status={cfg.dotStatus} />
        <span className="text-sm font-medium text-ink flex-1 text-left truncate">
          {enrollment.name}
        </span>
        {enrollment.confidence != null && (
          <ConfidenceBadge score={enrollment.confidence} />
        )}
        <Chip
          variant={enrollment.status === 'confirmed' ? 'success' : enrollment.status === 'skipped' ? 'default' : 'accent'}
        >
          {cfg.label}
        </Chip>
        {expanded ? <ChevronUp className="w-3.5 h-3.5 text-ink-tertiary" /> : <ChevronDown className="w-3.5 h-3.5 text-ink-tertiary" />}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* Active capture prompt */}
          {enrollment.status === 'pending' && isActive && (
            <div className="space-y-2">
              <p className="text-xs text-ink-secondary">
                Ask <strong>{enrollment.name}</strong> to speak for 5-8 seconds
              </p>
              <Button size="sm" onClick={onStartCapture}>
                <Mic className="w-3.5 h-3.5" />
                Start Capture
              </Button>
            </div>
          )}

          {/* Capturing state */}
          {enrollment.status === 'capturing' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded-full bg-surface-hover overflow-hidden">
                  <div className="h-full rounded-full bg-accent animate-pulse w-3/4" />
                </div>
                <span className="text-xs text-ink-secondary">Listening...</span>
              </div>
              <Button size="sm" variant="secondary" onClick={onStopCapture}>
                Stop
              </Button>
            </div>
          )}

          {/* Review captured result */}
          {enrollment.status === 'captured' && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-ink-secondary">
                <span>Matched speaker:</span>
                {enrollment.speakerId && (
                  <Chip variant="accent">{enrollment.speakerId}</Chip>
                )}
                {enrollment.confidence != null && (
                  <ConfidenceBadge score={enrollment.confidence} />
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={onConfirm}>
                  <Check className="w-3.5 h-3.5" />
                  Confirm
                </Button>
                <Button size="sm" variant="secondary" onClick={onRetry}>
                  <RotateCcw className="w-3.5 h-3.5" />
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={onSkip}>
                  <SkipForward className="w-3.5 h-3.5" />
                  Skip
                </Button>
              </div>
            </div>
          )}

          {/* Confirmed — show mapping with lock */}
          {(enrollment.status === 'confirmed' || enrollment.status === 'skipped') && (
            <div className="flex items-center gap-2">
              <Select
                label=""
                options={availableSpeakers.map((s) => ({ value: s.id, label: s.label }))}
                value={enrollment.speakerId || ''}
                onChange={(e) => onReassign(e.target.value)}
                disabled={enrollment.locked}
              />
              <button
                onClick={onToggleLock}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                  enrollment.locked
                    ? 'text-accent bg-accent-soft'
                    : 'text-ink-tertiary hover:text-ink-secondary'
                }`}
                title={enrollment.locked ? 'Unlock mapping' : 'Lock mapping'}
              >
                {enrollment.locked ? <Lock className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── EnrollmentWizard (main export) ────────── */

export function EnrollmentWizard({
  participants,
  availableSpeakers = [
    { id: 'spk_001', label: 'Speaker 1' },
    { id: 'spk_002', label: 'Speaker 2' },
    { id: 'spk_003', label: 'Speaker 3' },
  ],
  onStartCapture,
  onStopCapture,
  onConfirm,
  onReassign,
}: EnrollmentWizardProps) {
  const [enrollments, setEnrollments] = useState<ParticipantEnrollment[]>(() =>
    participants.map((p) => ({
      id: p.id,
      name: p.name,
      status: 'pending' as EnrollmentStatus,
      locked: false,
    }))
  );

  const [activeIndex, setActiveIndex] = useState(0);

  const updateEnrollment = useCallback((id: string, updates: Partial<ParticipantEnrollment>) => {
    setEnrollments((prev) =>
      prev.map((e) => (e.id === id ? { ...e, ...updates } : e))
    );
  }, []);

  const handleStartCapture = useCallback((id: string) => {
    updateEnrollment(id, { status: 'capturing' });
    onStartCapture?.(id);

    // Simulate capture completion after 5 seconds (real integration will use IPC events)
    setTimeout(() => {
      updateEnrollment(id, {
        status: 'captured',
        speakerId: availableSpeakers[Math.floor(Math.random() * availableSpeakers.length)]?.id,
        confidence: 0.7 + Math.random() * 0.25,
      });
    }, 5000);
  }, [updateEnrollment, onStartCapture, availableSpeakers]);

  const handleStopCapture = useCallback((id: string) => {
    updateEnrollment(id, {
      status: 'captured',
      speakerId: availableSpeakers[0]?.id,
      confidence: 0.6 + Math.random() * 0.3,
    });
    onStopCapture?.(id);
  }, [updateEnrollment, onStopCapture, availableSpeakers]);

  const handleConfirm = useCallback((id: string) => {
    const enrollment = enrollments.find((e) => e.id === id);
    updateEnrollment(id, { status: 'confirmed', locked: true });
    if (enrollment?.speakerId) {
      onConfirm?.(id, enrollment.speakerId);
    }
    // Advance to next pending
    const nextIdx = enrollments.findIndex((e, i) => i > activeIndex && e.status === 'pending');
    if (nextIdx >= 0) setActiveIndex(nextIdx);
  }, [enrollments, activeIndex, updateEnrollment, onConfirm]);

  const handleRetry = useCallback((id: string) => {
    updateEnrollment(id, { status: 'pending', speakerId: undefined, confidence: undefined });
  }, [updateEnrollment]);

  const handleSkip = useCallback((id: string) => {
    updateEnrollment(id, { status: 'skipped' });
    const nextIdx = enrollments.findIndex((e, i) => i > activeIndex && e.status === 'pending');
    if (nextIdx >= 0) setActiveIndex(nextIdx);
  }, [enrollments, activeIndex, updateEnrollment]);

  const handleToggleLock = useCallback((id: string) => {
    const enrollment = enrollments.find((e) => e.id === id);
    if (enrollment) {
      updateEnrollment(id, { locked: !enrollment.locked });
    }
  }, [enrollments, updateEnrollment]);

  const handleReassign = useCallback((id: string, newSpeakerId: string) => {
    updateEnrollment(id, { speakerId: newSpeakerId });
    onReassign?.(id, newSpeakerId);
  }, [updateEnrollment, onReassign]);

  const confirmedCount = enrollments.filter((e) => e.status === 'confirmed').length;
  const totalCount = enrollments.length;

  return (
    <div className="space-y-2">
      {/* Progress */}
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
          Enrollment
        </h3>
        <span className="text-xs text-ink-tertiary tabular-nums">
          {confirmedCount}/{totalCount}
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden mb-2">
        <div
          className="h-full rounded-full bg-accent transition-all duration-300"
          style={{ width: `${totalCount > 0 ? (confirmedCount / totalCount) * 100 : 0}%` }}
        />
      </div>

      {/* Steps */}
      <div className="space-y-1.5">
        {enrollments.map((enrollment, index) => (
          <WizardStep
            key={enrollment.id}
            enrollment={enrollment}
            isActive={index === activeIndex}
            availableSpeakers={availableSpeakers}
            onStartCapture={() => handleStartCapture(enrollment.id)}
            onStopCapture={() => handleStopCapture(enrollment.id)}
            onConfirm={() => handleConfirm(enrollment.id)}
            onRetry={() => handleRetry(enrollment.id)}
            onSkip={() => handleSkip(enrollment.id)}
            onToggleLock={() => handleToggleLock(enrollment.id)}
            onReassign={(speakerId) => handleReassign(enrollment.id, speakerId)}
          />
        ))}
      </div>
    </div>
  );
}
