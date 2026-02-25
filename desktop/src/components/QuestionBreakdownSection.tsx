import { useState, useMemo } from 'react';
import { ChevronDown, ChevronRight, Sparkles, AlertTriangle, Lightbulb } from 'lucide-react';
import { Chip } from './ui/Chip';

const QUALITY_CONFIG = {
  A: { label: 'A', color: 'bg-emerald-100 text-emerald-700', border: 'border-emerald-200' },
  B: { label: 'B', color: 'bg-blue-100 text-blue-700', border: 'border-blue-200' },
  C: { label: 'C', color: 'bg-amber-100 text-amber-700', border: 'border-amber-200' },
  D: { label: 'D', color: 'bg-red-100 text-red-700', border: 'border-red-200' },
};

export type QuestionAnalysisItem = {
  question_text: string;
  answer_quality: string;
  comment: string;
  related_dimensions: string[];
  answer_utterance_ids?: string[];
  scoring_rationale?: string;
  answer_highlights?: string[];
  answer_weaknesses?: string[];
  suggested_better_answer?: string;
};

type TranscriptUtterance = {
  utterance_id: string;
  speaker_name: string | null;
  text: string;
};

type Props = {
  questions: QuestionAnalysisItem[];
  transcript?: TranscriptUtterance[];
};

export function QuestionBreakdownSection({ questions, transcript }: Props) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const toggle = (i: number) => setExpandedIdx(prev => prev === i ? null : i);

  // O(1) lookup map instead of O(n) find per utterance ID
  const transcriptMap = useMemo(() => {
    const map = new Map<string, TranscriptUtterance>();
    for (const u of transcript ?? []) {
      map.set(u.utterance_id, u);
    }
    return map;
  }, [transcript]);

  // Pre-compute answer text for each question (avoids duplicate calls)
  const answerTexts = useMemo(() =>
    questions.map(q => {
      if (!q.answer_utterance_ids?.length || transcriptMap.size === 0) return null;
      const texts = q.answer_utterance_ids
        .map(id => transcriptMap.get(id))
        .filter(Boolean)
        .map(u => u!.text);
      return texts.length > 0 ? texts.join(' ') : null;
    }),
  [questions, transcriptMap]);

  const hasDetail = (q: QuestionAnalysisItem, answerText: string | null) =>
    !!(q.scoring_rationale || q.answer_highlights?.length || q.answer_weaknesses?.length || q.suggested_better_answer || answerText);

  return (
    <div className="space-y-3">
      {questions.map((q, i) => {
        const quality = QUALITY_CONFIG[q.answer_quality as keyof typeof QUALITY_CONFIG] || QUALITY_CONFIG.C;
        const expanded = expandedIdx === i;
        const answerText = answerTexts[i];
        const expandable = hasDetail(q, answerText);

        return (
          <div key={i} className={`border border-border rounded-[--radius-card] overflow-hidden transition-shadow duration-200 ${expanded ? 'shadow-[--shadow-card-hover]' : ''}`}>
            {/* Header — always visible */}
            <button
              type="button"
              onClick={() => expandable && toggle(i)}
              className={`w-full text-left p-3 flex items-start gap-2 ${expandable ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default'} transition-colors duration-150`}
            >
              <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${quality.color} shrink-0 mt-0.5`}>
                {quality.label}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink">{q.question_text}</p>
                <p className="text-xs text-ink-secondary mt-1">{q.comment}</p>
                {q.related_dimensions.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {q.related_dimensions.map(d => (
                      <Chip key={d} className="text-xs">{d}</Chip>
                    ))}
                  </div>
                )}
              </div>
              {expandable && (
                <span className="shrink-0 mt-0.5 text-ink-tertiary">
                  {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </span>
              )}
            </button>

            {/* Detail panel — expanded only */}
            {expanded && expandable && (
              <div className="border-t border-border bg-[#FAFAF7] px-4 py-3 space-y-3 animate-[fade-in_150ms_ease]">
                {/* Candidate's actual answer */}
                {answerText && (
                  <div>
                    <p className="text-xs font-semibold text-ink-secondary mb-1">Candidate Answer</p>
                    <p className="text-xs text-ink leading-relaxed bg-surface rounded-[--radius-chip] p-2 border border-border italic">
                      "{answerText}"
                    </p>
                  </div>
                )}

                {/* Scoring rationale */}
                {q.scoring_rationale && (
                  <div>
                    <p className="text-xs font-semibold text-ink-secondary mb-1">Scoring Rationale</p>
                    <p className="text-xs text-ink leading-relaxed">{q.scoring_rationale}</p>
                  </div>
                )}

                {/* Highlights */}
                {q.answer_highlights && q.answer_highlights.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1 mb-1">
                      <Sparkles className="w-3 h-3 text-emerald-600" />
                      <p className="text-xs font-semibold text-emerald-700">Highlights</p>
                    </div>
                    <ul className="space-y-1">
                      {q.answer_highlights.map((h, hi) => (
                        <li key={hi} className="text-xs text-ink pl-4 relative before:content-[''] before:absolute before:left-1.5 before:top-[6px] before:w-1 before:h-1 before:rounded-full before:bg-emerald-400">
                          {h}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Weaknesses */}
                {q.answer_weaknesses && q.answer_weaknesses.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1 mb-1">
                      <AlertTriangle className="w-3 h-3 text-amber-600" />
                      <p className="text-xs font-semibold text-amber-700">Areas for Improvement</p>
                    </div>
                    <ul className="space-y-1">
                      {q.answer_weaknesses.map((w, wi) => (
                        <li key={wi} className="text-xs text-ink pl-4 relative before:content-[''] before:absolute before:left-1.5 before:top-[6px] before:w-1 before:h-1 before:rounded-full before:bg-amber-400">
                          {w}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Suggested better answer */}
                {q.suggested_better_answer && (
                  <div>
                    <div className="flex items-center gap-1 mb-1">
                      <Lightbulb className="w-3 h-3 text-blue-600" />
                      <p className="text-xs font-semibold text-blue-700">Suggested Approach</p>
                    </div>
                    <p className="text-xs text-ink leading-relaxed bg-blue-50 rounded-[--radius-chip] p-2 border border-blue-100">
                      {q.suggested_better_answer}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
