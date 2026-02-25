import { motion } from 'motion/react';
import { ExternalLink } from 'lucide-react';

type InlineEvidenceCardProps = {
  quote: string;
  speaker: string;
  timestamp: string;          // "08:57"
  confidence: number;         // 0-1
  onViewContext?: () => void;  // 点击"查看上下文" → 跳转 Transcript
};

export function InlineEvidenceCard({ quote, speaker, timestamp, confidence, onViewContext }: InlineEvidenceCardProps) {
  const pct = Math.round(confidence * 100);

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="overflow-hidden"
    >
      <div className="mt-1.5 ml-1 border-l-2 border-accent/30 pl-3 py-1.5">
        <p className="text-xs text-ink leading-relaxed italic">&quot;{quote}&quot;</p>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-secondary">
          <span>{speaker} · {timestamp}</span>
          <span className={pct >= 80 ? 'text-success' : pct >= 60 ? 'text-secondary' : 'text-warning'}>{pct}%</span>
          {onViewContext && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onViewContext(); }}
              className="inline-flex items-center gap-0.5 text-accent hover:underline cursor-pointer"
            >
              查看上下文
              <ExternalLink className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </motion.div>
  );
}
