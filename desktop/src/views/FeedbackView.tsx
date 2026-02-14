import { useState, useMemo, useCallback } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  Crown,
  Users,
  Brain,
  Layers,
  Zap,
  FileText,
  Download,
  Copy,
  Calendar,
  User,
  Pencil,
  X,
  RefreshCw,
  Plus,
  Check,
  Clock,
  MessageSquare,
  Activity,
  TrendingUp,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ArrowRight,
  ArrowLeft,
  Trash2,
  BookOpen,
  Star,
  HelpCircle,
  Link2,
} from 'lucide-react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { EvidenceChip } from '../components/ui/EvidenceChip';
import { ConfidenceBadge } from '../components/ui/ConfidenceBadge';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { TextArea } from '../components/ui/TextArea';

/* ─── Motion Variants ────────────────────────────────── */

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }),
};

/* ─── Data Types ──────────────────────────────────────── */

type EvidenceRef = {
  id: string;
  timestamp_ms: number;
  speaker: string;
  text: string;
  confidence: number;
  weak?: boolean;
  weak_reason?: string;
};

type Claim = {
  id: string;
  text: string;
  category: 'strength' | 'risk' | 'action';
  confidence: number;
  evidence_refs: string[];
};

type DimensionFeedback = {
  dimension: string;
  claims: Claim[];
};

type PersonFeedback = {
  person_name: string;
  speaker_id: string;
  dimensions: DimensionFeedback[];
  summary: {
    strengths: string;
    risks: string;
    actions: string;
  };
};

type TeamDynamic = {
  type: 'highlight' | 'risk';
  text: string;
};

type OverallFeedback = {
  team_summary: string;
  teacher_memos: string[];
  interaction_events: string[];
  team_dynamics: TeamDynamic[];
  evidence_refs: string[];
};

type FeedbackReport = {
  session_id: string;
  session_name: string;
  date: string;
  duration_ms: number;
  status: 'draft' | 'final';
  mode: '1v1' | 'group';
  participants: string[];
  overall: OverallFeedback;
  persons: PersonFeedback[];
  evidence: EvidenceRef[];
};

/* ─── Mock Data ───────────────────────────────────────── */

const MOCK_REPORT: FeedbackReport = {
  session_id: 'sess_20260214_001',
  session_name: 'Product Manager Final Round',
  date: '2026-02-14',
  duration_ms: 720000,
  status: 'draft',
  mode: 'group',
  participants: ['Alice Chen', 'Bob Williams'],
  overall: {
    team_summary:
      'The team demonstrated strong collaboration and complementary skill sets. Alice led with clear strategic vision while Bob contributed detailed analytical thinking. Both candidates engaged actively, though the discussion occasionally lacked structured transitions between topics.',
    teacher_memos: [
      'Alice showed strong initiative in framing the problem space early on.',
      'Bob\'s quantitative analysis was particularly impressive during the pricing discussion.',
      'Both candidates could improve on explicitly acknowledging each other\'s contributions before building on them.',
    ],
    interaction_events: [
      'Alice initiated the discussion by proposing a three-segment market framework.',
      'Bob built on Alice\'s framework by adding CAC reduction estimates.',
      'Alice adjusted her model in real-time to incorporate Bob\'s partnership economics.',
      'Bob summarized collective progress at the midpoint, demonstrating situational awareness.',
    ],
    team_dynamics: [
      { type: 'highlight', text: 'Complementary analytical styles: strategic (Alice) + quantitative (Bob)' },
      { type: 'highlight', text: 'Real-time framework adaptation shows strong collaborative instincts' },
      { type: 'risk', text: 'Conversation flow was occasionally dominated by a single speaker' },
      { type: 'risk', text: 'Topic transitions lacked explicit bridging, causing some context loss' },
    ],
    evidence_refs: ['ev-1', 'ev-4', 'ev-8'],
  },
  persons: [
    {
      person_name: 'Alice Chen',
      speaker_id: 'spk_alice',
      dimensions: [
        {
          dimension: 'leadership',
          claims: [
            {
              id: 'c-a-l1',
              text: 'Proactively set the agenda and guided topic transitions, keeping the discussion focused on key objectives.',
              category: 'strength',
              confidence: 0.92,
              evidence_refs: ['ev-1', 'ev-2'],
            },
            {
              id: 'c-a-l2',
              text: 'Occasionally dominated the conversation without checking for input from others.',
              category: 'risk',
              confidence: 0.84,
              evidence_refs: ['ev-5'],
            },
            {
              id: 'c-a-l3',
              text: 'Practice structured hand-offs when transitioning topics to ensure all voices are heard.',
              category: 'action',
              confidence: 0.88,
              evidence_refs: ['ev-5', 'ev-2'],
            },
          ],
        },
        {
          dimension: 'collaboration',
          claims: [
            {
              id: 'c-a-co1',
              text: 'Built on Bob\'s points effectively by acknowledging contributions before adding her own perspective.',
              category: 'strength',
              confidence: 0.91,
              evidence_refs: ['ev-3', 'ev-4'],
            },
            {
              id: 'c-a-co2',
              text: 'Create explicit opportunities to invite quieter participants to share their views.',
              category: 'action',
              confidence: 0.79,
              evidence_refs: ['ev-5'],
            },
          ],
        },
        {
          dimension: 'logic',
          claims: [
            {
              id: 'c-a-lg1',
              text: 'Presented a well-structured cost-benefit framework for the product prioritization question.',
              category: 'strength',
              confidence: 0.93,
              evidence_refs: ['ev-6'],
            },
            {
              id: 'c-a-lg2',
              text: 'Some assumptions in the market sizing were not clearly stated, weakening the overall argument.',
              category: 'risk',
              confidence: 0.76,
              evidence_refs: ['ev-7'],
            },
          ],
        },
        {
          dimension: 'structure',
          claims: [
            {
              id: 'c-a-s1',
              text: 'Used a clear MECE breakdown when outlining the competitive landscape analysis.',
              category: 'strength',
              confidence: 0.90,
              evidence_refs: ['ev-6', 'ev-1'],
            },
            {
              id: 'c-a-s2',
              text: 'The transition from market analysis to product strategy felt abrupt and could benefit from bridging statements.',
              category: 'risk',
              confidence: 0.81,
              evidence_refs: ['ev-7'],
            },
          ],
        },
        {
          dimension: 'initiative',
          claims: [
            {
              id: 'c-a-i1',
              text: 'Volunteered to tackle the most complex question first, demonstrating confidence and ownership.',
              category: 'strength',
              confidence: 0.95,
              evidence_refs: ['ev-1'],
            },
            {
              id: 'c-a-i2',
              text: 'Explore additional data sources before committing to a recommendation to strengthen evidence base.',
              category: 'action',
              confidence: 0.72,
              evidence_refs: [],
            },
          ],
        },
      ],
      summary: {
        strengths:
          'Alice demonstrates strong strategic thinking and natural leadership instincts. Her ability to structure complex problems and drive discussion forward is a clear asset.',
        risks:
          'There is a tendency to dominate conversations and move through topics quickly without ensuring alignment. Some analytical assumptions lack transparency.',
        actions:
          'Focus on inclusive facilitation techniques: pause after major points, explicitly invite input, and state assumptions upfront when presenting analysis.',
      },
    },
    {
      person_name: 'Bob Williams',
      speaker_id: 'spk_bob',
      dimensions: [
        {
          dimension: 'leadership',
          claims: [
            {
              id: 'c-b-l1',
              text: 'Showed strong situational awareness by stepping in to summarize key decisions at critical moments.',
              category: 'strength',
              confidence: 0.89,
              evidence_refs: ['ev-8'],
            },
            {
              id: 'c-b-l2',
              text: 'Could take initiative earlier in discussions rather than waiting for prompts.',
              category: 'risk',
              confidence: 0.83,
              evidence_refs: ['ev-9'],
            },
          ],
        },
        {
          dimension: 'collaboration',
          claims: [
            {
              id: 'c-b-co1',
              text: 'Actively listened and validated others\' ideas before presenting counterpoints, creating psychological safety.',
              category: 'strength',
              confidence: 0.94,
              evidence_refs: ['ev-3', 'ev-10'],
            },
            {
              id: 'c-b-co2',
              text: 'Excellent at building consensus by finding common ground between differing viewpoints.',
              category: 'strength',
              confidence: 0.87,
              evidence_refs: ['ev-4', 'ev-8'],
            },
          ],
        },
        {
          dimension: 'logic',
          claims: [
            {
              id: 'c-b-lg1',
              text: 'Provided detailed quantitative analysis to support the pricing strategy discussion.',
              category: 'strength',
              confidence: 0.91,
              evidence_refs: ['ev-9', 'ev-10'],
            },
            {
              id: 'c-b-lg2',
              text: 'The data-driven approach sometimes lacked a narrative wrapper, making it harder to follow the implications.',
              category: 'risk',
              confidence: 0.78,
              evidence_refs: ['ev-9'],
            },
            {
              id: 'c-b-lg3',
              text: 'Lead with the "so what" before diving into data to improve audience engagement.',
              category: 'action',
              confidence: 0.85,
              evidence_refs: ['ev-9'],
            },
          ],
        },
        {
          dimension: 'structure',
          claims: [
            {
              id: 'c-b-s1',
              text: 'Organized technical details in a layered format that was easy for non-technical stakeholders to follow.',
              category: 'strength',
              confidence: 0.88,
              evidence_refs: ['ev-10'],
            },
          ],
        },
        {
          dimension: 'initiative',
          claims: [
            {
              id: 'c-b-i1',
              text: 'Suggested an alternative approach to the user research question that the panel hadn\'t considered.',
              category: 'strength',
              confidence: 0.86,
              evidence_refs: ['ev-8'],
            },
            {
              id: 'c-b-i2',
              text: 'Speak up more confidently when presenting original ideas rather than only responding to others.',
              category: 'action',
              confidence: 0.80,
              evidence_refs: ['ev-3'],
            },
          ],
        },
      ],
      summary: {
        strengths:
          'Bob is a strong analytical thinker and effective collaborator. His ability to synthesize information and build consensus makes him well-suited for cross-functional product roles.',
        risks:
          'Tends to be reactive rather than proactive in group settings. Data presentations sometimes lack narrative structure, reducing their persuasive impact.',
        actions:
          'Practice leading with conclusions before supporting data. Volunteer to open discussions occasionally to build visibility and confidence as a leader.',
      },
    },
  ],
  evidence: [
    {
      id: 'ev-1',
      timestamp_ms: 133000,
      speaker: 'Alice Chen',
      text: 'Let me start by framing the core problem. Our target market has three distinct segments, and I think we should prioritize based on TAM and adoption friction.',
      confidence: 0.94,
    },
    {
      id: 'ev-2',
      timestamp_ms: 187000,
      speaker: 'Alice Chen',
      text: 'Okay, moving on to competitive positioning. I think the key differentiator is our integration story.',
      confidence: 0.89,
    },
    {
      id: 'ev-3',
      timestamp_ms: 245000,
      speaker: 'Bob Williams',
      text: 'That\'s a great point, Alice. Building on that, I\'d add that the integration partnerships could reduce our CAC by roughly 30 percent.',
      confidence: 0.91,
    },
    {
      id: 'ev-4',
      timestamp_ms: 312000,
      speaker: 'Alice Chen',
      text: 'Bob raises a valid concern. Let me adjust my framework to account for the partnership economics he mentioned.',
      confidence: 0.87,
    },
    {
      id: 'ev-5',
      timestamp_ms: 341000,
      speaker: 'Alice Chen',
      text: 'So the next thing we need to address is the go-to-market timeline. I have a pretty clear view on this.',
      confidence: 0.85,
    },
    {
      id: 'ev-6',
      timestamp_ms: 420000,
      speaker: 'Alice Chen',
      text: 'If we break this down using a MECE framework: market size, competitive intensity, regulatory barriers, and technology readiness.',
      confidence: 0.92,
    },
    {
      id: 'ev-7',
      timestamp_ms: 498000,
      speaker: 'Alice Chen',
      text: 'Based on my estimate, the addressable market is around 2 billion. The growth rate should be 15 percent annually.',
      confidence: 0.78,
      weak: true,
      weak_reason: 'Market size assumption not backed by cited data source',
    },
    {
      id: 'ev-8',
      timestamp_ms: 556000,
      speaker: 'Bob Williams',
      text: 'Let me try to summarize where we are. We\'ve aligned on the target segment and the differentiation angle. The open question is pricing.',
      confidence: 0.93,
    },
    {
      id: 'ev-9',
      timestamp_ms: 612000,
      speaker: 'Bob Williams',
      text: 'Looking at the unit economics, if we assume a 40 percent gross margin and a 12-month payback period, the price point should fall between 49 and 79 dollars per seat.',
      confidence: 0.88,
    },
    {
      id: 'ev-10',
      timestamp_ms: 680000,
      speaker: 'Bob Williams',
      text: 'Here\'s how I\'d structure the pricing tiers: a free community plan for adoption, a pro plan for individual contributors, and an enterprise plan with SSO and audit logs.',
      confidence: 0.90,
    },
  ],
};

/* ─── Helpers ─────────────────────────────────────────── */

function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

const DIMENSION_ICONS: Record<string, typeof Crown> = {
  leadership: Crown,
  collaboration: Users,
  logic: Brain,
  structure: Layers,
  initiative: Zap,
};

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

const CATEGORY_BORDER: Record<Claim['category'], string> = {
  strength: 'border-l-emerald-400',
  risk: 'border-l-amber-400',
  action: 'border-l-blue-400',
};

function getEvidenceById(report: FeedbackReport, id: string): EvidenceRef | undefined {
  return report.evidence.find((e) => e.id === id);
}

/** Find all claims that reference a given evidence ID */
function getClaimsForEvidence(report: FeedbackReport, evidenceId: string): { person: string; claim: Claim }[] {
  const results: { person: string; claim: Claim }[] = [];
  for (const person of report.persons) {
    for (const dim of person.dimensions) {
      for (const claim of dim.claims) {
        if (claim.evidence_refs.includes(evidenceId)) {
          results.push({ person: person.person_name, claim });
        }
      }
    }
  }
  return results;
}

/** Get surrounding evidence items for context */
function getSurroundingEvidence(report: FeedbackReport, evidenceId: string): { before: EvidenceRef[]; after: EvidenceRef[] } {
  const sorted = [...report.evidence].sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const idx = sorted.findIndex((e) => e.id === evidenceId);
  if (idx === -1) return { before: [], after: [] };
  return {
    before: sorted.slice(Math.max(0, idx - 2), idx),
    after: sorted.slice(idx + 1, idx + 3),
  };
}

/* ─── Memo Types ─────────────────────────────────────── */

type Memo = {
  id: string;
  type: 'highlight' | 'issue' | 'question' | 'evidence';
  text: string;
  timestamp: number;
  stage: string;
};

const MEMO_TYPE_CONFIG = {
  highlight: { label: 'Highlight', icon: Star, borderColor: 'border-l-emerald-400', chipVariant: 'success' as const },
  issue: { label: 'Issue', icon: AlertTriangle, borderColor: 'border-l-amber-400', chipVariant: 'warning' as const },
  question: { label: 'Question', icon: HelpCircle, borderColor: 'border-l-blue-400', chipVariant: 'info' as const },
  evidence: { label: 'Evidence', icon: Link2, borderColor: 'border-l-purple-400', chipVariant: 'default' as const },
};

function formatMemoTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ─── StageMemosSection ──────────────────────────────── */

function StageMemosSection({
  memos,
  stages,
  notes,
}: {
  memos: Memo[];
  stages: string[];
  notes: string;
}) {
  const [notesOpen, setNotesOpen] = useState(false);
  const [openStages, setOpenStages] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    stages.forEach((s) => { init[s] = true; });
    return init;
  });

  const toggleStage = (stage: string) => {
    setOpenStages((prev) => ({ ...prev, [stage]: !prev[stage] }));
  };

  // Group memos by stage, preserving stage order
  const memosByStage = useMemo(() => {
    const map = new Map<string, Memo[]>();
    for (const stage of stages) {
      map.set(stage, []);
    }
    for (const memo of memos) {
      const list = map.get(memo.stage);
      if (list) {
        list.push(memo);
      } else {
        // Stage not in the ordered list — append it
        map.set(memo.stage, [memo]);
      }
    }
    return map;
  }, [memos, stages]);

  if (memos.length === 0 && !notes) {
    return (
      <Card glass className="border-t-2 border-t-accent p-5">
        <div className="flex items-center gap-2 mb-3">
          <BookOpen className="w-4 h-4 text-accent" />
          <h2 className="text-sm font-semibold text-ink">Session Notes</h2>
        </div>
        <p className="text-sm text-ink-tertiary italic">No session notes captured</p>
      </Card>
    );
  }

  return (
    <Card glass className="border-t-2 border-t-accent p-5">
      <div className="flex items-center gap-2 mb-4">
        <BookOpen className="w-4 h-4 text-accent" />
        <h2 className="text-sm font-semibold text-ink">Session Notes</h2>
        <Chip className="text-[10px]">{memos.length} memo{memos.length !== 1 ? 's' : ''}</Chip>
      </div>

      {/* Free-form Notes (collapsible) */}
      {notes && (
        <div className="border-t border-border pt-3 mb-3">
          <button
            type="button"
            className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
            onClick={() => setNotesOpen((v) => !v)}
          >
            {notesOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
            <FileText className="w-3.5 h-3.5 text-accent" />
            Free-form Notes
          </button>
          <AnimatePresence>
            {notesOpen && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.3 }}
                className="mt-2 pl-6 overflow-hidden"
              >
                <div
                  className="text-sm text-ink-secondary leading-relaxed prose prose-sm max-w-none"
                  dangerouslySetInnerHTML={{ __html: notes }}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Stage-grouped memos */}
      {Array.from(memosByStage.entries()).map(([stage, stageMemos]) => {
        if (stageMemos.length === 0) return null;
        const isOpen = openStages[stage] ?? true;

        return (
          <div key={stage} className="border-t border-border pt-3 mb-3 last:mb-0">
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
              onClick={() => toggleStage(stage)}
            >
              {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <span>{stage}</span>
              <Chip className="text-[10px] ml-1">{stageMemos.length}</Chip>
            </button>
            <AnimatePresence>
              {isOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3 }}
                  className="mt-2 space-y-2 pl-6 overflow-hidden"
                >
                  {stageMemos.map((memo) => {
                    const config = MEMO_TYPE_CONFIG[memo.type];
                    const MemoIcon = config.icon;
                    return (
                      <div
                        key={memo.id}
                        className={`border border-border border-l-[3px] ${config.borderColor} rounded-[--radius-button] p-3 hover:bg-surface-hover transition-colors`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex items-center gap-1.5 shrink-0">
                            <Chip variant={config.chipVariant} className="text-[10px]">
                              <MemoIcon className="w-3 h-3 mr-0.5 inline-block" />
                              {config.label}
                            </Chip>
                            <span className="font-mono text-xs text-accent">
                              {formatMemoTime(memo.timestamp)}
                            </span>
                          </div>
                          <p className="text-sm text-ink-secondary leading-relaxed flex-1">
                            {memo.text}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </Card>
  );
}

/* ─── Sub-components ──────────────────────────────────── */

function FeedbackHeader({
  report,
  onRegenerate,
  onBack,
}: {
  report: FeedbackReport;
  onRegenerate: () => void;
  onBack: () => void;
}) {
  const [copiedText, setCopiedText] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleCopyText = useCallback(() => {
    const lines: string[] = [
      report.session_name,
      `${report.date} | ${formatDuration(report.duration_ms)}`,
      '',
      'Team Summary:',
      report.overall.team_summary,
      '',
      'Teacher Memos:',
      ...report.overall.teacher_memos.map((m) => `- ${m}`),
      '',
    ];

    for (const person of report.persons) {
      lines.push(`--- ${person.person_name} ---`);
      for (const dim of person.dimensions) {
        lines.push(`  ${dim.dimension.toUpperCase()}:`);
        for (const claim of dim.claims) {
          lines.push(`    [${claim.category}] ${claim.text} (${Math.round(claim.confidence * 100)}%)`);
        }
      }
      lines.push(`  Strengths: ${person.summary.strengths}`);
      lines.push(`  Risks: ${person.summary.risks}`);
      lines.push(`  Actions: ${person.summary.actions}`);
      lines.push('');
    }

    navigator.clipboard.writeText(lines.join('\n'));
    setCopiedText(true);
    setTimeout(() => setCopiedText(false), 2000);
  }, [report]);

  const handleExportMarkdown = useCallback(() => {
    const lines: string[] = [
      `# ${report.session_name}`,
      `**Date:** ${report.date}  `,
      `**Duration:** ${formatDuration(report.duration_ms)}  `,
      `**Mode:** ${report.mode}  `,
      `**Participants:** ${report.participants.join(', ')}`,
      '',
      '## Team Summary',
      report.overall.team_summary,
      '',
      '### Teacher Memos',
      ...report.overall.teacher_memos.map((m) => `- ${m}`),
      '',
      '### Interaction Events',
      ...report.overall.interaction_events.map((e) => `- ${e}`),
      '',
      '### Team Dynamics',
      ...report.overall.team_dynamics.map((d) => `- ${d.type === 'highlight' ? '+' : '!'} ${d.text}`),
      '',
    ];

    for (const person of report.persons) {
      lines.push(`## ${person.person_name}`);
      for (const dim of person.dimensions) {
        lines.push(`### ${dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1)}`);
        for (const claim of dim.claims) {
          const tag =
            claim.category === 'strength' ? '+' : claim.category === 'risk' ? '!' : '>';
          lines.push(`- **[${tag}]** ${claim.text} _(${Math.round(claim.confidence * 100)}%)_`);
        }
        lines.push('');
      }
      lines.push('#### Summary');
      lines.push(`- **Strengths:** ${person.summary.strengths}`);
      lines.push(`- **Risks:** ${person.summary.risks}`);
      lines.push(`- **Actions:** ${person.summary.actions}`);
      lines.push('');
    }

    lines.push('## Evidence Timeline');
    for (const ev of report.evidence) {
      const weakTag = ev.weak ? ' **(weak)** ' : '';
      lines.push(
        `- **[${formatTimestamp(ev.timestamp_ms)}]** ${ev.speaker}: "${ev.text}"${weakTag} _(${Math.round(ev.confidence * 100)}%)_`
      );
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.session_name.replace(/\s+/g, '_')}_feedback.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report]);

  const handleRegenerate = () => {
    setRegenerating(true);
    onRegenerate();
    setTimeout(() => setRegenerating(false), 3000);
  };

  return (
    <div className="mb-6">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex items-start gap-3">
          <button
            onClick={onBack}
            className="text-ink-tertiary hover:text-ink transition-colors cursor-pointer mt-1"
            aria-label="Go back"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
          <h1 className="text-2xl font-semibold text-ink">{report.session_name}</h1>
          <div className="flex items-center gap-3 mt-1.5 flex-wrap">
            <span className="flex items-center gap-1 text-sm text-ink-secondary">
              <Calendar className="w-3.5 h-3.5" />
              {report.date}
            </span>
            <span className="flex items-center gap-1 text-sm text-ink-secondary">
              <Clock className="w-3.5 h-3.5" />
              {formatDuration(report.duration_ms)}
            </span>
            <span className="flex items-center gap-1 text-sm text-ink-secondary">
              <User className="w-3.5 h-3.5" />
              {report.participants.length} participants
            </span>
            <Chip variant="accent">{report.mode === '1v1' ? '1 v 1' : 'Group'}</Chip>
            <Chip variant={report.status === 'final' ? 'success' : 'warning'}>
              {report.status === 'final' ? 'Final Report' : 'Draft — finalizing...'}
            </Chip>
          </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={handleCopyText} className="transition-all duration-200">
          {copiedText ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copiedText ? 'Copied' : 'Copy Text'}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExportMarkdown} className="transition-all duration-200">
          <FileText className="w-3.5 h-3.5" />
          Export Markdown
        </Button>
        <Button variant="secondary" size="sm" disabled className="transition-all duration-200">
          <Download className="w-3.5 h-3.5" />
          Export DOCX
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        <Button variant="secondary" size="sm" onClick={handleRegenerate} loading={regenerating} className="transition-all duration-200">
          <RefreshCw className="w-3.5 h-3.5" />
          Re-generate
        </Button>
      </div>
    </div>
  );
}

function OverallCard({
  report,
  onEvidenceClick,
}: {
  report: FeedbackReport;
  onEvidenceClick: (ev: EvidenceRef) => void;
}) {
  const [memosOpen, setMemosOpen] = useState(true);
  const [eventsOpen, setEventsOpen] = useState(false);

  return (
    <Card glass className="border-t-2 border-t-accent p-5">
      <h2 className="text-sm font-semibold text-ink mb-3">Team Summary</h2>
      <p className="text-sm text-ink-secondary leading-relaxed mb-4">
        {report.overall.team_summary}
      </p>

      {/* Evidence chips */}
      <div className="flex flex-wrap gap-2 mb-4">
        {report.overall.evidence_refs.map((refId) => {
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
                className={ev.weak ? 'border-dashed opacity-80' : ''}
              />
            </motion.div>
          );
        })}
      </div>

      {/* Teacher Memos */}
      <div className="border-t border-border pt-3 mb-3">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
          onClick={() => setMemosOpen((v) => !v)}
        >
          {memosOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <MessageSquare className="w-3.5 h-3.5 text-accent" />
          Teacher Memos
        </button>
        <AnimatePresence>
          {memosOpen && (
            <motion.ul
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="mt-2 space-y-1.5 pl-6 overflow-hidden"
            >
              {report.overall.teacher_memos.map((memo, i) => (
                <li key={i} className="text-sm text-ink-secondary leading-relaxed flex items-start gap-2">
                  <span className="text-accent mt-1.5 shrink-0">&#8226;</span>
                  {memo}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>

      {/* Interaction Events */}
      <div className="border-t border-border pt-3 mb-3">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
          onClick={() => setEventsOpen((v) => !v)}
        >
          {eventsOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          <Activity className="w-3.5 h-3.5 text-accent" />
          Interaction Events
        </button>
        <AnimatePresence>
          {eventsOpen && (
            <motion.ul
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="mt-2 space-y-1.5 pl-6 overflow-hidden"
            >
              {report.overall.interaction_events.map((event, i) => (
                <li key={i} className="text-sm text-ink-secondary leading-relaxed flex items-start gap-2">
                  <span className="text-ink-tertiary mt-1.5 shrink-0">&#8226;</span>
                  {event}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>

      {/* Team Dynamics */}
      <div className="border-t border-border pt-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-2">
          <TrendingUp className="w-3.5 h-3.5 text-accent" />
          Team Dynamics
        </div>
        <div className="space-y-1.5 pl-6">
          {report.overall.team_dynamics.map((dyn, i) => (
            <div
              key={i}
              className={`flex items-start gap-2 text-sm leading-relaxed ${
                dyn.type === 'highlight' ? 'text-success' : 'text-warning'
              }`}
            >
              {dyn.type === 'highlight' ? (
                <TrendingUp className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              ) : (
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              )}
              <span className="text-ink-secondary">{dyn.text}</span>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

function ClaimCard({
  claim,
  report,
  onEditClick,
  onEvidenceClick,
  onNeedsEvidenceClick,
}: {
  claim: Claim;
  report: FeedbackReport;
  onEditClick: () => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidenceClick: () => void;
}) {
  return (
    <div
      className={`group border border-border border-l-4 ${CATEGORY_BORDER[claim.category]} rounded-[--radius-button] p-3 hover:bg-surface-hover transition-colors`}
    >
      <div className="flex items-start gap-2 mb-2">
        <p className="text-sm text-ink flex-1">{claim.text}</p>
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
      <div className="flex flex-wrap gap-1.5">
        {claim.evidence_refs.length === 0 && (
          <button type="button" onClick={onNeedsEvidenceClick} className="cursor-pointer">
            <Chip variant="error">Needs Evidence</Chip>
          </button>
        )}
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
          <Chip variant="warning" className="text-[10px]">weak</Chip>
        )}
      </div>
    </div>
  );
}

function DimensionSection({
  dim,
  report,
  onClaimEdit,
  onEvidenceClick,
  onNeedsEvidence,
}: {
  dim: DimensionFeedback;
  report: FeedbackReport;
  onClaimEdit: (claim: Claim) => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidence: (claim: Claim) => void;
}) {
  const Icon = DIMENSION_ICONS[dim.dimension] ?? Layers;
  const label = dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1);

  return (
    <div className="mb-4 last:mb-0">
      <div className="flex items-center gap-2 mb-2.5">
        <Icon className="w-4 h-4 text-accent" />
        <h4 className="text-sm font-semibold text-ink">{label}</h4>
      </div>
      <div className="space-y-2 pl-6">
        {dim.claims.map((claim) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            report={report}
            onEditClick={() => onClaimEdit(claim)}
            onEvidenceClick={onEvidenceClick}
            onNeedsEvidenceClick={() => onNeedsEvidence(claim)}
          />
        ))}
      </div>
    </div>
  );
}

function PersonSummary({ summary }: { summary: PersonFeedback['summary'] }) {
  return (
    <div className="border-t border-border mt-4 pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <h5 className="text-xs font-semibold text-success mb-1">Strengths</h5>
        <p className="text-xs text-ink-secondary leading-relaxed">{summary.strengths}</p>
      </div>
      <div>
        <h5 className="text-xs font-semibold text-warning mb-1">Risks</h5>
        <p className="text-xs text-ink-secondary leading-relaxed">{summary.risks}</p>
      </div>
      <div>
        <h5 className="text-xs font-semibold text-blue-700 mb-1">Actions</h5>
        <p className="text-xs text-ink-secondary leading-relaxed">{summary.actions}</p>
      </div>
    </div>
  );
}

function PersonFeedbackCard({
  person,
  report,
  onClaimEdit,
  onEvidenceClick,
  onNeedsEvidence,
}: {
  person: PersonFeedback;
  report: FeedbackReport;
  onClaimEdit: (claim: Claim, person: PersonFeedback) => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidence: (claim: Claim) => void;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-base font-semibold text-ink">{person.person_name}</h3>
        <Chip>{person.speaker_id}</Chip>
      </div>
      {/* Compact summary chips */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        <Chip variant="success" className="text-[10px]">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'strength').length, 0)} strengths
        </Chip>
        <Chip variant="warning" className="text-[10px]">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'risk').length, 0)} risks
        </Chip>
        <Chip variant="info" className="text-[10px]">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'action').length, 0)} actions
        </Chip>
      </div>
      {person.dimensions.map((dim) => (
        <DimensionSection
          key={dim.dimension}
          dim={dim}
          report={report}
          onClaimEdit={(claim) => onClaimEdit(claim, person)}
          onEvidenceClick={onEvidenceClick}
          onNeedsEvidence={onNeedsEvidence}
        />
      ))}
      <PersonSummary summary={person.summary} />
    </Card>
  );
}

function EvidenceTimeline({
  report,
  highlightEvidence,
  onEvidenceClick,
}: {
  report: FeedbackReport;
  highlightEvidence: string | null;
  onEvidenceClick: (ev: EvidenceRef) => void;
}) {
  const [speakerFilter, setSpeakerFilter] = useState('');
  const [strengthFilter, setStrengthFilter] = useState('');
  const [sortAsc, setSortAsc] = useState(true);

  const speakers = useMemo(() => {
    const set = new Set(report.evidence.map((e) => e.speaker));
    return Array.from(set).sort();
  }, [report.evidence]);

  const filtered = useMemo(() => {
    let items = [...report.evidence];
    if (speakerFilter) {
      items = items.filter((e) => e.speaker === speakerFilter);
    }
    if (strengthFilter === 'weak') {
      items = items.filter((e) => e.weak);
    } else if (strengthFilter === 'strong') {
      items = items.filter((e) => !e.weak);
    }
    items.sort((a, b) =>
      sortAsc ? a.timestamp_ms - b.timestamp_ms : b.timestamp_ms - a.timestamp_ms
    );
    return items;
  }, [report.evidence, speakerFilter, strengthFilter, sortAsc]);

  const speakerOptions = [
    { value: '', label: 'All Speakers' },
    ...speakers.map((s) => ({ value: s, label: s })),
  ];

  const strengthOptions = [
    { value: '', label: 'All Evidence' },
    { value: 'strong', label: 'Strong Only' },
    { value: 'weak', label: 'Weak Only' },
  ];

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h3 className="text-base font-semibold text-ink">Evidence Timeline</h3>
        <div className="flex items-center gap-2 flex-wrap">
          <Select
            options={speakerOptions}
            value={speakerFilter}
            onChange={(e) => setSpeakerFilter(e.target.value)}
            className="w-40"
          />
          <Select
            options={strengthOptions}
            value={strengthFilter}
            onChange={(e) => setStrengthFilter(e.target.value)}
            className="w-36"
          />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSortAsc((v) => !v)}
          >
            {sortAsc ? 'Oldest first' : 'Newest first'}
          </Button>
        </div>
      </div>
      <div className="space-y-2">
        {filtered.map((ev) => {
          const refClaims = getClaimsForEvidence(report, ev.id);
          const isHighlighted = highlightEvidence === ev.id;

          return (
            <button
              key={ev.id}
              type="button"
              onClick={() => onEvidenceClick(ev)}
              className={`
                w-full text-left flex items-start gap-3 rounded-[--radius-button] p-3 transition-all cursor-pointer
                ${isHighlighted
                  ? 'bg-accent-soft border-2 border-accent'
                  : `border ${ev.weak ? 'border-dashed border-amber-300' : 'border-border'} hover:bg-surface-hover`
                }
              `}
            >
              <span className="font-mono text-xs text-accent whitespace-nowrap mt-0.5">
                [{formatTimestamp(ev.timestamp_ms)}]
              </span>
              <span className="text-xs font-medium text-ink whitespace-nowrap mt-0.5">
                {ev.speaker}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink-secondary leading-relaxed">
                  &ldquo;{ev.text}&rdquo;
                </p>
                {refClaims.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {refClaims.map(({ person, claim }) => (
                      <span
                        key={claim.id}
                        className="text-[10px] text-ink-tertiary bg-surface-hover rounded px-1.5 py-0.5"
                      >
                        {person}: {claim.text.slice(0, 30)}...
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {ev.weak && <Chip variant="warning" className="text-[10px]">weak</Chip>}
                <ConfidenceBadge score={ev.confidence} />
              </div>
            </button>
          );
        })}
      </div>
    </Card>
  );
}

function EvidenceDetailModal({
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

  const { before, after } = getSurroundingEvidence(report, evidence.id);
  const refClaims = getClaimsForEvidence(report, evidence.id);

  return (
    <Modal open={open} onClose={onClose} title="Evidence Detail" size="lg">
      <div className="space-y-4">
        {/* Metadata row */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="font-mono text-sm text-accent font-medium">
            [{formatTimestamp(evidence.timestamp_ms)}]
          </span>
          <span className="text-sm font-medium text-ink">{evidence.speaker}</span>
          <ConfidenceBadge score={evidence.confidence} />
          {evidence.weak && <Chip variant="warning">Weak Evidence</Chip>}
        </div>

        {/* Main quote */}
        <div className="bg-accent-soft/50 border border-accent/20 rounded-[--radius-button] p-4">
          <p className="text-sm text-ink leading-relaxed italic">
            &ldquo;{evidence.text}&rdquo;
          </p>
        </div>

        {/* Weak reason */}
        {evidence.weak && evidence.weak_reason && (
          <div className="flex items-start gap-2 text-sm text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{evidence.weak_reason}</span>
          </div>
        )}

        {/* Surrounding context */}
        <div>
          <h4 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">
            Surrounding Context
          </h4>
          <div className="space-y-1.5">
            {before.map((ev) => (
              <div key={ev.id} className="flex items-start gap-2 text-xs text-ink-tertiary pl-2 border-l-2 border-border">
                <span className="font-mono whitespace-nowrap">
                  [{formatTimestamp(ev.timestamp_ms)}]
                </span>
                <span className="font-medium whitespace-nowrap">{ev.speaker}:</span>
                <span className="leading-relaxed">&ldquo;{ev.text}&rdquo;</span>
              </div>
            ))}
            <div className="flex items-start gap-2 text-xs text-ink pl-2 border-l-2 border-accent bg-accent-soft/30 rounded-r py-1">
              <ArrowRight className="w-3 h-3 text-accent shrink-0 mt-0.5" />
              <span className="font-mono whitespace-nowrap font-medium">
                [{formatTimestamp(evidence.timestamp_ms)}]
              </span>
              <span className="font-medium whitespace-nowrap">{evidence.speaker}:</span>
              <span className="leading-relaxed font-medium">&ldquo;{evidence.text}&rdquo;</span>
            </div>
            {after.map((ev) => (
              <div key={ev.id} className="flex items-start gap-2 text-xs text-ink-tertiary pl-2 border-l-2 border-border">
                <span className="font-mono whitespace-nowrap">
                  [{formatTimestamp(ev.timestamp_ms)}]
                </span>
                <span className="font-medium whitespace-nowrap">{ev.speaker}:</span>
                <span className="leading-relaxed">&ldquo;{ev.text}&rdquo;</span>
              </div>
            ))}
          </div>
        </div>

        {/* Referenced by claims */}
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

        {/* Actions */}
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
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditClaimModal({
  open,
  onClose,
  claim,
  report,
  onEvidenceClick,
}: {
  open: boolean;
  onClose: () => void;
  claim: Claim | null;
  report: FeedbackReport;
  onEvidenceClick: (ev: EvidenceRef) => void;
}) {
  const [text, setText] = useState('');
  const [refs, setRefs] = useState<string[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  // Sync local state when a new claim is opened
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

  const handleRemoveRef = (id: string) => {
    setRefs((prev) => prev.filter((r) => r !== id));
  };

  const handleAddRef = (id: string) => {
    setRefs((prev) => [...prev, id]);
    setShowPicker(false);
  };

  const handleRegenerate = () => {
    setRegenerating(true);
    setTimeout(() => setRegenerating(false), 2000);
  };

  return (
    <Modal open={open} onClose={onClose} title="Edit Claim" size="lg">
      <div className="space-y-4">
        {/* Category + confidence */}
        <div className="flex items-center gap-2">
          <Chip variant={CATEGORY_VARIANT[claim.category]}>
            {CATEGORY_LABEL[claim.category]}
          </Chip>
          <ConfidenceBadge score={claim.confidence} />
        </div>

        {/* Editable text */}
        <TextArea
          label="Claim text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
        />

        {/* Evidence refs */}
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-2">
            Evidence References
          </label>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {refs.length === 0 && (
              <Chip variant="error">No evidence linked</Chip>
            )}
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

          {/* Add evidence picker */}
          {!showPicker ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowPicker(true)}
              disabled={availableEvidence.length === 0}
            >
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
                  className={`w-full text-left flex items-center gap-2 rounded-[--radius-button] px-2 py-1.5 hover:bg-surface-hover transition-colors cursor-pointer ${
                    ev.weak ? 'border border-dashed border-amber-300' : ''
                  }`}
                >
                  <span className="font-mono text-xs text-accent">
                    [{formatTimestamp(ev.timestamp_ms)}]
                  </span>
                  <span className="text-xs font-medium text-ink">{ev.speaker}:</span>
                  <span className="text-xs text-ink-secondary truncate flex-1">
                    &ldquo;{ev.text}&rdquo;
                  </span>
                  <ConfidenceBadge score={ev.confidence} />
                </button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowPicker(false)}
                className="mt-1"
              >
                Cancel
              </Button>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRegenerate}
            loading={regenerating}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Regenerate with LLM
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={onClose}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─── Dynamic Mock Generators ────────────────────────── */

function generateMockPersonFeedback(name: string, speakerIndex: number): PersonFeedback {
  const dimensions = ['leadership', 'collaboration', 'communication', 'analytical', 'adaptability'];
  return {
    person_name: name,
    speaker_id: `spk_${speakerIndex}`,
    dimensions: dimensions.map(dim => ({
      dimension: dim,
      claims: [
        {
          id: `c-${speakerIndex}-${dim}-s`,
          text: `Demonstrated strong ${dim} skills throughout the session.`,
          category: 'strength' as const,
          confidence: 0.75 + Math.random() * 0.2,
          evidence_refs: [`ev-${speakerIndex * 3 + 1}`],
        },
        {
          id: `c-${speakerIndex}-${dim}-r`,
          text: `Could improve in ${dim} by being more proactive in team discussions.`,
          category: 'risk' as const,
          confidence: 0.65 + Math.random() * 0.2,
          evidence_refs: [`ev-${speakerIndex * 3 + 2}`],
        },
        {
          id: `c-${speakerIndex}-${dim}-a`,
          text: `Practice ${dim} exercises and seek feedback from peers regularly.`,
          category: 'action' as const,
          confidence: 0.7 + Math.random() * 0.15,
          evidence_refs: [`ev-${speakerIndex * 3 + 1}`, `ev-${speakerIndex * 3 + 3}`],
        },
      ],
    })),
    summary: {
      strengths: `${name} showed consistent engagement and contributed meaningfully to the discussion.`,
      risks: `${name} could benefit from more structured communication in high-pressure scenarios.`,
      actions: `Encourage ${name} to lead smaller group discussions to build confidence.`,
    },
  };
}

function generateMockEvidence(participantNames: string[]): EvidenceRef[] {
  const evidence: EvidenceRef[] = [];
  participantNames.forEach((name, i) => {
    for (let j = 1; j <= 3; j++) {
      evidence.push({
        id: `ev-${i * 3 + j}`,
        timestamp_ms: (60 + i * 120 + j * 45) * 1000,
        speaker: name,
        text: `${name} made a relevant point about the topic under discussion at this point in the session.`,
        confidence: 0.7 + Math.random() * 0.25,
      });
    }
  });
  return evidence;
}

/* ─── Main View ───────────────────────────────────────── */

export function FeedbackView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const locationState = location.state as {
    sessionName?: string;
    mode?: string;
    participants?: string[];
    memos?: Array<{
      id: string;
      type: 'highlight' | 'issue' | 'question' | 'evidence';
      text: string;
      timestamp: number;
      stage: string;
    }>;
    stages?: string[];
    notes?: string;
  } | null;

  // Modal state
  const [editClaim, setEditClaim] = useState<Claim | null>(null);
  const [detailEvidence, setDetailEvidence] = useState<EvidenceRef | null>(null);
  const [evidenceModalMode, setEvidenceModalMode] = useState<'browse' | 'claim-editor'>('browse');
  const [highlightEvidence, setHighlightEvidence] = useState<string | null>(null);

  // Extract session memos from location state
  const sessionMemos: Memo[] = locationState?.memos || [];
  const sessionStages: string[] = locationState?.stages || [];
  const sessionNotes: string = locationState?.notes || '';

  // If we have real memos, derive teacher_memos from them
  const derivedTeacherMemos = sessionMemos.length > 0
    ? sessionMemos
        .filter(m => m.type === 'highlight' || m.type === 'issue')
        .map(m => `[${m.stage}] ${m.text}`)
    : MOCK_REPORT.overall.teacher_memos;

  // In production this would fetch from API using sessionId
  const actualParticipants = locationState?.participants;
  const effectiveReport: FeedbackReport = actualParticipants && actualParticipants.length > 0
    ? {
        ...MOCK_REPORT,
        session_id: sessionId || MOCK_REPORT.session_id,
        session_name: locationState?.sessionName || MOCK_REPORT.session_name,
        mode: (locationState?.mode as '1v1' | 'group') || MOCK_REPORT.mode,
        participants: actualParticipants,
        persons: actualParticipants.map((name, i) => generateMockPersonFeedback(name, i)),
        evidence: generateMockEvidence(actualParticipants),
        overall: {
          ...MOCK_REPORT.overall,
          teacher_memos: derivedTeacherMemos,
          team_summary: `The session "${locationState?.sessionName || 'Interview'}" included ${actualParticipants.length} participant${actualParticipants.length > 1 ? 's' : ''}: ${actualParticipants.join(', ')}. ${MOCK_REPORT.overall.team_summary}`,
        },
      }
    : {
        ...MOCK_REPORT,
        session_id: sessionId || MOCK_REPORT.session_id,
        session_name: locationState?.sessionName || MOCK_REPORT.session_name,
        overall: {
          ...MOCK_REPORT.overall,
          teacher_memos: derivedTeacherMemos,
        },
      };
  const report = effectiveReport;

  const handleClaimEdit = (claim: Claim, _person: PersonFeedback) => {
    setEditClaim(claim);
  };

  const handleEvidenceClick = (ev: EvidenceRef) => {
    setDetailEvidence(ev);
    setEvidenceModalMode('browse');
  };

  const handleEvidenceClickFromEditor = (ev: EvidenceRef) => {
    setDetailEvidence(ev);
    setEvidenceModalMode('claim-editor');
  };

  const handleNeedsEvidence = (claim: Claim) => {
    // Open the edit modal with picker immediately visible
    setEditClaim(claim);
  };

  const handleRegenerate = () => {
    // Placeholder: would trigger full LLM re-generation
  };

  const handleTimelineEvidenceClick = (ev: EvidenceRef) => {
    setHighlightEvidence(ev.id);
    setDetailEvidence(ev);
    setEvidenceModalMode('browse');
  };

  return (
    <div className="h-full overflow-y-auto">
      <motion.div
        initial="hidden"
        animate="visible"
        className="max-w-4xl mx-auto p-6"
      >
        <motion.div variants={fadeInUp} custom={0}>
          <FeedbackHeader report={report} onRegenerate={handleRegenerate} onBack={() => navigate('/')} />
        </motion.div>

        <div className="space-y-4">
          <motion.div variants={fadeInUp} custom={1}>
            <OverallCard report={report} onEvidenceClick={handleEvidenceClick} />
          </motion.div>

          {/* Stage Memos — from interviewer's session notes */}
          {(sessionMemos.length > 0 || sessionNotes) && (
            <motion.div variants={fadeInUp} custom={2}>
              <StageMemosSection memos={sessionMemos} stages={sessionStages} notes={sessionNotes} />
            </motion.div>
          )}

          {report.persons.map((person, index) => (
            <motion.div key={person.speaker_id} variants={fadeInUp} custom={index + 3}>
              <PersonFeedbackCard
                person={person}
                report={report}
                onClaimEdit={handleClaimEdit}
                onEvidenceClick={handleEvidenceClick}
                onNeedsEvidence={handleNeedsEvidence}
              />
            </motion.div>
          ))}

          <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
            <EvidenceTimeline
              report={report}
              highlightEvidence={highlightEvidence}
              onEvidenceClick={handleTimelineEvidenceClick}
            />
          </motion.div>
        </div>
      </motion.div>

      {/* Edit Claim Modal */}
      <EditClaimModal
        open={editClaim !== null && detailEvidence === null}
        onClose={() => setEditClaim(null)}
        claim={editClaim}
        report={report}
        onEvidenceClick={handleEvidenceClickFromEditor}
      />

      {/* Evidence Detail Modal */}
      <EvidenceDetailModal
        open={detailEvidence !== null}
        onClose={() => {
          setDetailEvidence(null);
          setHighlightEvidence(null);
        }}
        evidence={detailEvidence}
        report={report}
        mode={evidenceModalMode}
        onUseAsEvidence={() => {
          setDetailEvidence(null);
        }}
        onRemove={() => {
          setDetailEvidence(null);
        }}
      />
    </div>
  );
}
