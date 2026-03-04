import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Pencil } from 'lucide-react';
import { Chip } from '../ui/Chip';
import { ConfidenceBadge } from '../ui/ConfidenceBadge';
import { EvidenceChip } from '../ui/EvidenceChip';
import { FootnoteRef } from '../ui/FootnoteRef';
import { InlineEvidenceCard } from '../ui/InlineEvidenceCard';
import { InlineEditable } from '../ui/InlineEditable';
import type { Claim, EvidenceRef, FeedbackReport, ClaimImprovement } from './types';

export const CATEGORY_BORDER: Record<Claim['category'], string> = {
  strength: 'border-l-emerald-400',
  risk: 'border-l-amber-400',
  action: 'border-l-blue-400',
};

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getEvidenceById(report: FeedbackReport, id: string): EvidenceRef | undefined {
  return report.evidence.find((e) => e.id === id);
}

export function ClaimCard({
  claim,
  report,
  onEditClick,
  onEvidenceClick,
  onNeedsEvidenceClick,
  getFootnoteIndex,
  onFootnoteClick,
  improvement,
  onInlineEdit,
}: {
  claim: Claim;
  report: FeedbackReport;
  onEditClick: () => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidenceClick: () => void;
  getFootnoteIndex?: (evidenceId: string) => number;
  onFootnoteClick?: (evidenceId: string) => void;
  improvement?: ClaimImprovement;
  onInlineEdit?: (fieldPath: string, newValue: string) => void;
}) {
  const hasFootnotes = !!getFootnoteIndex;
  const [expandedRef, setExpandedRef] = useState<string | null>(null);

  return (
    <div
      className={`group border border-border border-l-4 ${CATEGORY_BORDER[claim.category]} rounded-[--radius-button] p-3 hover:bg-surface-hover transition-colors`}
    >
      <div className="flex items-start gap-2 mb-2">
        <div className="text-sm text-ink flex-1 leading-relaxed">
          {onInlineEdit ? (
            <InlineEditable
              value={claim.text}
              onSave={(v) => onInlineEdit(`claims.${claim.id}.text`, v)}
              as="span"
              className="text-sm text-ink leading-relaxed"
            />
          ) : (
            claim.text
          )}
          {hasFootnotes && (claim.evidence_refs ?? []).map((refId) => {
            const idx = getFootnoteIndex(refId);
            if (idx === 0) return null;
            return (
              <FootnoteRef
                key={refId}
                index={idx}
                expanded={expandedRef === refId}
                onClick={() => setExpandedRef(expandedRef === refId ? null : refId)}
              />
            );
          })}
        </div>
        <ConfidenceBadge score={claim.confidence} />
        <button
          type="button"
          onClick={onEditClick}
          className="text-ink-tertiary opacity-0 group-hover:opacity-100 hover:text-accent transition-all cursor-pointer shrink-0 mt-0.5"
          aria-label="Edit claim"
        >
          <Pencil className="w-3.5 h-3.5" />
        </button>
      </div>

      <AnimatePresence>
        {expandedRef && (() => {
          const ev = getEvidenceById(report, expandedRef);
          if (!ev) return null;
          return (
            <InlineEvidenceCard
              key={expandedRef}
              quote={ev.text}
              speaker={ev.speaker}
              timestamp={formatTimestamp(ev.timestamp_ms)}
              confidence={ev.confidence}
              onViewContext={() => onFootnoteClick?.(expandedRef)}
            />
          );
        })()}
      </AnimatePresence>

      {claim.evidence_refs.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onNeedsEvidenceClick} className="cursor-pointer">
            <Chip variant="error">Needs Evidence</Chip>
          </button>
        </div>
      )}

      {!hasFootnotes && claim.evidence_refs.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {claim.evidence_refs.map((refId) => {
            const ev = getEvidenceById(report, refId);
            if (!ev) return null;
            return (
              <motion.div
                key={refId}
                whileHover={{ scale: 1.03 }}
                transition={{ type: 'spring', stiffness: 400, damping: 17 }}
              >
                <EvidenceChip
                  timestamp={formatTimestamp(ev.timestamp_ms)}
                  speaker={ev.speaker}
                  quote={ev.text}
                  onClick={() => onEvidenceClick(ev)}
                  className={ev.weak ? 'border-dashed' : ''}
                />
              </motion.div>
            );
          })}
          {claim.evidence_refs.some((refId) => {
            const ev = getEvidenceById(report, refId);
            return ev?.weak;
          }) && (
            <Chip variant="warning" className="text-xs">weak</Chip>
          )}
        </div>
      )}

      {hasFootnotes && claim.evidence_refs.some((refId) => {
        const ev = getEvidenceById(report, refId);
        return ev?.weak;
      }) && (
        <Chip variant="warning" className="text-xs mt-1">weak evidence</Chip>
      )}

      {improvement && (
        <div className="border-t border-border/50 pt-2 mt-2">
          <p className="text-xs text-blue-700 font-medium mb-1">改进建议</p>
          <p className="text-sm text-ink-secondary leading-relaxed">{improvement.advice}</p>
          {improvement.suggested_wording && (
            <p className="text-sm text-ink italic mt-1">&quot;{improvement.suggested_wording}&quot;</p>
          )}
          {improvement.before_after && (
            <div className="mt-2 space-y-1">
              <div className="flex items-start gap-2">
                <span className="text-xs text-red-400 font-medium shrink-0 mt-0.5">Before</span>
                <p className="text-xs text-red-400/80 line-through">{improvement.before_after.before}</p>
              </div>
              <div className="flex items-start gap-2">
                <span className="text-xs text-emerald-600 font-medium shrink-0 mt-0.5">After</span>
                <p className="text-xs text-emerald-700">{improvement.before_after.after}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
