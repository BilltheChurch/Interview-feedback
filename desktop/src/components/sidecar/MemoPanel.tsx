import { useRef, useEffect, forwardRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Star,
  AlertTriangle,
  HelpCircle,
  Link2,
  BookOpen,
  ChevronDown,
  ChevronUp,
  ArrowLeft,
  ArrowRight,
  X,
} from 'lucide-react';
import { Chip } from '../ui/Chip';
import type { MemoType } from '../../stores/sessionStore';
import { memoConfig, memoShortcutOrder, flashcardStyle, formatTime, type DisplayMemo } from './types';

/* ─── QuickMarkBar ────────────────────────────── */

export function QuickMarkBar({
  onMark,
  memoCount,
  onToggleMemos,
  memosVisible,
  buttonRefsMap,
  pulsingType,
}: {
  onMark: (type: MemoType, buttonRect?: DOMRect) => void;
  memoCount: number;
  onToggleMemos: () => void;
  memosVisible: boolean;
  buttonRefsMap?: React.MutableRefObject<Map<MemoType, HTMLElement>>;
  pulsingType?: MemoType | null;
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
          ref={(el) => {
            if (el && buttonRefsMap) {
              buttonRefsMap.current.set(type, el);
            }
          }}
          whileHover={{ scale: 1.08 }}
          whileTap={{ scale: 0.92 }}
          transition={{ type: 'spring', stiffness: 400, damping: 17 }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onMark(type, rect);
          }}
          className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors duration-150 relative group ${color}`}
          style={pulsingType === type ? { animation: 'memo-pulse 0.4s ease-out' } : undefined}
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

/* ─── FlyingMemo (parabolic arc animation) ──── */

export function FlyingMemo({
  type,
  startRect,
  endRect,
  onComplete,
}: {
  type: MemoType;
  startRect: DOMRect;
  endRect: DOMRect;
  onComplete: () => void;
}) {
  const cfg = memoConfig[type];
  const style = flashcardStyle[type];
  const Icon = cfg.icon;

  const midX = (startRect.left + endRect.left) / 2;
  const midY = Math.min(startRect.top, endRect.top) - 60;

  return (
    <motion.div
      className="fixed z-50 pointer-events-none"
      initial={{
        left: startRect.left,
        top: startRect.top,
        scale: 1,
        opacity: 1,
      }}
      animate={{
        left: [startRect.left, midX, endRect.left],
        top: [startRect.top, midY, endRect.top],
        scale: [1, 1.2, 0.8],
        opacity: [1, 1, 0],
      }}
      transition={{
        duration: 0.5,
        ease: [0.22, 1, 0.36, 1],
      }}
      onAnimationComplete={onComplete}
    >
      <div className={`flex items-center gap-1 px-2 py-1 rounded-lg border border-border ${style.bg} shadow-lg`}>
        <Icon className={`w-3 h-3 ${style.iconColor}`} />
        <span className={`text-xs font-medium ${style.iconColor}`}>{cfg.label}</span>
      </div>
    </motion.div>
  );
}

/* ─── MemoFlashcard (single card) ────────────── */

export function MemoFlashcard({
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
      <div className={`flex items-center gap-1.5 px-2.5 pt-2 pb-1 ${style.bg} rounded-t-[9px]`}>
        <Icon className={`w-3 h-3 ${style.iconColor}`} />
        <span className={`text-xs font-semibold ${style.iconColor}`}>
          {cfg.label}
        </span>
      </div>

      <div className="flex-1 px-2.5 py-1.5 min-h-0">
        <p className="text-xs text-ink leading-snug line-clamp-2">
          {memo.text}
        </p>
      </div>

      <div className="flex items-center justify-end px-2.5 pb-1.5">
        <span className="text-xs text-ink-tertiary tabular-nums font-mono">
          {formatTime(memo.timestamp)}
        </span>
      </div>
    </motion.button>
  );
}

/* ─── MemoNotepadOverlay (expanded detail) ───── */

export function MemoNotepadOverlay({
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

/* ─── MemoTray (collapsible from bottom bar) ── */

export const MemoTray = forwardRef<
  HTMLDivElement,
  {
    memos: DisplayMemo[];
    onOpenMemo: (id: string) => void;
  }
>(({ memos, onOpenMemo }, ref) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
    }
  }, [memos.length]);

  return (
    <motion.div
      ref={ref}
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
});

MemoTray.displayName = 'MemoTray';

/* ─── Re-export shortcut order for parent hook ── */
export { memoShortcutOrder };
