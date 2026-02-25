import { useState } from 'react';
import { ChevronDown, ChevronRight, Target, Lightbulb } from 'lucide-react';

type Props = {
  quality: {
    coverage_ratio: number;
    follow_up_depth: number;
    structure_score: number;
    suggestions: string;
  };
};

export function InterviewQualityCard({ quality }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-4 border border-border/50 rounded-[--radius-card] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-surface-hover transition-colors cursor-pointer"
      >
        {open ? <ChevronDown className="w-4 h-4 text-ink-tertiary" /> : <ChevronRight className="w-4 h-4 text-ink-tertiary" />}
        <Target className="w-4 h-4 text-ink-secondary" />
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Interview Quality</span>
        <span className="ml-auto text-xs text-ink-tertiary">{quality.structure_score.toFixed(1)}/10</span>
      </button>
      {open && (
        <div className="px-4 pb-3 pt-1 space-y-2 border-t border-border/50">
          <div className="grid grid-cols-3 gap-3">
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Coverage</p>
              <p className="text-sm font-semibold text-ink">{Math.round(quality.coverage_ratio * 100)}%</p>
            </div>
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Follow-ups</p>
              <p className="text-sm font-semibold text-ink">{quality.follow_up_depth}</p>
            </div>
            <div className="text-center p-2 bg-surface rounded">
              <p className="text-xs text-ink-tertiary">Structure</p>
              <p className="text-sm font-semibold text-ink">{quality.structure_score.toFixed(1)}</p>
            </div>
          </div>
          <div className="flex items-start gap-2 text-xs text-ink-secondary">
            <Lightbulb className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
            <span>{quality.suggestions}</span>
          </div>
        </div>
      )}
    </div>
  );
}
