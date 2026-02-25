import { Target, ArrowRight } from 'lucide-react';

type Props = {
  items: Array<{
    action: string;
    practice_method: string;
    expected_outcome: string;
    related_claim_id?: string;
  }>;
};

export function ActionPlanCard({ items }: Props) {
  if (items.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        30-Day Action Plan
      </h4>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="border border-border rounded-[--radius-card] p-3">
            <div className="flex items-start gap-2">
              <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent text-white text-xs font-bold shrink-0">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium text-ink">{item.action}</p>
                <div className="mt-1.5 flex items-start gap-1.5 text-xs text-ink-secondary">
                  <Target className="w-3.5 h-3.5 shrink-0 mt-0.5 text-accent" />
                  <span>{item.practice_method}</span>
                </div>
                <div className="mt-1 flex items-start gap-1.5 text-xs text-ink-tertiary">
                  <ArrowRight className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  <span>{item.expected_outcome}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
