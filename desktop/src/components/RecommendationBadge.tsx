import { ThumbsUp, ThumbsDown, HelpCircle } from 'lucide-react';

const CONFIG = {
  recommend: { label: '\u63A8\u8350\u5F55\u7528', icon: ThumbsUp, bg: 'bg-emerald-50 border-emerald-200', text: 'text-emerald-700' },
  tentative: { label: '\u5F85\u5B9A', icon: HelpCircle, bg: 'bg-amber-50 border-amber-200', text: 'text-amber-700' },
  not_recommend: { label: '\u4E0D\u63A8\u8350', icon: ThumbsDown, bg: 'bg-red-50 border-red-200', text: 'text-red-700' },
};

type Props = {
  recommendation: { decision: string; confidence: number; rationale: string; context_type: string };
};

export function RecommendationBadge({ recommendation: rec }: Props) {
  const config = CONFIG[rec.decision as keyof typeof CONFIG] || CONFIG.tentative;
  const Icon = config.icon;

  return (
    <div className={`flex items-start gap-3 p-4 rounded-[--radius-card] border ${config.bg} mb-4`}>
      <Icon className={`w-5 h-5 ${config.text} shrink-0 mt-0.5`} />
      <div>
        <div className="flex items-center gap-2">
          <span className={`text-sm font-semibold ${config.text}`}>{config.label}</span>
          <span className="text-xs text-ink-tertiary">({Math.round(rec.confidence * 100)}% confidence)</span>
        </div>
        <p className="text-sm text-ink-secondary mt-1">{rec.rationale}</p>
      </div>
    </div>
  );
}
