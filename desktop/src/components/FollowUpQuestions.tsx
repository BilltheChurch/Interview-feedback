import { HelpCircle } from 'lucide-react';

type Props = {
  questions: Array<{
    question: string;
    purpose: string;
    related_claim_id?: string;
  }>;
};

export function FollowUpQuestions({ questions }: Props) {
  if (questions.length === 0) return null;

  return (
    <div className="mt-4">
      <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
        Suggested Follow-up Questions
      </h4>
      <div className="space-y-2">
        {questions.map((q, i) => (
          <div key={i} className="flex items-start gap-2 p-2.5 border border-border/50 rounded-[--radius-button] bg-blue-50/30">
            <HelpCircle className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
            <div>
              <p className="text-sm text-ink font-medium">{q.question}</p>
              <p className="text-xs text-ink-tertiary mt-0.5">{q.purpose}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
