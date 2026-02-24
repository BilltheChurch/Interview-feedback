import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquareText, ChevronLeft, ChevronRight, ArrowDown } from 'lucide-react';
import type { CaptionEntry, AcsStatus } from '../stores/sessionStore';

/* ── Speaker color palette (6 colors, cycling) ── */

const SPEAKER_COLORS = [
  'text-blue-700 bg-blue-50',
  'text-emerald-700 bg-emerald-50',
  'text-purple-700 bg-purple-50',
  'text-amber-700 bg-amber-50',
  'text-rose-700 bg-rose-50',
  'text-cyan-700 bg-cyan-50',
];

const SPEAKER_DOT_COLORS = [
  'bg-blue-400',
  'bg-emerald-400',
  'bg-purple-400',
  'bg-amber-400',
  'bg-rose-400',
  'bg-cyan-400',
];

/* ── Group consecutive captions by same speaker ── */

type CaptionGroup = {
  speaker: string;
  entries: CaptionEntry[];
};

function groupCaptions(captions: CaptionEntry[]): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  for (const cap of captions) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === cap.speaker) {
      last.entries.push(cap);
    } else {
      groups.push({ speaker: cap.speaker, entries: [cap] });
    }
  }
  return groups;
}

/* ── CaptionPanel ── */

export function CaptionPanel({
  captions,
  acsStatus,
}: {
  captions: CaptionEntry[];
  acsStatus: AcsStatus;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Build stable speaker → color index map
  const speakerColorMap = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    for (const cap of captions) {
      if (!map.has(cap.speaker)) {
        map.set(cap.speaker, idx % SPEAKER_COLORS.length);
        idx++;
      }
    }
    return map;
  }, [captions]);

  const groups = useMemo(() => groupCaptions(captions), [captions]);

  // Auto-scroll to bottom when new captions arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [captions.length, isAtBottom]);

  // Track scroll position to detect manual scroll-up
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsAtBottom(atBottom);
  };

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      setIsAtBottom(true);
    }
  };

  // Don't render at all if ACS is off
  if (acsStatus === 'off') return null;

  // Collapsed state — narrow icon bar
  if (collapsed) {
    return (
      <div className="w-9 shrink-0 border-r border-border bg-surface flex flex-col items-center pt-2">
        <button
          onClick={() => setCollapsed(false)}
          className="p-1.5 rounded-lg text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors"
          title="Show captions"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
        <MessageSquareText className="w-4 h-4 text-ink-tertiary mt-2" />
        {captions.length > 0 && (
          <span className="text-xs text-ink-tertiary mt-1 tabular-nums">{captions.length}</span>
        )}
      </div>
    );
  }

  // Expanded state
  return (
    <div className="w-60 shrink-0 border-r border-border bg-surface flex flex-col relative">
      {/* Panel header */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border/50">
        <div className="flex items-center gap-1.5">
          <MessageSquareText className="w-3.5 h-3.5 text-ink-tertiary" />
          <span className="text-xs font-medium text-ink-secondary">Captions</span>
          {captions.length > 0 && (
            <span className="text-xs text-ink-tertiary tabular-nums">({captions.length})</span>
          )}
        </div>
        <button
          onClick={() => setCollapsed(true)}
          className="p-1 rounded text-ink-tertiary hover:text-ink-secondary hover:bg-surface-hover transition-colors"
          title="Hide captions"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Caption list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-2 py-1.5 flex flex-col gap-1.5"
      >
        {captions.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center px-3 py-6">
            <MessageSquareText className="w-6 h-6 text-ink-tertiary/40 mb-2" />
            <p className="text-xs text-ink-tertiary">
              {acsStatus === 'connecting' ? 'Connecting to Teams...' :
               acsStatus === 'connected' ? 'Waiting for captions...' :
               acsStatus === 'error' ? 'Caption connection error' :
               'Captions will appear here'}
            </p>
          </div>
        ) : (
          groups.map((group, gi) => {
            const colorIdx = speakerColorMap.get(group.speaker) ?? 0;
            const dotColor = SPEAKER_DOT_COLORS[colorIdx];
            const textColor = SPEAKER_COLORS[colorIdx].split(' ')[0];

            return (
              <div key={`${group.speaker}-${group.entries[0].id}`} className="flex flex-col gap-0.5">
                {/* Speaker name */}
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0`} />
                  <span className={`text-xs font-medium ${textColor} truncate`}>
                    {group.speaker}
                  </span>
                </div>
                {/* Grouped caption texts */}
                {group.entries.map((entry) => (
                  <p key={entry.id} className="text-xs text-ink-secondary leading-relaxed pl-3">
                    {entry.text}
                  </p>
                ))}
              </div>
            );
          })
        )}
      </div>

      {/* Jump to bottom button */}
      <AnimatePresence>
        {!isAtBottom && captions.length > 0 && (
          <motion.button
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 4 }}
            onClick={scrollToBottom}
            className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-accent text-white text-xs shadow-md hover:bg-accent-hover transition-colors z-10"
          >
            <ArrowDown className="w-3 h-3" />
            Latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
