import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Crown, Users, Brain, Layers, Zap,
  ChevronDown, ChevronRight, Lightbulb,
} from 'lucide-react';
import { ClaimCard } from './ClaimCard';
import type { Claim, DimensionFeedback, DimensionImprovement, EvidenceRef, FeedbackReport } from './types';

const DIMENSION_ICONS: Record<string, typeof Crown> = {
  leadership: Crown,
  collaboration: Users,
  logic: Brain,
  structure: Layers,
  initiative: Zap,
};

export function DimensionSection({
  dim,
  report,
  onClaimEdit,
  onEvidenceClick,
  onNeedsEvidence,
  getFootnoteIndex,
  onFootnoteClick,
  dimensionImprovement,
  onInlineEdit,
}: {
  dim: DimensionFeedback;
  report: FeedbackReport;
  onClaimEdit: (claim: Claim) => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidence: (claim: Claim) => void;
  getFootnoteIndex?: (evidenceId: string) => number;
  onFootnoteClick?: (evidenceId: string) => void;
  dimensionImprovement?: DimensionImprovement;
  onInlineEdit?: (fieldPath: string, newValue: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = DIMENSION_ICONS[dim.dimension] ?? Layers;

  const strengthCount = dim.claims.filter((c) => c.category === 'strength').length;
  const riskCount = dim.claims.filter((c) => c.category === 'risk').length;
  const actionCount = dim.claims.filter((c) => c.category === 'action').length;

  return (
    <div className="mb-2 last:mb-0">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 w-full py-2 px-1 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
      >
        {expanded
          ? <ChevronDown className="w-3.5 h-3.5 text-ink-tertiary" />
          : <ChevronRight className="w-3.5 h-3.5 text-ink-tertiary" />
        }
        <Icon className="w-4 h-4 text-accent" />
        <div className="flex items-center gap-2 flex-1 text-left">
          <span className="text-sm font-semibold text-ink">
            {dim.label_zh ?? (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1))}
          </span>
          {dim.score !== undefined && (
            <span className={`text-sm font-mono ${dim.score < 4 ? 'text-red-500' : dim.score >= 8 ? 'text-accent' : 'text-secondary'}`}>
              {typeof dim.score === 'number' ? dim.score.toFixed(1) : dim.score}
            </span>
          )}
          {dim.not_applicable && <span className="text-xs text-secondary/50">不适用</span>}
        </div>
        <span className="text-xs text-ink-tertiary">
          {strengthCount > 0 && <span className="text-success">{strengthCount}S</span>}
          {riskCount > 0 && <span className="ml-1.5 text-warning">{riskCount}R</span>}
          {actionCount > 0 && <span className="ml-1.5 text-blue-600">{actionCount}A</span>}
        </span>
      </button>
      {dim.score_rationale && (
        <p className="text-xs text-secondary mt-0.5 pl-8">{dim.score_rationale}</p>
      )}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pl-6 pb-2">
              {dim.claims.map((claim) => {
                const claimImprovement = report.improvements?.claims.find(
                  (ci) => ci.claim_id === claim.id,
                );
                return (
                  <ClaimCard
                    key={claim.id}
                    claim={claim}
                    report={report}
                    onEditClick={() => onClaimEdit(claim)}
                    onEvidenceClick={onEvidenceClick}
                    onNeedsEvidenceClick={() => onNeedsEvidence(claim)}
                    getFootnoteIndex={getFootnoteIndex}
                    onFootnoteClick={onFootnoteClick}
                    improvement={claimImprovement}
                    onInlineEdit={onInlineEdit}
                  />
                );
              })}
              {dimensionImprovement && (
                <div className="border-l-2 border-blue-300 bg-blue-50/30 rounded-r-lg p-3 mt-2">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <Lightbulb className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-semibold text-blue-800">维度改进建议</span>
                  </div>
                  <p className="text-sm text-ink-secondary leading-relaxed mb-2">
                    {dimensionImprovement.advice}
                  </p>
                  {dimensionImprovement.framework && (
                    <p className="text-xs text-blue-700 font-medium mb-2">
                      推荐框架: {dimensionImprovement.framework}
                    </p>
                  )}
                  {dimensionImprovement.example_response && (
                    <div className="bg-white/60 rounded p-2 mt-1">
                      <p className="text-xs text-secondary mb-1">示范回答:</p>
                      <p className="text-sm text-ink italic leading-relaxed">
                        &quot;{dimensionImprovement.example_response}&quot;
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
