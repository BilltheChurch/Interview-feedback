import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
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
  FileText,
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
import { EmptyState } from '../components/ui/EmptyState';
import { RichNoteEditor, type RichNoteEditorRef } from '../components/RichNoteEditor';

/* ─── Types ─────────────────────────────────── */

type MemoType = 'highlight' | 'issue' | 'question' | 'evidence';

type Memo = {
  id: string;
  type: MemoType;
  text: string;
  timestamp: number; // seconds since session start
  stage: string; // interview flow stage when captured
  createdAt: Date;
};

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

let memoIdCounter = 0;

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

/* ─── SidecarHeader ──────────────────────────── */

function SidecarHeader({
  elapsed,
  sessionName,
  showTranscript,
  onToggleTranscript,
  onEndSession,
}: {
  elapsed: number;
  sessionName: string;
  showTranscript: boolean;
  onToggleTranscript: () => void;
  onEndSession: () => void;
}) {
  return (
    <header className="h-10 flex items-center justify-between px-3 bg-surface border-b border-border shrink-0">
      {/* Left: status + session name */}
      <div className="flex items-center gap-2 min-w-0">
        <StatusDot status="recording" />
        <span className="text-sm text-ink truncate max-w-[200px]">
          {sessionName}
        </span>
      </div>

      {/* Center: timer */}
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

      {/* Right: transcript toggle + end session */}
      <div className="flex items-center gap-2">
        <button
          onClick={onToggleTranscript}
          className={`p-1.5 rounded-lg transition-colors duration-150 ${
            showTranscript
              ? 'bg-accent-soft text-accent'
              : 'text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover'
          }`}
          title="Toggle transcript"
          aria-label="Toggle transcript"
        >
          <FileText className="w-4 h-4" />
        </button>
        <button
          onClick={onEndSession}
          className="px-3 py-1.5 text-xs font-medium rounded-[--radius-button] text-ink-secondary hover:bg-error hover:text-white transition-colors duration-150"
        >
          End Session
        </button>
      </div>
    </header>
  );
}

/* ─── QuickMarkBar ───────────────────────────── */

function QuickMarkBar({ onMark }: { onMark: (type: MemoType) => void }) {
  const buttons: { type: MemoType; icon: typeof Star; color: string; shortcut: string }[] = [
    { type: 'highlight', icon: Star, color: 'text-accent hover:bg-accent-soft', shortcut: '1' },
    { type: 'issue', icon: AlertTriangle, color: 'text-warning hover:bg-amber-50', shortcut: '2' },
    { type: 'question', icon: HelpCircle, color: 'text-blue-600 hover:bg-blue-50', shortcut: '3' },
    { type: 'evidence', icon: Link2, color: 'text-purple-600 hover:bg-purple-50', shortcut: '4' },
  ];

  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border bg-surface">
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
          <span className="absolute -top-1 -right-1 w-4 h-4 rounded text-[9px] font-medium bg-surface border border-border text-ink-tertiary flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
            {shortcut}
          </span>
        </motion.button>
      ))}
      <span className="ml-auto text-[10px] text-ink-tertiary">Cmd+1-4</span>
    </div>
  );
}

/* ─── StageIndicator ─────────────────────────── */

function StageIndicator({ currentStage, stages }: { currentStage: number; stages: string[] }) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 bg-accent-soft/50 border-b border-accent-soft">
      <AnimatePresence mode="wait">
        <motion.span
          key={currentStage}
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: 0.2 }}
          className="text-xs font-medium text-accent"
        >
          {stages[currentStage]}
        </motion.span>
      </AnimatePresence>
      <div className="flex-1 flex items-center gap-1">
        {stages.map((_, i) => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
              i <= currentStage ? 'bg-accent' : 'bg-border'
            }`}
          />
        ))}
      </div>
      <span className="text-[10px] text-ink-tertiary tabular-nums">
        {currentStage + 1}/{stages.length}
      </span>
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
  memo: Memo;
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
        w-[140px] h-[130px] shrink-0 flex flex-col
        rounded-xl border border-border/60 border-t-[3px] ${style.topBorder}
        bg-surface shadow-card hover:shadow-card-hover
        cursor-pointer select-none text-left
        transition-shadow duration-200
      `}
    >
      {/* Card header — type icon + label */}
      <div className={`flex items-center gap-1.5 px-2.5 pt-2.5 pb-1.5 ${style.bg} rounded-t-[9px]`}>
        <Icon className={`w-3.5 h-3.5 ${style.iconColor}`} />
        <span className={`text-[10px] font-semibold ${style.iconColor}`}>
          {cfg.label}
        </span>
      </div>

      {/* Text preview — 3 lines */}
      <div className="flex-1 px-2.5 py-2 min-h-0">
        <p className="text-[11px] text-ink leading-snug line-clamp-3">
          {memo.text}
        </p>
      </div>

      {/* Footer — timestamp */}
      <div className="flex items-center justify-end px-2.5 pb-2">
        <span className="text-[9px] text-ink-tertiary tabular-nums font-mono">
          {formatTime(memo.timestamp)}
        </span>
      </div>
    </motion.button>
  );
}

/* ─── MemoNotepadOverlay (expanded detail) ───── */
/* Rendered at SidecarView body level for full-screen coverage */

function MemoNotepadOverlay({
  memo,
  memos,
  onClose,
  onNavigate,
}: {
  memo: Memo;
  memos: Memo[];
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

        {/* Notepad body — lined paper feel */}
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

/* ─── Stage lane divider ─────────────────────── */

function StageLaneDivider({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center gap-1 shrink-0 self-stretch py-2">
      <div className="w-px flex-1 bg-border/60" />
      <span className="text-[9px] font-semibold text-accent uppercase tracking-wider whitespace-nowrap px-1">
        {label}
      </span>
      <div className="w-px flex-1 bg-border/60" />
    </div>
  );
}

/* ─── MemoTimeline (horizontal flashcard tray) ── */

function MemoTimeline({
  memos,
  stages,
  currentStage,
  onOpenMemo,
}: {
  memos: Memo[];
  stages: string[];
  currentStage: number;
  onOpenMemo: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to rightmost (newest) card when a memo is added
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [memos.length]);

  // Group memos by stage for lane rendering
  const memosByStage = useMemo(() => {
    const map = new Map<string, Memo[]>();
    for (const stage of stages) {
      map.set(stage, []);
    }
    for (const memo of memos) {
      const list = map.get(memo.stage);
      if (list) list.push(memo);
    }
    return map;
  }, [memos, stages]);

  return (
    <div className="h-[190px] shrink-0 border-t border-border bg-ink/[0.03] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-border/50 shrink-0">
        <span className="text-xs font-medium text-ink-secondary uppercase tracking-wider">
          Memos
        </span>
        <span className="text-xs text-ink-tertiary tabular-nums">
          {memos.length} captured
        </span>
      </div>

      {/* Horizontal flashcard strip — grouped by stage */}
      <div
        ref={scrollRef}
        className="flex-1 flex items-center gap-2 px-3 overflow-x-auto overflow-y-hidden"
        style={{ scrollBehavior: 'smooth' }}
      >
        {memos.length === 0 ? (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <BookOpen className="w-5 h-5 text-ink-tertiary/50 mx-auto mb-1" />
              <p className="text-[11px] text-ink-tertiary">No memos yet</p>
              <p className="text-[9px] text-ink-tertiary/60">Cmd+1-4 to capture moments</p>
            </div>
          </div>
        ) : (
          <>
            {Array.from(memosByStage.entries()).map(([stage, stageMemos], stageIdx) => {
              if (stageMemos.length === 0) return null;
              return (
                <div key={stage} className="flex items-center gap-2 shrink-0">
                  {/* Stage lane divider */}
                  {stageIdx > 0 && <StageLaneDivider label={stage} />}
                  {stageIdx === 0 && <StageLaneDivider label={stage} />}

                  {/* Cards in this stage */}
                  <AnimatePresence initial={false}>
                    {stageMemos.map((memo) => (
                      <MemoFlashcard
                        key={memo.id}
                        memo={memo}
                        onClick={() => onOpenMemo(memo.id)}
                      />
                    ))}
                  </AnimatePresence>
                </div>
              );
            })}

            {/* Show current stage indicator if no memos yet in current stage */}
            {(() => {
              const currentStageName = stages[currentStage];
              const currentStageMemos = memosByStage.get(currentStageName) || [];
              if (currentStageMemos.length === 0 && memos.length > 0) {
                return (
                  <div className="flex items-center gap-2 shrink-0">
                    <StageLaneDivider label={currentStageName} />
                    <div className="w-[140px] h-[130px] shrink-0 rounded-xl border-2 border-dashed border-border/40 flex items-center justify-center">
                      <p className="text-[10px] text-ink-tertiary text-center px-3">
                        Recording in<br /><span className="font-semibold text-accent">{currentStageName}</span>
                      </p>
                    </div>
                  </div>
                );
              }
              return null;
            })()}
          </>
        )}
      </div>
    </div>
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
              flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs font-medium transition-colors duration-150
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

function AudioMeters() {
  return (
    <>
      <MeterBar label="Mic" value={42} />
      <MeterBar label="System" value={28} />
      <MeterBar label="Mixed" value={35} />
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
                className="text-[10px] text-warning animate-pulse"
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
              className="text-[10px] text-accent font-medium hover:underline transition-colors duration-150 cursor-pointer"
            >
              Confirm
            </button>
          )}
          {p.status === 'pending' && (
            <button
              onClick={(e) => { e.stopPropagation(); onEnroll(p.name); }}
              className="text-[10px] text-accent font-medium hover:underline transition-colors duration-150 cursor-pointer"
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
          <span className="text-[10px] text-ink-tertiary tabular-nums w-14 text-right shrink-0">
            {p.talkTimePct}% / {p.turnCount}t
          </span>
        </div>
      ))}
    </>
  );
}

/* ─── TranscriptOverlay ──────────────────────── */

function TranscriptOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <div className="absolute inset-y-0 right-0 w-80 bg-surface/95 backdrop-blur border-l border-border p-4 overflow-y-auto z-10">
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-3">
        Live Transcript
      </h3>
      <p className="text-xs text-ink-tertiary italic">
        Transcript will appear here during the session...
      </p>
    </div>
  );
}

/* ─── ContextDrawer ──────────────────────────── */

function ContextDrawer({
  open,
  onToggle,
  currentStage,
  onAdvanceStage,
  participants,
  onEnroll,
  onConfirm,
  stages,
}: {
  open: boolean;
  onToggle: () => void;
  currentStage: number;
  onAdvanceStage: () => void;
  participants: Participant[];
  onEnroll: (name: string) => void;
  onConfirm: (name: string) => void;
  stages: string[];
}) {
  return (
    <motion.aside
      animate={{ width: open ? '22%' : '2.75rem' }}
      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
      className="shrink-0 border-l border-border bg-surface flex flex-col relative"
      style={{ minWidth: open ? 200 : undefined }}
    >
      {/* Toggle button — top edge */}
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
        <div className="flex-1 overflow-y-auto p-3 pt-6 flex flex-col gap-4">
          <CollapsibleSection title="Flow">
            <FlowControl currentStage={currentStage} onAdvance={onAdvanceStage} stages={stages} />
          </CollapsibleSection>
          <CollapsibleSection title="Audio">
            <AudioMeters />
          </CollapsibleSection>
          <CollapsibleSection title="Participants">
            <EnrollmentPanel participants={participants} onEnroll={onEnroll} onConfirm={onConfirm} />
          </CollapsibleSection>
          <CollapsibleSection title="Talk Time">
            <ParticipationSignals participants={participants} />
          </CollapsibleSection>
        </div>
      )}
    </motion.aside>
  );
}

/* ─── SidecarView (main export) ──────────────── */

export function SidecarView() {
  const navigate = useNavigate();
  const location = useLocation();
  const locationState = location.state as {
    sessionId?: string;
    sessionName?: string;
    mode?: string;
    participants?: string[];
    stages?: string[];
  } | null;
  const sessionId = locationState?.sessionId || `sess_${Date.now()}`;
  const sessionDisplayName = locationState?.sessionName || 'Interview Session';

  // Build stages from route state, falling back to defaults
  const stages = locationState?.stages && locationState.stages.length > 0
    ? locationState.stages
    : defaultStages;

  // Build participant list from route state, falling back to mock data
  // If locationState exists (user came from SetupView), trust it — even if participants is empty.
  // Only fall back to mockParticipants when there's NO locationState (direct URL access during dev).
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

  const [sessionTimer, setSessionTimer] = useState(0);
  const [notes, setNotes] = useState('');
  const [plainText, setPlainText] = useState('');
  const [memos, setMemos] = useState<Memo[]>([]);
  const [currentStage, setCurrentStage] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [showTranscript, setShowTranscript] = useState(false);
  const [participants, setParticipants] = useState<Participant[]>(initialParticipants);
  const [openMemoId, setOpenMemoId] = useState<string | null>(null);

  const editorRef = useRef<RichNoteEditorRef>(null);

  // Session timer
  useEffect(() => {
    const id = setInterval(() => setSessionTimer((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // Save memo: captures current editor text, then clears the editor
  const addMemo = useCallback(
    (type: MemoType) => {
      const text = plainText.trim();
      if (!text) return; // nothing to save

      const memo: Memo = {
        id: String(++memoIdCounter),
        type,
        text: text.slice(0, 200),
        timestamp: sessionTimer,
        stage: stages[currentStage],
        createdAt: new Date(),
      };
      setMemos((prev) => [...prev, memo]);

      // Clear editor
      editorRef.current?.clearContent();
      setPlainText('');
    },
    [plainText, sessionTimer, stages, currentStage],
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

  // Advance stage
  const advanceStage = useCallback(() => {
    setCurrentStage((s) => Math.min(s + 1, stages.length - 1));
  }, [stages.length]);

  // Enrollment handlers
  const handleEnroll = useCallback((name: string) => {
    setParticipants(prev => prev.map(p =>
      p.name === name ? { ...p, status: 'capturing' as ParticipantStatus } : p
    ));
    // Simulate enrollment completion after 3 seconds
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

  // End session — persist and navigate to feedback
  const handleEndSession = useCallback(() => {
    // Update session status in localStorage
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const updated = sessions.map((s: any) =>
        s.id === sessionId ? { ...s, status: 'completed' } : s
      );
      localStorage.setItem('ifb_sessions', JSON.stringify(updated));
    } catch { /* ignore parse errors */ }

    // Serialize memos for route state (drop Date objects)
    const serializedMemos = memos.map(m => ({
      id: m.id,
      type: m.type,
      text: m.text,
      timestamp: m.timestamp,
      stage: m.stage,
    }));

    navigate(`/feedback/${sessionId}`, {
      state: {
        sessionName: sessionDisplayName,
        participants: participants.map(p => p.name).filter(n => n !== 'Interviewer'),
        mode: locationState?.mode,
        memos: serializedMemos,
        stages,
        notes,
      },
    });
  }, [navigate, sessionId, sessionDisplayName, participants, locationState?.mode, memos, stages, notes]);

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Header */}
      <SidecarHeader
        elapsed={sessionTimer}
        sessionName={sessionDisplayName}
        showTranscript={showTranscript}
        onToggleTranscript={() => setShowTranscript((v) => !v)}
        onEndSession={handleEndSession}
      />

      {/* Body */}
      <div className="flex flex-1 min-h-0 relative">
        {/* Notes workspace — takes remaining width */}
        <div className="flex-1 flex flex-col min-w-0">
          <QuickMarkBar onMark={addMemo} />
          <StageIndicator currentStage={currentStage} stages={stages} />
          <RichNoteEditor
            ref={editorRef}
            content={notes}
            onContentChange={setNotes}
            onPlainTextChange={setPlainText}
            placeholder="Type your notes here..."
            className="flex-1"
            autoFocus
          />
          <MemoTimeline
            memos={memos}
            stages={stages}
            currentStage={currentStage}
            onOpenMemo={(id) => setOpenMemoId(id)}
          />
        </div>

        {/* Context drawer — right rail */}
        <ContextDrawer
          open={drawerOpen}
          onToggle={() => setDrawerOpen((v) => !v)}
          currentStage={currentStage}
          onAdvanceStage={advanceStage}
          participants={participants}
          onEnroll={handleEnroll}
          onConfirm={handleConfirm}
          stages={stages}
        />

        {/* Transcript overlay */}
        <TranscriptOverlay visible={showTranscript} />

        {/* Memo notepad overlay — covers entire workspace */}
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
