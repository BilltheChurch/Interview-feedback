import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Star,
  AlertTriangle,
  HelpCircle,
  Link2,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  BookOpen,
  Mic,
  Volume2,
  AudioLines,
  ArrowLeft,
  ArrowRight,
} from 'lucide-react';
import { Button } from '../components/ui/Button';
import { StatusDot } from '../components/ui/StatusDot';
import { Chip } from '../components/ui/Chip';
import { MeterBar } from '../components/ui/MeterBar';
import { ConfidenceBadge } from '../components/ui/ConfidenceBadge';
import { RichNoteEditor, type RichNoteEditorRef } from '../components/RichNoteEditor';
import { useSessionStore } from '../stores/sessionStore';
import type { MemoType } from '../stores/sessionStore';
import { useSessionOrchestrator } from '../hooks/useSessionOrchestrator';

/* ─── Types ─────────────────────────────────── */

type ParticipantStatus = 'pending' | 'capturing' | 'matched' | 'needs_confirm' | 'unknown';

type Participant = {
  name: string;
  status: ParticipantStatus;
  confidence?: number;
  talkTimePct: number;
  turnCount: number;
};

/* ─── Constants ──────────────────────────────── */

const defaultStages = ['Intro', 'Q1', 'Q2', 'Q3', 'Wrap-up'];

const memoConfig: Record<MemoType, { icon: typeof Star; label: string; chipVariant: 'accent' | 'warning' | 'info' | 'default' }> = {
  highlight: { icon: Star, label: 'Highlight', chipVariant: 'accent' },
  issue: { icon: AlertTriangle, label: 'Issue', chipVariant: 'warning' },
  question: { icon: HelpCircle, label: 'Question', chipVariant: 'info' },
  evidence: { icon: Link2, label: 'Evidence', chipVariant: 'default' },
};

const memoShortcutOrder: MemoType[] = ['highlight', 'issue', 'question', 'evidence'];

const mockParticipants: Participant[] = [
  { name: 'John Doe', status: 'matched', confidence: 0.92, talkTimePct: 45, turnCount: 12 },
  { name: 'Jane Smith', status: 'capturing', confidence: 0.78, talkTimePct: 35, turnCount: 8 },
  { name: 'Alex Chen', status: 'needs_confirm', confidence: 0.54, talkTimePct: 15, turnCount: 4 },
  { name: 'Interviewer', status: 'pending', talkTimePct: 5, turnCount: 1 },
];

/* ─── Helpers ────────────────────────────────── */

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ─── CollapsibleSection ─────────────────────── */

function CollapsibleSection({
  title,
  defaultOpen = true,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full mb-1 group"
      >
        <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
          {title}
        </h3>
        {open ? (
          <ChevronUp className="w-3 h-3 text-ink-tertiary group-hover:text-ink-secondary transition-colors duration-150" />
        ) : (
          <ChevronDown className="w-3 h-3 text-ink-tertiary group-hover:text-ink-secondary transition-colors duration-150" />
        )}
      </button>
      {open && <div className="flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}

/* ─── SidecarHeader (with audio heartbeat) ──── */

function SidecarHeader({
  elapsed,
  sessionName,
  audioActive,
  currentStage,
  stages,
  onEndSession,
}: {
  elapsed: number;
  sessionName: string;
  audioActive: boolean;
  currentStage: number;
  stages: string[];
  onEndSession: () => void;
}) {
  return (
    <header
      className={`h-10 flex items-center justify-between px-3 bg-surface border-b shrink-0 transition-colors duration-1000 ${
        audioActive ? 'border-accent/60' : 'border-border'
      }`}
    >
      {/* Left: status + session name */}
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status="recording" />
        <span className="text-sm text-ink truncate max-w-[180px]">
          {sessionName}
        </span>
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

/* ─── Compact Stage Progress Bar ─────────────── */

function StageProgressBar({ currentStage, stages }: { currentStage: number; stages: string[] }) {
  return (
    <div className="flex items-center gap-1 px-3 py-1 border-b border-border/50">
      {stages.map((_, i) => (
        <div
          key={i}
          className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
            i <= currentStage ? 'bg-accent' : 'bg-border'
          }`}
        />
      ))}
    </div>
  );
}

/* ─── QuickMarkBar (bottom, with memo count) ── */

function QuickMarkBar({
  onMark,
  memoCount,
  onToggleMemos,
  memosVisible,
}: {
  onMark: (type: MemoType) => void;
  memoCount: number;
  onToggleMemos: () => void;
  memosVisible: boolean;
}) {
  const buttons: { type: MemoType; icon: typeof Star; color: string; shortcut: string }[] = [
    { type: 'highlight', icon: Star, color: 'text-accent hover:bg-accent-soft', shortcut: '1' },
    { type: 'issue', icon: AlertTriangle, color: 'text-warning hover:bg-amber-50', shortcut: '2' },
    { type: 'question', icon: HelpCircle, color: 'text-blue-600 hover:bg-blue-50', shortcut: '3' },
    { type: 'evidence', icon: Link2, color: 'text-purple-600 hover:bg-purple-50', shortcut: '4' },
  ];

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border bg-surface shrink-0">
      {buttons.map(({ type, icon: Icon, color, shortcut }) => (
        <motion.button
          key={type}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          onClick={() => onMark(type)}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors duration-150 relative group ${color}`}
          title={`${memoConfig[type].label} (Cmd+${shortcut})`}
          aria-label={`${memoConfig[type].label} (Cmd+${shortcut})`}
        >
          <Icon className="w-4 h-4" />
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded text-xs font-medium bg-surface border border-border text-ink-tertiary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {shortcut}
          </span>
        </motion.button>
      ))}
      <span className="ml-1 text-xs text-ink-tertiary">Cmd+1-4</span>
      <button
        onClick={onToggleMemos}
        className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-[--radius-chip] text-xs text-ink-secondary hover:bg-surface-hover transition-colors"
      >
        <BookOpen className="w-3.5 h-3.5" />
        <span className="tabular-nums">{memoCount} memo{memoCount !== 1 ? 's' : ''}</span>
        {memosVisible ? (
          <ChevronDown className="w-3 h-3" />
        ) : (
          <ChevronUp className="w-3 h-3" />
        )}
      </button>
    </div>
  );
}

/* ─── Flashcard color tokens per memo type ───── */

const flashcardStyle: Record<MemoType, { topBorder: string; bg: string; iconColor: string }> = {
  highlight: { topBorder: 'border-t-emerald-400', bg: 'bg-emerald-50/60', iconColor: 'text-emerald-600' },
  issue:     { topBorder: 'border-t-amber-400',   bg: 'bg-amber-50/60',   iconColor: 'text-amber-600' },
  question:  { topBorder: 'border-t-blue-400',    bg: 'bg-blue-50/60',    iconColor: 'text-blue-600' },
  evidence:  { topBorder: 'border-t-purple-400',  bg: 'bg-purple-50/60',  iconColor: 'text-purple-600' },
};

/* ─── MemoFlashcard (single card) ────────────── */

function MemoFlashcard({
  memo,
  onClick,
}: {
  memo: DisplayMemo;
  onClick: () => void;
}) {
  const cfg = memoConfig[memo.type];
  const style = flashcardStyle[memo.type];
  const Icon = cfg.icon;

  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.9, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      whileHover={{ scale: 1.04, y: -3 }}
      whileTap={{ scale: 0.96 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      onClick={onClick}
      className={`
        w-[130px] h-[110px] shrink-0 flex flex-col
        rounded-xl border border-border/60 border-t-[3px] ${style.topBorder}
        bg-surface shadow-card hover:shadow-card-hover
        cursor-pointer select-none text-left
        transition-shadow duration-200
      `}
    >
      {/* Card header — type icon + label */}
      <div className={`flex items-center gap-1.5 px-2.5 pt-2 pb-1 ${style.bg} rounded-t-[9px]`}>
        <Icon className={`w-3 h-3 ${style.iconColor}`} />
        <span className={`text-xs font-semibold ${style.iconColor}`}>
          {cfg.label}
        </span>
      </div>

      {/* Text preview — 2 lines */}
      <div className="flex-1 px-2.5 py-1.5 min-h-0">
        <p className="text-xs text-ink leading-snug line-clamp-2">
          {memo.text}
        </p>
      </div>

      {/* Footer — timestamp */}
      <div className="flex items-center justify-end px-2.5 pb-1.5">
        <span className="text-xs text-ink-tertiary tabular-nums font-mono">
          {formatTime(memo.timestamp)}
        </span>
      </div>
    </motion.button>
  );
}

/* ─── MemoNotepadOverlay (expanded detail) ───── */

function MemoNotepadOverlay({
  memo,
  memos,
  onClose,
  onNavigate,
}: {
  memo: DisplayMemo;
  memos: DisplayMemo[];
  onClose: () => void;
  onNavigate: (id: string) => void;
}) {
  const cfg = memoConfig[memo.type];
  const style = flashcardStyle[memo.type];
  const Icon = cfg.icon;

  const currentIndex = memos.findIndex((m) => m.id === memo.id);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < memos.length - 1;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="absolute inset-0 z-30 flex items-center justify-center bg-ink/30 backdrop-blur-md"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.6, opacity: 0, y: 40 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.7, opacity: 0, y: 30 }}
        transition={{ type: 'spring', stiffness: 300, damping: 28 }}
        onClick={(e) => e.stopPropagation()}
        className={`
          w-[460px] max-h-[85%] min-h-[320px] flex flex-col
          rounded-[--radius-modal] border border-border border-t-[4px] ${style.topBorder}
          bg-surface shadow-modal overflow-hidden
        `}
      >
        {/* Notepad header */}
        <div className={`flex items-center gap-2 px-5 py-3.5 ${style.bg} border-b border-border/40 shrink-0`}>
          <Icon className={`w-5 h-5 ${style.iconColor}`} />
          <Chip variant={cfg.chipVariant} className="text-xs">
            {cfg.label}
          </Chip>
          <span className="text-xs text-ink-secondary bg-surface/80 px-2 py-0.5 rounded-md font-medium">
            {memo.stage}
          </span>
          <span className="text-xs text-ink-tertiary tabular-nums font-mono ml-auto">
            {formatTime(memo.timestamp)}
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-ink-tertiary hover:text-ink hover:bg-surface-hover transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Notepad body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <p className="text-[15px] text-ink leading-[2] whitespace-pre-wrap"
             style={{
               backgroundImage: 'repeating-linear-gradient(transparent, transparent 29px, var(--color-border) 29px, var(--color-border) 30px)',
               backgroundPositionY: '5px',
             }}
          >
            {memo.text}
          </p>
        </div>

        {/* Navigation footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border/40 bg-surface-hover/50 shrink-0">
          <button
            onClick={() => hasPrev && onNavigate(memos[currentIndex - 1].id)}
            disabled={!hasPrev}
            className={`flex items-center gap-1.5 text-sm font-medium transition-colors cursor-pointer ${
              hasPrev ? 'text-accent hover:text-accent-hover' : 'text-ink-tertiary/40 cursor-not-allowed'
            }`}
          >
            <ArrowLeft className="w-4 h-4" />
            Prev
          </button>
          <span className="text-xs text-ink-tertiary tabular-nums">
            {currentIndex + 1} / {memos.length}
          </span>
          <button
            onClick={() => hasNext && onNavigate(memos[currentIndex + 1].id)}
            disabled={!hasNext}
            className={`flex items-center gap-1.5 text-sm font-medium transition-colors cursor-pointer ${
              hasNext ? 'text-accent hover:text-accent-hover' : 'text-ink-tertiary/40 cursor-not-allowed'
            }`}
          >
            Next
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ─── Compact MemoTray (collapsible from bottom bar) ── */

function MemoTray({
  memos,
  onOpenMemo,
}: {
  memos: DisplayMemo[];
  onOpenMemo: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [memos.length]);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="border-t border-border/50 bg-ink/[0.02] overflow-hidden shrink-0"
    >
      <div
        ref={scrollRef}
        className="flex items-center gap-2 px-3 py-2 overflow-x-auto overflow-y-hidden"
        style={{ scrollBehavior: 'smooth' }}
      >
        {memos.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-xs text-ink-tertiary">
            <BookOpen className="w-4 h-4 text-ink-tertiary/50" />
            <span>No memos yet — type notes, then Cmd+1-4 to capture</span>
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {memos.map((memo) => (
              <MemoFlashcard
                key={memo.id}
                memo={memo}
                onClick={() => onOpenMemo(memo.id)}
              />
            ))}
          </AnimatePresence>
        )}
      </div>
    </motion.div>
  );
}

/* ─── FlowControl ────────────────────────────── */

function FlowControl({
  currentStage,
  onAdvance,
  stages,
}: {
  currentStage: number;
  onAdvance: () => void;
  stages: string[];
}) {
  const isLast = currentStage >= stages.length - 1;

  return (
    <div className="flex flex-col gap-1">
      {stages.map((stage, i) => {
        const isPast = i < currentStage;
        const isCurrent = i === currentStage;

        return (
          <div
            key={stage}
            className={`
              flex items-center gap-2 px-2 py-1 rounded-lg text-xs font-medium transition-colors duration-150
              ${isCurrent ? 'bg-accent-soft text-accent' : ''}
              ${isPast ? 'text-ink-tertiary' : ''}
              ${!isPast && !isCurrent ? 'text-ink-tertiary opacity-50' : ''}
            `}
          >
            {isPast ? (
              <Check className="w-3.5 h-3.5 text-success shrink-0" />
            ) : (
              <span
                className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${
                  isCurrent ? 'border-accent bg-accent' : 'border-border'
                }`}
              />
            )}
            {stage}
          </div>
        );
      })}
      {!isLast && (
        <Button variant="secondary" size="sm" className="mt-1" onClick={onAdvance}>
          Next Question
        </Button>
      )}
    </div>
  );
}

/* ─── AudioMeters ────────────────────────────── */

function AudioMeters({ mic, system, mixed }: { mic: number; system: number; mixed: number }) {
  return (
    <>
      <MeterBar label="Mic" value={mic} />
      <MeterBar label="Sys" value={system} />
      <MeterBar label="Mix" value={mixed} />
    </>
  );
}

/* ─── EnrollmentPanel ────────────────────────── */

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
    case 'unknown':
      return <X className="w-3 h-3 text-error" />;
  }
}

function EnrollmentPanel({
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
          {p.status === 'pending' && (
            <button
              onClick={(e) => { e.stopPropagation(); onEnroll(p.name); }}
              className="text-xs text-accent font-medium hover:underline transition-colors duration-150 cursor-pointer"
            >
              Enroll
            </button>
          )}
        </div>
      ))}
    </>
  );
}

/* ─── ParticipationSignals ───────────────────── */

function ParticipationSignals({ participants }: { participants: Participant[] }) {
  return (
    <>
      {participants.map((p) => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="text-xs text-ink-secondary w-14 truncate shrink-0">
            {p.name.split(' ')[0]}
          </span>
          <div className="flex-1 h-2 rounded-full bg-surface-hover overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${p.talkTimePct}%` }}
            />
          </div>
          <span className="text-xs text-ink-tertiary tabular-nums w-14 text-right shrink-0">
            {p.talkTimePct}% / {p.turnCount}t
          </span>
        </div>
      ))}
    </>
  );
}

/* ─── ContextDrawer (narrower default) ───────── */

function ContextDrawer({
  open,
  onToggle,
  currentStage,
  onAdvanceStage,
  participants,
  onEnroll,
  onConfirm,
  stages,
  audioLevels,
}: {
  open: boolean;
  onToggle: () => void;
  currentStage: number;
  onAdvanceStage: () => void;
  participants: Participant[];
  onEnroll: (name: string) => void;
  onConfirm: (name: string) => void;
  stages: string[];
  audioLevels: { mic: number; system: number; mixed: number };
}) {
  return (
    <motion.aside
      animate={{ width: open ? 180 : 44 }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 border-l border-border bg-surface flex flex-col relative"
    >
      {/* Toggle button */}
      <button
        onClick={onToggle}
        className="absolute top-2 -left-3 w-6 h-6 rounded-full bg-surface border border-border shadow-sm flex items-center justify-center text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors duration-150 z-10"
        title={open ? 'Collapse drawer' : 'Expand drawer'}
        aria-label={open ? 'Collapse drawer' : 'Expand drawer'}
      >
        {open ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
      </button>

      {/* Collapsed icon rail */}
      {!open && (
        <div className="flex flex-col items-center gap-3 py-3 mt-6">
          <Mic className="w-4 h-4 text-ink-tertiary" />
          <Volume2 className="w-4 h-4 text-ink-tertiary" />
          <AudioLines className="w-4 h-4 text-ink-tertiary" />
        </div>
      )}

      {/* Expanded content */}
      {open && (
        <div className="flex-1 overflow-y-auto p-2.5 pt-6 flex flex-col gap-3">
          <CollapsibleSection title="Audio" defaultOpen>
            <AudioMeters mic={audioLevels.mic} system={audioLevels.system} mixed={audioLevels.mixed} />
          </CollapsibleSection>
          <CollapsibleSection title="Flow">
            <FlowControl currentStage={currentStage} onAdvance={onAdvanceStage} stages={stages} />
          </CollapsibleSection>
          <CollapsibleSection title="Speakers" defaultOpen={false}>
            <EnrollmentPanel participants={participants} onEnroll={onEnroll} onConfirm={onConfirm} />
          </CollapsibleSection>
          <CollapsibleSection title="Talk Time" defaultOpen={false}>
            <ParticipationSignals participants={participants} />
          </CollapsibleSection>
        </div>
      )}
    </motion.aside>
  );
}

/* ─── DisplayMemo — enriches store Memo with stage name ── */

type DisplayMemo = {
  id: string;
  type: MemoType;
  text: string;
  timestamp: number;
  stage: string;
  createdAt: Date;
};

/* ─── SidecarView (main export) ──────────────── */

export function SidecarView() {
  const location = useLocation();
  const locationState = location.state as {
    sessionId?: string;
    sessionName?: string;
    mode?: string;
    participants?: string[];
    stages?: string[];
  } | null;

  // ── Store selectors ──
  const sessionTimer = useSessionStore((s) => s.elapsedSeconds);
  const storeMemos = useSessionStore((s) => s.memos);
  const currentStage = useSessionStore((s) => s.currentStage);
  const audioLevels = useSessionStore((s) => s.audioLevels);
  const storeAddMemo = useSessionStore((s) => s.addMemo);
  const advanceStage = useSessionStore((s) => s.advanceStage);
  const storeSetNotes = useSessionStore((s) => s.setNotes);
  const storeStages = useSessionStore((s) => s.stages);
  const storeSessionName = useSessionStore((s) => s.sessionName);
  const storeSessionId = useSessionStore((s) => s.sessionId);

  const { end } = useSessionOrchestrator();

  // Derive display values
  const sessionId = storeSessionId || locationState?.sessionId || `sess_${Date.now()}`;
  const sessionDisplayName = storeSessionName || locationState?.sessionName || 'Interview Session';
  const stages = storeStages.length > 0
    ? storeStages
    : (locationState?.stages && locationState.stages.length > 0 ? locationState.stages : defaultStages);

  // Build participant list
  const initialParticipants: Participant[] = locationState
    ? [
        ...(locationState.participants || []).map(name => ({
          name,
          status: 'pending' as ParticipantStatus,
          talkTimePct: 0,
          turnCount: 0,
        })),
        { name: 'Interviewer', status: 'matched' as ParticipantStatus, confidence: 1.0, talkTimePct: 0, turnCount: 0 },
      ]
    : mockParticipants;

  // ── UI-only local state ──
  const [notes, setNotes] = useState('');
  const [plainText, setPlainText] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [memosVisible, setMemosVisible] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [openMemoId, setOpenMemoId] = useState<string | null>(null);

  const editorRef = useRef<RichNoteEditorRef>(null);

  // Audio activity indicator
  const audioActive = audioLevels.mic > 0.05 || audioLevels.system > 0.05;

  // Enrich store memos with stage name for display
  const memos: DisplayMemo[] = useMemo(
    () => storeMemos.map((m) => ({
      id: m.id,
      type: m.type,
      text: m.text,
      timestamp: m.timestamp,
      stage: stages[currentStage] ?? 'Unknown',
      createdAt: m.createdAt,
    })),
    [storeMemos, stages, currentStage],
  );

  // Save memo
  const addMemo = useCallback(
    (type: MemoType) => {
      const text = plainText.trim();
      if (!text) return;
      storeAddMemo(type, text.slice(0, 200));
      editorRef.current?.clearContent();
      setPlainText('');
    },
    [plainText, storeAddMemo],
  );

  // Sync notes to store
  const handleNotesChange = useCallback(
    (html: string) => {
      setNotes(html);
      storeSetNotes(html);
    },
    [storeSetNotes],
  );

  // Keyboard shortcuts: Cmd+1/2/3/4 for quick marks
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.metaKey && !e.ctrlKey) return;
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < memoShortcutOrder.length) {
        e.preventDefault();
        addMemo(memoShortcutOrder[idx]);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [addMemo]);

  // Enrollment handlers
  const handleEnroll = useCallback((name: string) => {
    setParticipants(prev => prev.map(p =>
      p.name === name ? { ...p, status: 'capturing' as ParticipantStatus } : p
    ));
    setTimeout(() => {
      setParticipants(prev => prev.map(p =>
        p.name === name ? { ...p, status: 'needs_confirm' as ParticipantStatus, confidence: 0.7 + Math.random() * 0.25 } : p
      ));
    }, 3000);
  }, []);

  const handleConfirm = useCallback((name: string) => {
    setParticipants(prev => prev.map(p =>
      p.name === name ? { ...p, status: 'matched' as ParticipantStatus } : p
    ));
  }, []);

  // End session
  const handleEndSession = useCallback(() => {
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const updated = sessions.map((s: Record<string, unknown>) =>
        s.id === sessionId ? { ...s, status: 'completed' } : s
      );
      localStorage.setItem('ifb_sessions', JSON.stringify(updated));
    } catch { /* ignore parse errors */ }

    end();
  }, [end, sessionId]);

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header — compact with timer, stage, and audio heartbeat */}
      <SidecarHeader
        elapsed={sessionTimer}
        sessionName={sessionDisplayName}
        audioActive={audioActive}
        currentStage={currentStage}
        stages={stages}
        onEndSession={handleEndSession}
      />

      {/* Thin stage progress bar */}
      <StageProgressBar currentStage={currentStage} stages={stages} />

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Notes workspace — takes maximum space */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Notes editor — hero element, fills available space */}
          <RichNoteEditor
            ref={editorRef}
            content={notes}
            onContentChange={handleNotesChange}
            onPlainTextChange={setPlainText}
            placeholder="Type your notes here..."
            className="flex-1"
            autoFocus
          />

          {/* Collapsible memo tray */}
          <AnimatePresence>
            {memosVisible && (
              <MemoTray memos={memos} onOpenMemo={(id) => setOpenMemoId(id)} />
            )}
          </AnimatePresence>

          {/* Quick mark bar — at bottom, with memo count toggle */}
          <QuickMarkBar
            onMark={addMemo}
            memoCount={memos.length}
            onToggleMemos={() => setMemosVisible(v => !v)}
            memosVisible={memosVisible}
          />
        </div>

        {/* Context drawer — narrower right rail */}
        <ContextDrawer
          open={drawerOpen}
          onToggle={() => setDrawerOpen((v) => !v)}
          currentStage={currentStage}
          onAdvanceStage={advanceStage}
          participants={participants}
          onEnroll={handleEnroll}
          onConfirm={handleConfirm}
          stages={stages}
          audioLevels={audioLevels}
        />

        {/* Memo notepad overlay */}
        <AnimatePresence>
          {openMemoId && (() => {
            const memo = memos.find((m) => m.id === openMemoId);
            if (!memo) return null;
            return (
              <MemoNotepadOverlay
                memo={memo}
                memos={memos}
                onClose={() => setOpenMemoId(null)}
                onNavigate={(id) => setOpenMemoId(id)}
              />
            );
          })()}
        </AnimatePresence>
      </div>
    </div>
  );
}
