import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, Filter } from 'lucide-react';

/** Single transcript utterance from ResultV2. */
export type TranscriptUtterance = {
  utterance_id: string;
  speaker_name: string | null;
  text: string;
  start_ms: number;
  end_ms: number;
};

/** Map from utterance_id → evidence IDs that reference it. */
export type UtteranceEvidenceMap = Record<string, string[]>;

type Props = {
  transcript: TranscriptUtterance[];
  evidenceMap: UtteranceEvidenceMap;
  onEvidenceBadgeClick?: (evidenceId: string) => void;
  scrollToUtteranceId?: string | null;
  highlightedUtteranceIds?: Set<string>;
};

const SPEAKER_COLORS = [
  'text-blue-600',
  'text-emerald-600',
  'text-amber-600',
  'text-purple-600',
  'text-rose-600',
  'text-cyan-600',
];

const SPEAKER_BG = [
  'bg-blue-50',
  'bg-emerald-50',
  'bg-amber-50',
  'bg-purple-50',
  'bg-rose-50',
  'bg-cyan-50',
];

function formatTime(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Merge consecutive utterances from the same speaker into groups. */
type UtteranceGroup = {
  speaker: string;
  speakerIndex: number;
  startMs: number;
  items: TranscriptUtterance[];
  hasEvidence: boolean;
  evidenceIds: string[];
};

export function TranscriptSection({ transcript, evidenceMap, onEvidenceBadgeClick, scrollToUtteranceId, highlightedUtteranceIds }: Props) {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeSpeaker, setActiveSpeaker] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  // Extract unique speakers with stable color index
  const speakerList = useMemo(() => {
    const seen = new Map<string, number>();
    for (const u of transcript) {
      const name = u.speaker_name || 'Unknown';
      if (!seen.has(name)) seen.set(name, seen.size);
    }
    return Array.from(seen.entries()).map(([name, idx]) => ({ name, colorIndex: idx % SPEAKER_COLORS.length }));
  }, [transcript]);

  const speakerColorMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of speakerList) map.set(s.name, s.colorIndex);
    return map;
  }, [speakerList]);

  // Group consecutive utterances by speaker, apply filters
  const groups = useMemo(() => {
    let filtered = transcript;

    // Speaker filter
    if (activeSpeaker) {
      filtered = filtered.filter(u => (u.speaker_name || 'Unknown') === activeSpeaker);
    }

    // Text search filter
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(u => u.text.toLowerCase().includes(q));
    }

    // Merge consecutive same-speaker
    const result: UtteranceGroup[] = [];
    for (const u of filtered) {
      const speaker = u.speaker_name || 'Unknown';
      const last = result[result.length - 1];
      const evIds = evidenceMap[u.utterance_id] ?? [];
      if (last && last.speaker === speaker) {
        last.items.push(u);
        if (evIds.length > 0) {
          last.hasEvidence = true;
          last.evidenceIds.push(...evIds);
        }
      } else {
        result.push({
          speaker,
          speakerIndex: speakerColorMap.get(speaker) ?? 0,
          startMs: u.start_ms,
          items: [u],
          hasEvidence: evIds.length > 0,
          evidenceIds: [...evIds],
        });
      }
    }
    return result;
  }, [transcript, activeSpeaker, searchQuery, evidenceMap, speakerColorMap]);

  const virtualizer = useVirtualizer({
    count: groups.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 72,
    overscan: 10,
  });

  // Scroll to a specific utterance when scrollToUtteranceId changes
  const scrolledRef = useRef<string | null>(null);

  useEffect(() => {
    if (scrollToUtteranceId && scrollToUtteranceId !== scrolledRef.current) {
      const idx = groups.findIndex(g => g.items.some(u => u.utterance_id === scrollToUtteranceId));
      if (idx >= 0) {
        virtualizer.scrollToIndex(idx, { align: 'center' });
        scrolledRef.current = scrollToUtteranceId;
      }
    }
  }, [scrollToUtteranceId, groups, virtualizer]);

  const highlightText = useCallback((text: string) => {
    if (!searchQuery.trim()) return text;
    const q = searchQuery.trim();
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    const parts = text.split(regex);
    return parts.map((part, i) =>
      regex.test(part) ? <mark key={i} className="bg-yellow-200 rounded-sm px-0.5">{part}</mark> : part
    );
  }, [searchQuery]);

  return (
    <div className="space-y-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setActiveSpeaker(null)}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
            !activeSpeaker ? 'bg-accent text-white border-accent' : 'border-border text-ink-secondary hover:bg-surface-hover'
          }`}
        >
          All
        </button>
        {speakerList.map(s => (
          <button
            key={s.name}
            onClick={() => setActiveSpeaker(activeSpeaker === s.name ? null : s.name)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
              activeSpeaker === s.name
                ? `${SPEAKER_BG[s.colorIndex]} ${SPEAKER_COLORS[s.colorIndex]} border-current`
                : 'border-border text-ink-secondary hover:bg-surface-hover'
            }`}
          >
            {s.name}
          </button>
        ))}

        {/* Search */}
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-secondary" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search transcript..."
            className="pl-7 pr-3 py-1 text-xs border border-border rounded-[--radius-button] bg-white focus:outline-none focus:ring-1 focus:ring-accent w-48"
          />
        </div>
      </div>

      {/* Empty state */}
      {groups.length === 0 && (
        <div className="text-center text-ink-secondary text-sm py-8">
          {transcript.length === 0 ? 'No transcript data available.' : 'No matching utterances.'}
        </div>
      )}

      {/* Virtualized list */}
      <div
        ref={parentRef}
        className="h-[500px] overflow-y-auto rounded-[--radius-card] border border-border bg-white"
      >
        <div
          style={{ height: `${virtualizer.getTotalSize()}px`, width: '100%', position: 'relative' }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const group = groups[virtualRow.index];
            const isHighlighted = scrollToUtteranceId && group.items.some(u => u.utterance_id === scrollToUtteranceId);
            const isGroupHighlighted = highlightedUtteranceIds && highlightedUtteranceIds.size > 0 &&
              group.items.some(u => highlightedUtteranceIds.has(u.utterance_id));
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
                className={`px-4 py-2 border-b border-border/50 ${
                  group.hasEvidence ? 'bg-accent/5' : ''
                } ${isHighlighted ? 'ring-2 ring-accent/30 ring-inset' : ''} ${
                  isGroupHighlighted ? 'border-l-2 border-l-accent bg-accent/5' : ''
                }`}
              >
                {/* Speaker header */}
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs text-ink-secondary font-mono">{formatTime(group.startMs)}</span>
                  <span className={`w-2 h-2 rounded-full ${SPEAKER_BG[group.speakerIndex]} ${SPEAKER_COLORS[group.speakerIndex]} ring-1 ring-current`} />
                  <span className={`text-sm font-medium ${SPEAKER_COLORS[group.speakerIndex]}`}>
                    {group.speaker}
                  </span>
                  {group.hasEvidence && (
                    <div className="flex gap-1 ml-auto">
                      {[...new Set(group.evidenceIds)].slice(0, 3).map(eid => (
                        <button
                          key={eid}
                          onClick={() => onEvidenceBadgeClick?.(eid)}
                          className="px-1.5 py-0.5 text-[10px] font-medium bg-accent/10 text-accent rounded cursor-pointer hover:bg-accent/20 transition-colors"
                        >
                          {eid.slice(0, 6)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {/* Utterance texts */}
                {group.items.map(u => (
                  <p key={u.utterance_id} className="text-sm text-ink leading-relaxed pl-6">
                    {highlightText(u.text)}
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer count */}
      <div className="text-xs text-ink-secondary text-right">
        {groups.length} groups / {transcript.length} utterances
      </div>
    </div>
  );
}
