type FootnoteRefProps = {
  index: number;                     // 1-based
  onClick?: () => void;
};

export function FootnoteRef({ index, onClick }: FootnoteRefProps) {
  return (
    <sup
      className="cursor-pointer text-accent hover:underline font-medium text-[10px] ml-0.5"
      onClick={onClick}
      role="button"
      aria-label={`Footnote ${index}`}
    >
      {index}
    </sup>
  );
}
