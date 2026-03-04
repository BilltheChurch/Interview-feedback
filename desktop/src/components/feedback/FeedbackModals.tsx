import { useState } from 'react';
import { AlertTriangle, Plus, Trash2, X, RefreshCw } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { EvidenceChip } from '../ui/EvidenceChip';
import { ConfidenceBadge } from '../ui/ConfidenceBadge';
import { TextArea } from '../ui/TextArea';
import { CATEGORY_BORDER } from './ClaimCard';
import { formatTimestamp, getEvidenceById, getClaimsForEvidence, getSurroundingContext } from './reportUtils';
import type { Claim, EvidenceRef, FeedbackReport } from './types';

const CATEGORY_VARIANT: Record<Claim['category'], 'success' | 'warning' | 'info'> = {
  strength: 'success',
  risk: 'warning',
  action: 'info',
};

const CATEGORY_LABEL: Record<Claim['category'], string> = {
  strength: 'Strength',
  risk: 'Risk',
  action: 'Action Item',
};

/* ─── EvidenceDetailModal ─────────────────────────────── */

export function EvidenceDetailModal({
  open,
  onClose,
  evidence,
  report,
  mode,
  onUseAsEvidence,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  evidence: EvidenceRef | null;
  report: FeedbackReport;
  mode: 'browse' | 'claim-editor';
  onUseAsEvidence?: () => void;
  onRemove?: () => void;
}) {
  if (!evidence) return null;

  const surroundingUtterances = getSurroundingContext(report, evidence.id);
  const refClaims = getClaimsForEvidence(report, evidence.id);

  return (
    <Modal open={open} onClose={onClose} title="Evidence Detail" size="lg">
      <div className="space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-sm text-accent font-medium">
            [{formatTimestamp(evidence.timestamp_ms)}]
          </span>
          <span className="text-sm font-medium text-ink">{evidence.speaker}</span>
          <ConfidenceBadge score={evidence.confidence} />
          {evidence.weak && <Chip variant="warning">Weak Evidence</Chip>}
        </div>

        <div className="bg-accent-soft/50 border border-accent/20 rounded-[--radius-button] p-4">
          <p className="text-sm text-ink leading-relaxed italic">
            &ldquo;{evidence.text}&rdquo;
          </p>
        </div>

        {evidence.weak && evidence.weak_reason && (
          <div className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{evidence.weak_reason}</span>
          </div>
        )}

        {surroundingUtterances.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
              Conversation Context
            </h4>
            <div className="space-y-1.5">
              {surroundingUtterances.map((u) => (
                <div
                  key={u.utterance_id}
                  className={`flex items-start gap-2 text-xs pl-2 border-l-2 rounded-r py-1 ${
                    u.isPartOfEvidence
                      ? 'border-l-accent bg-accent-soft/30 text-ink'
                      : 'border-l-border text-ink-tertiary'
                  }`}
                >
                  <span className="font-mono whitespace-nowrap">[{formatTimestamp(u.start_ms)}]</span>
                  <span className={`font-medium whitespace-nowrap ${u.isPartOfEvidence ? '' : 'text-ink-secondary'}`}>
                    {u.speaker}:
                  </span>
                  <span className={`leading-relaxed ${u.isPartOfEvidence ? 'font-medium' : ''}`}>
                    &ldquo;{u.text}&rdquo;
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {refClaims.length > 0 && (
          <div>
            <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
              Referenced by {refClaims.length} Claim{refClaims.length > 1 ? 's' : ''}
            </h4>
            <div className="space-y-1.5">
              {refClaims.map(({ person, claim }) => (
                <div
                  key={claim.id}
                  className={`flex items-start gap-2 text-sm border-l-4 ${CATEGORY_BORDER[claim.category]} pl-3 py-1`}
                >
                  <span className="text-ink-tertiary text-xs shrink-0 mt-0.5">{person}</span>
                  <span className="text-ink-secondary">{claim.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
          {mode === 'browse' && onUseAsEvidence && (
            <Button size="sm" onClick={onUseAsEvidence}>
              <Plus className="w-3.5 h-3.5" />
              Use as Evidence
            </Button>
          )}
          {mode === 'claim-editor' && onRemove && (
            <Button variant="danger" size="sm" onClick={onRemove}>
              <Trash2 className="w-3.5 h-3.5" />
              Remove
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ─── EditClaimModal ──────────────────────────────────── */

export function EditClaimModal({
  open,
  onClose,
  claim,
  report,
  onEvidenceClick,
  sessionId,
  baseApiUrl,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  claim: Claim | null;
  report: FeedbackReport;
  onEvidenceClick: (ev: EvidenceRef) => void;
  sessionId?: string;
  baseApiUrl?: string;
  onSave?: (claimId: string, text: string, evidenceRefs: string[]) => void;
}) {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const [lastClaimId, setLastClaimId] = useState<string | null>(null);
  if (claim && claim.id !== lastClaimId) {
    setLastClaimId(claim.id);
    setText(claim.text);
    setRefs([...claim.evidence_refs]);
    setShowPicker(false);
    setRegenerating(false);
  }

  if (!claim) return null;

  const availableEvidence = report.evidence.filter((e) => !refs.includes(e.id));

  const handleRemoveRef = (id: string) => { setRefs((prev) => prev.filter((r) => r !== id)); };
  const handleAddRef = (id: string) => { setRefs((prev) => [...prev, id]); setShowPicker(false); };

  const handleRegenerate = async () => {
    if (!sessionId || !baseApiUrl) return;
    setRegenerating(true);
    try {
      const result = await window.desktopAPI.regenerateFeedbackClaim({
        baseUrl: baseApiUrl,
        sessionId,
        body: { claim_id: claim.id, evidence_refs: refs },
      });
      const typed = result as { text?: string; evidence_refs?: string[] } | null;
      if (typed && typed.text) {
        setText(typed.text);
        if (Array.isArray(typed.evidence_refs)) {
          setRefs(typed.evidence_refs);
        }
      }
    } catch {
      // Regeneration failed — keep current text
    } finally {
      setRegenerating(false);
    }
  };

  const handleSave = () => {
    onSave?.(claim.id, text, refs);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit Claim" size="lg">
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Chip variant={CATEGORY_VARIANT[claim.category]}>{CATEGORY_LABEL[claim.category]}</Chip>
          <ConfidenceBadge score={claim.confidence} />
        </div>

        <TextArea label="Claim text" value={text} onChange={(e) => setText(e.target.value)} rows={3} />

        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-2">Evidence References</label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {refs.length === 0 && <Chip variant="error">No evidence linked</Chip>}
            {refs.map((refId) => {
              const ev = getEvidenceById(report, refId);
              if (!ev) return null;
              return (
                <span key={refId} className="inline-flex items-center gap-1">
                  <EvidenceChip
                    timestamp={formatTimestamp(ev.timestamp_ms)}
                    speaker={ev.speaker}
                    quote={ev.text}
                    onClick={() => onEvidenceClick(ev)}
                    className={ev.weak ? 'border-dashed' : ''}
                  />
                  <button
                    type="button"
                    onClick={() => handleRemoveRef(refId)}
                    className="text-ink-tertiary hover:text-error transition-colors cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              );
            })}
          </div>

          {!showPicker ? (
            <Button variant="ghost" size="sm" onClick={() => setShowPicker(true)} disabled={availableEvidence.length === 0}>
              <Plus className="w-3.5 h-3.5" />
              Add Evidence
            </Button>
          ) : (
            <div className="border border-border rounded-[--radius-button] p-3 space-y-1.5 max-h-48 overflow-y-auto">
              <p className="text-xs text-ink-tertiary mb-1">Click an item to add as evidence:</p>
              {availableEvidence.map((ev) => (
                <button
                  key={ev.id}
                  type="button"
                  onClick={() => handleAddRef(ev.id)}
                  className={`w-full text-left flex items-center gap-2 rounded-[--radius-button] px-2 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer ${ev.weak ? 'border border-dashed border-amber-300' : ''}`}
                >
                  <span className="font-mono text-xs text-accent">[{formatTimestamp(ev.timestamp_ms)}]</span>
                  <span className="text-xs font-medium text-ink">{ev.speaker}:</span>
                  <span className="text-xs text-ink-secondary truncate flex-1">&ldquo;{ev.text}&rdquo;</span>
                  <ConfidenceBadge score={ev.confidence} />
                </button>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setShowPicker(false)} className="mt-1">Cancel</Button>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={handleRegenerate} loading={regenerating} disabled={!sessionId || !baseApiUrl}>
            <RefreshCw className="w-3.5 h-3.5" />
            Regenerate with LLM
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={handleSave}>Save</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
