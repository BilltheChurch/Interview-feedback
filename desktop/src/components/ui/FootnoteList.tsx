type FootnoteEntry = {
  index: number;
  timestamp: string;                 // "02:20"
  speaker: string;
  quote: string;                     // max 80 chars
  evidenceId: string;
  onClick?: () => void;              // Jump to transcript
};

type FootnoteListProps = {
  entries: FootnoteEntry[];
  onFootnoteClick?: (evidenceId: string) => void;
};

export function FootnoteList({ entries, onFootnoteClick }: FootnoteListProps) {
  if (entries.length === 0) return null;
  return (
    <div className="mt-4 pt-3 border-t border-border/50 space-y-1.5">
      {entries.map((e) => (
        <div
          key={e.index}
          role="button"
          tabIndex={0}
          className="flex gap-2 text-xs text-secondary cursor-pointer hover:text-ink transition-colors"
          onClick={() => onFootnoteClick?.(e.evidenceId)}
          onKeyDown={(ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              onFootnoteClick?.(e.evidenceId);
            }
          }}
        >
          <span className="text-accent font-medium shrink-0">{e.index}</span>
          <span className="text-secondary/60">[{e.timestamp}]</span>
          <span className="font-medium">{e.speaker}:</span>
          <span className="truncate italic">&quot;{e.quote}&quot;</span>
        </div>
      ))}
    </div>
  );
}

export type { FootnoteEntry, FootnoteListProps };
