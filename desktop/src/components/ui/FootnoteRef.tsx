type FootnoteRefProps = {
  index: number;                     // 1-based
  expanded?: boolean;
  onClick?: () => void;
};

export function FootnoteRef({ index, expanded, onClick }: FootnoteRefProps) {
  return (
    <sup
      className={`cursor-pointer font-medium text-[10px] ml-0.5 transition-colors ${
        expanded ? 'text-white bg-accent rounded-full px-1' : 'text-accent hover:underline'
      }`}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      role="button"
      aria-label={`Footnote ${index}`}
      aria-expanded={expanded}
    >
      {index}
    </sup>
  );
}
