type EvidenceChipProps = {
  timestamp: string;
  speaker: string;
  quote: string;
  onClick?: () => void;
  className?: string;
};

export function EvidenceChip({ timestamp, speaker, quote, onClick, className = '' }: EvidenceChipProps) {
  const truncated = quote.length > 40 ? quote.slice(0, 40) + '...' : quote;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`
        inline-flex items-center gap-1.5 rounded-[--radius-pill] border
        bg-accent-soft border-accent/20 text-accent
        text-xs px-2.5 py-1 cursor-pointer hover:bg-accent/10
        transition-colors duration-150
        ${className}
      `}
    >
      <span className="font-mono">[{timestamp}]</span>
      <span className="font-sans font-medium">{speaker}:</span>
      <span className="font-sans">"{truncated}"</span>
    </button>
  );
}
