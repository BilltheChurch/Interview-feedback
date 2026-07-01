import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { MessageSquareText, ChevronLeft, ChevronRight, ArrowDown } from 'lucide-react';
import type {
  CaptionEntry,
  AcsStatus,
  TranscriptSegment,
  PartialTranscript,
} from '../stores/sessionStore';

/** Map a stream role + raw speaker to the display label.
 *
 *  teacher is, by architecture, the interviewer (diarization off). The Worker's
 *  `resolveTeacherIdentity` returns the configured interviewer name (e.g. "Tim")
 *  when setup provided one, so we show that real name (R-A). We only fall back to
 *  the generic "Interviewer" label when the Worker sent a placeholder — empty,
 *  the literal "teacher" stream tag, or "Interviewer" itself.
 *
 *  This stays safe because R1 removed the single-entry-roster → student-name
 *  branch on the Worker side: a non-placeholder teacher speaker can only be the
 *  configured interviewer name, never a student's. Students trust the
 *  diarization label. */
function speakerLabel(role: 'teacher' | 'students', speaker: string | null): string {
  if (role !== 'teacher') return speaker ?? 'Candidate';
  const s = (speaker ?? '').trim();
  if (s === '' || s.toLowerCase() === 'teacher' || s === 'Interviewer') return 'Interviewer';
  return s;
}

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

/** R4: a live, unfinalized caption row derived from a partial transcript. */
type PartialRow = {
  key: string;
  speaker: string;
  text: string;
};

export function CaptionPanel({
  captions: acsCaptions,
  acsStatus,
  transcriptSegments = [],
  partialTranscripts = {},
}: {
  captions: CaptionEntry[];
  acsStatus: AcsStatus;
  transcriptSegments?: TranscriptSegment[];
  partialTranscripts?: Record<string, PartialTranscript>;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Unified caption source: prefer ACS/Teams captions; otherwise render the universal
  // realtime transcript segments (Speechmatics/DashScope downlink, A2/B5) as captions so
  // non-Teams meetings still get live captions.
  const usingAcs = acsCaptions.length > 0;
  const captions = useMemo<CaptionEntry[]>(() => {
    if (usingAcs) return acsCaptions;
    return transcriptSegments.map((seg) => ({
      id: seg.id,
      // teacher → show the Worker-supplied interviewer name (real name if setup
      // provided one, else the generic "Interviewer" placeholder); students →
      // the diarization-derived speaker label. See speakerLabel.
      speaker: speakerLabel(seg.role, seg.speaker),
      text: seg.text,
      timestamp: seg.tsMs,
      language: '',
    }));
  }, [usingAcs, acsCaptions, transcriptSegments]);

  // R4: live partial rows (unfinalized). Only shown on the universal transcript path — ACS
  // has no partial concept. Rendered after the settled captions, visually distinct, so the
  // interviewer sees words appear in real time before the line settles into a final.
  const partialRows = useMemo<PartialRow[]>(() => {
    if (usingAcs) return [];
    return Object.entries(partialTranscripts)
      .filter(([, p]) => p.text.trim().length > 0)
      .map(([key, p]) => ({
        key,
        speaker: speakerLabel(p.role, p.speaker),
        text: p.text,
      }));
  }, [usingAcs, partialTranscripts]);

  // Build stable speaker → color index map (settled + partial speakers share the palette)
  const speakerColorMap = useMemo(() => {
    const map = new Map<string, number>();
    let idx = 0;
    const register = (speaker: string) => {
      if (!map.has(speaker)) {
        map.set(speaker, idx % SPEAKER_COLORS.length);
        idx++;
      }
    };
    for (const cap of captions) register(cap.speaker);
    for (const row of partialRows) register(row.speaker);
    return map;
  }, [captions, partialRows]);

  const groups = useMemo(() => groupCaptions(captions), [captions]);

  // Auto-scroll to bottom when new captions OR partials arrive (only if already at bottom).
  // Partials update in place very frequently, so their text (not just count) is a dep.
  const partialSignature = partialRows.map((r) => `${r.key}:${r.text}`).join('|');
  useEffect(() => {
    if (isAtBottom && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [captions.length, partialSignature, isAtBottom]);

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

  const hasContent = captions.length > 0 || partialRows.length > 0;

  // Don't render only when there is nothing to show: ACS off AND no captions AND no
  // in-progress partial line.
  if (acsStatus === 'off' && !hasContent) return null;

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
        {!hasContent ? (
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
          <>
          {groups.map((group) => {
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
          })}

          {/* R4: live partial (unfinalized) rows — visually distinct: muted, italic, with a
              trailing ellipsis and a pulsing dot to signal "still being transcribed". */}
          {partialRows.map((row) => {
            const colorIdx = speakerColorMap.get(row.speaker) ?? 0;
            const dotColor = SPEAKER_DOT_COLORS[colorIdx];
            const textColor = SPEAKER_COLORS[colorIdx].split(' ')[0];
            return (
              <div
                key={`partial-${row.key}`}
                data-testid={`partial-${row.key}`}
                className="flex flex-col gap-0.5 opacity-70"
              >
                <div className="flex items-center gap-1 mt-0.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${dotColor} shrink-0 animate-pulse`} />
                  <span className={`text-xs font-medium ${textColor} truncate`}>
                    {row.speaker}
                  </span>
                </div>
                <p className="text-xs text-ink-tertiary italic leading-relaxed pl-3">
                  {row.text}
                  <span className="text-ink-tertiary">…</span>
                </p>
              </div>
            );
          })}
          </>
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
            className="absolute bottom-1 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1 rounded-full bg-accent text-on-accent text-xs shadow-md hover:bg-accent-hover transition-colors z-10"
          >
            <ArrowDown className="w-3 h-3" />
            Latest
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
