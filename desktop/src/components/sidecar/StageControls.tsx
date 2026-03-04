import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronRight, Check } from 'lucide-react';
import { Button } from '../ui/Button';
import { sanitizeHtml } from '../../lib/sanitize';
import type { StageArchive } from '../../stores/sessionStore';
import { memoConfig, flashcardStyle, type DisplayMemo } from './types';

/* ─── CollapsibleSection ─────────────────────── */

export function CollapsibleSection({
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
          <ChevronRight className="w-3 h-3 text-ink-tertiary group-hover:text-ink-secondary transition-colors duration-150 rotate-90" />
        ) : (
          <ChevronRight className="w-3 h-3 text-ink-tertiary group-hover:text-ink-secondary transition-colors duration-150" />
        )}
      </button>
      {open && <div className="flex flex-col gap-1.5">{children}</div>}
    </div>
  );
}

/* ─── FlowControl ────────────────────────────── */

export function FlowControl({
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

/* ─── StageTimelineEntry ─────────────────────── */

function StageTimelineEntry({
  archive,
  stageMemos,
}: {
  archive: StageArchive;
  stageMemos: DisplayMemo[];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasFreeform = !!(archive.freeformHtml || archive.freeformText.trim());
  const noteCount = stageMemos.length + (hasFreeform ? 1 : 0);

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-1.5 text-left hover:bg-surface-hover/50 transition-colors duration-150"
      >
        <motion.div
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.15 }}
        >
          <ChevronRight className="w-3 h-3 text-ink-tertiary" />
        </motion.div>
        <span className="text-xs font-semibold text-ink-tertiary">
          {archive.stageName}
        </span>
        <span className="text-xs text-ink-tertiary/70 tabular-nums">
          ({noteCount} note{noteCount !== 1 ? 's' : ''})
        </span>
        <span className="text-xs text-ink-tertiary/50 tabular-nums font-mono ml-auto">
          {new Date(archive.archivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-2 flex flex-col gap-1.5">
              {archive.freeformHtml ? (
                <div
                  className="text-sm text-ink-secondary bg-surface/50 rounded-lg px-2.5 py-1.5 leading-relaxed prose prose-sm max-w-none memo-highlight-view"
                  dangerouslySetInnerHTML={{ __html: sanitizeHtml(archive.freeformHtml) }}
                />
              ) : archive.freeformText.trim() ? (
                <p className="text-sm text-ink-secondary bg-surface/50 rounded-lg px-2.5 py-1.5 whitespace-pre-wrap leading-relaxed">
                  {archive.freeformText}
                </p>
              ) : null}

              {stageMemos.map((m) => {
                const cfg = memoConfig[m.type];
                const style = flashcardStyle[m.type];
                const Icon = cfg.icon;
                return (
                  <div
                    key={m.id}
                    className={`flex items-start gap-1.5 px-2.5 py-1 rounded-lg text-xs ${style.bg}`}
                  >
                    <Icon className={`w-3 h-3 mt-0.5 shrink-0 ${style.iconColor}`} />
                    <span className="text-ink-secondary leading-snug">{m.text}</span>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ─── StageTimeline ──────────────────────────── */

export function StageTimeline({
  archives,
  allMemos,
}: {
  archives: StageArchive[];
  allMemos: DisplayMemo[];
}) {
  if (archives.length === 0) return null;

  return (
    <div className="border-t border-border/50 bg-ink/[0.015] shrink-0 max-h-[200px] overflow-y-auto">
      {archives.map((archive) => {
        const stageMemos = allMemos.filter(
          (m) => archive.memoIds.includes(m.id),
        );
        return (
          <StageTimelineEntry
            key={`${archive.stageIndex}-${archive.archivedAt}`}
            archive={archive}
            stageMemos={stageMemos}
          />
        );
      })}
    </div>
  );
}
