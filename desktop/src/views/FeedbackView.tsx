import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useParams, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText,
  Download,
  Copy,
  Calendar,
  User,
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
  ArrowLeft,
  Trash2,
  BookOpen,
  Star,
  HelpCircle,
  Link2,
  Loader2,
  Sparkles,
  ScrollText,
  PanelRight,
  PanelRightClose,
  Lightbulb,
} from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
import { TranscriptSection } from '../components/TranscriptSection';
import { SplitButton } from '../components/ui/SplitButton';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { EvidenceChip } from '../components/ui/EvidenceChip';
import { ConfidenceBadge } from '../components/ui/ConfidenceBadge';
import { Modal } from '../components/ui/Modal';
import { TextArea } from '../components/ui/TextArea';
import { FootnoteRef } from '../components/ui/FootnoteRef';
import { FootnoteList } from '../components/ui/FootnoteList';
import { InlineEvidenceCard } from '../components/ui/InlineEvidenceCard';
import { InlineEditable } from '../components/ui/InlineEditable';
import { CommunicationMetrics } from '../components/CommunicationMetrics';
import { CandidateComparison } from '../components/CandidateComparison';
import { RecommendationBadge } from '../components/RecommendationBadge';
import { QuestionBreakdownSection } from '../components/QuestionBreakdownSection';
import { sanitizeHtml } from '../lib/sanitize';
import { InterviewQualityCard } from '../components/InterviewQualityCard';
import { FollowUpQuestions } from '../components/FollowUpQuestions';
import { ActionPlanCard } from '../components/ActionPlanCard';
import { useFootnotes } from '../hooks/useFootnotes';
import { ClaimCard } from '../components/feedback/ClaimCard';
import { DimensionSection } from '../components/feedback/DimensionSection';
import { RadarChart } from '../components/feedback/RadarChart';
import { EvidenceDetailModal, EditClaimModal } from '../components/feedback/FeedbackModals';
import { buildFullMarkdown, buildPrintHtml, markdownToSimpleHtml, formatTimestamp, formatDuration, getEvidenceById, updateClaimInReport } from '../components/feedback/reportUtils';
import {
  useFeedbackData,
  type SessionData,
} from '../hooks/useFeedbackData';
import type {
  EvidenceRef,
  Claim,
  PersonFeedback,
  OverallFeedback,
  FeedbackReport,
  Memo,
} from '../components/feedback/types';

/* ─── Motion Variants ────────────────────────────────── */

const fadeInUp = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] },
  }),
};

/* ─── Memo Types ─────────────────────────────────────── */

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

/* ─── StageArchiveProp ───────────────────────────────── */

type StageArchiveProp = {
  stageIndex: number;
  stageName: string;
  archivedAt: string;
  freeformText: string;
  freeformHtml?: string;
  memoIds: string[];
};

/* ─── StageMemosSection ──────────────────────────────── */

function StageMemosSection({
  memos,
  stages,
  notes,
  stageArchives = [],
}: {
  memos: Memo[];
  stages: string[];
  notes: string;
  stageArchives?: StageArchiveProp[];
}) {
  const hasArchives = stageArchives.length > 0;

  const [openStages, setOpenStages] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    if (hasArchives) {
      stageArchives.forEach((a) => { init[a.stageName] = true; });
    } else {
      stages.forEach((s) => { init[s] = true; });
    }
    return init;
  });

  const toggleStage = (stage: string) => {
    setOpenStages((prev) => ({ ...prev, [stage]: !prev[stage] }));
  };

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
        map.set(memo.stage, [memo]);
      }
    }
    return map;
  }, [memos, stages]);

  const memoById = useMemo(() => {
    const map = new Map<string, Memo>();
    for (const m of memos) map.set(m.id, m);
    return map;
  }, [memos]);

  if (memos.length === 0 && !notes && stageArchives.length === 0) {
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
        <Chip className="text-xs">{memos.length} memo{memos.length !== 1 ? 's' : ''}</Chip>
      </div>

      {hasArchives ? (
        <>
          {stageArchives.map((archive) => {
            const isOpen = openStages[archive.stageName] ?? true;
            const archiveMemos = archive.memoIds
              .map((id) => memoById.get(id))
              .filter((m): m is Memo => !!m);
            const hasContent = !!archive.freeformText || !!archive.freeformHtml || archiveMemos.length > 0;
            if (!hasContent) return null;

            return (
              <div key={`archive-${archive.stageIndex}`} className="border-t border-border pt-3 mb-3 last:mb-0">
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
                  onClick={() => toggleStage(archive.stageName)}
                >
                  {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                  <span>{archive.stageName}</span>
                  {archiveMemos.length > 0 && (
                    <Chip className="text-xs ml-1">{archiveMemos.length}</Chip>
                  )}
                </button>
                <AnimatePresence>
                  {isOpen && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.3 }}
                      className="mt-2 pl-6 overflow-hidden space-y-2"
                    >
                      {(archive.freeformHtml || archive.freeformText) && (
                        <div
                          className="text-sm text-ink-secondary leading-relaxed prose prose-sm max-w-none memo-highlight-view"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(archive.freeformHtml || archive.freeformText || '') }}
                        />
                      )}
                      {archiveMemos.map((memo) => {
                        const config = MEMO_TYPE_CONFIG[memo.type];
                        const MemoIcon = config.icon;
                        return (
                          <div
                            key={memo.id}
                            className={`border border-border border-l-[3px] ${config.borderColor} rounded-[--radius-button] p-3 hover:bg-surface-hover transition-colors`}
                          >
                            <div className="flex items-start gap-2">
                              <div className="flex items-center gap-1.5 shrink-0">
                                <Chip variant={config.chipVariant} className="text-xs">
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
        </>
      ) : (
        <>
          {notes && (
            <div className="border-t border-border pt-3 mb-3">
              <button
                type="button"
                className="flex items-center gap-1.5 text-sm font-semibold text-ink cursor-pointer w-full text-left transition-all duration-200"
                onClick={() => toggleStage('__notes__')}
              >
                {(openStages['__notes__'] ?? true) ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                <FileText className="w-3.5 h-3.5 text-accent" />
                Free-form Notes
              </button>
              <AnimatePresence>
                {(openStages['__notes__'] ?? true) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.3 }}
                    className="mt-2 pl-6 overflow-hidden"
                  >
                    <div
                      className="text-sm text-ink-secondary leading-relaxed prose prose-sm max-w-none"
                      dangerouslySetInnerHTML={{ __html: sanitizeHtml(notes) }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

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
                  <Chip className="text-xs ml-1">{stageMemos.length}</Chip>
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
                                <Chip variant={config.chipVariant} className="text-xs">
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
        </>
      )}
    </Card>
  );
}

/* ─── Demo Data ───────────────────────────────────────── */

const DEMO_REPORT: FeedbackReport = {
  session_id: 'demo_session',
  session_name: 'Demo Session (Sample Data)',
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
            { id: 'c-a-l1', text: 'Proactively set the agenda and guided topic transitions, keeping the discussion focused on key objectives.', category: 'strength', confidence: 0.92, evidence_refs: ['ev-1', 'ev-2'] },
            { id: 'c-a-l2', text: 'Occasionally dominated the conversation without checking for input from others.', category: 'risk', confidence: 0.84, evidence_refs: ['ev-5'] },
            { id: 'c-a-l3', text: 'Practice structured hand-offs when transitioning topics to ensure all voices are heard.', category: 'action', confidence: 0.88, evidence_refs: ['ev-5', 'ev-2'] },
          ],
        },
        {
          dimension: 'collaboration',
          claims: [
            { id: 'c-a-co1', text: 'Built on Bob\'s points effectively by acknowledging contributions before adding her own perspective.', category: 'strength', confidence: 0.91, evidence_refs: ['ev-3', 'ev-4'] },
            { id: 'c-a-co2', text: 'Create explicit opportunities to invite quieter participants to share their views.', category: 'action', confidence: 0.79, evidence_refs: ['ev-5'] },
          ],
        },
        {
          dimension: 'logic',
          claims: [
            { id: 'c-a-lo1', text: 'Applied MECE framework correctly to segment the problem space.', category: 'strength', confidence: 0.89, evidence_refs: ['ev-6'] },
            { id: 'c-a-lo2', text: 'Some quantitative assumptions lacked explicit sourcing or validation.', category: 'risk', confidence: 0.76, evidence_refs: ['ev-7'] },
          ],
        },
      ],
      summary: {
        strengths: 'Strong leadership and structured thinking with effective framework application.',
        risks: 'Tendency to dominate discussion; quantitative assumptions occasionally unsupported.',
        actions: 'Practice structured hand-offs; validate assumptions with explicit data sources.',
      },
    },
    {
      person_name: 'Bob Williams',
      speaker_id: 'spk_bob',
      dimensions: [
        {
          dimension: 'logic',
          claims: [
            { id: 'c-b-lo1', text: 'Demonstrated rigorous unit economics reasoning with clear assumptions and calculations.', category: 'strength', confidence: 0.93, evidence_refs: ['ev-9'] },
          ],
        },
        {
          dimension: 'structure',
          claims: [
            { id: 'c-b-st1', text: 'Presented a well-structured three-tier pricing model with clear rationale for each tier.', category: 'strength', confidence: 0.90, evidence_refs: ['ev-10'] },
          ],
        },
        {
          dimension: 'collaboration',
          claims: [
            { id: 'c-b-co1', text: 'Effectively synthesized the discussion at key inflection points, helping the team converge.', category: 'strength', confidence: 0.87, evidence_refs: ['ev-8'] },
          ],
        },
      ],
      summary: {
        strengths: 'Rigorous quantitative analysis and excellent synthesis skills.',
        risks: 'Could take more initiative in driving the overall discussion direction.',
        actions: 'Practice leading problem-framing sections; develop stronger executive presence.',
      },
    },
  ],
  evidence: [
    { id: 'ev-1', timestamp_ms: 45000, speaker: 'Alice Chen', text: 'I think we should break this into three segments: enterprise, mid-market, and SMB. Each has distinct CAC profiles.', confidence: 0.94 },
    { id: 'ev-2', timestamp_ms: 120000, speaker: 'Alice Chen', text: 'Let me pull that thread forward — if we prioritize enterprise first, we get longer sales cycles but higher LTV. That changes our funding runway math significantly.', confidence: 0.91 },
    { id: 'ev-3', timestamp_ms: 198000, speaker: 'Alice Chen', text: 'Bob, that\'s a really interesting angle on the partnership economics. Let me incorporate that into the model.', confidence: 0.88 },
    { id: 'ev-4', timestamp_ms: 267000, speaker: 'Bob Williams', text: 'Building on Alice\'s segmentation — if we assume a 30% reduction in CAC through channel partnerships, the mid-market segment becomes significantly more attractive.', confidence: 0.92 },
    { id: 'ev-5', timestamp_ms: 341000, speaker: 'Alice Chen', text: 'So the next thing we need to address is the go-to-market timeline. I have a pretty clear view on this.', confidence: 0.85 },
    { id: 'ev-6', timestamp_ms: 420000, speaker: 'Alice Chen', text: 'If we break this down using a MECE framework: market size, competitive intensity, regulatory barriers, and technology readiness.', confidence: 0.92 },
    { id: 'ev-7', timestamp_ms: 498000, speaker: 'Alice Chen', text: 'Based on my estimate, the addressable market is around 2 billion. The growth rate should be 15 percent annually.', confidence: 0.78, weak: true, weak_reason: 'Market size assumption not backed by cited data source' },
    { id: 'ev-8', timestamp_ms: 556000, speaker: 'Bob Williams', text: 'Let me try to summarize where we are. We\'ve aligned on the target segment and the differentiation angle. The open question is pricing.', confidence: 0.93 },
    { id: 'ev-9', timestamp_ms: 612000, speaker: 'Bob Williams', text: 'Looking at the unit economics, if we assume a 40 percent gross margin and a 12-month payback period, the price point should fall between 49 and 79 dollars per seat.', confidence: 0.88 },
    { id: 'ev-10', timestamp_ms: 680000, speaker: 'Bob Williams', text: 'Here\'s how I\'d structure the pricing tiers: a free community plan for adoption, a pro plan for individual contributors, and an enterprise plan with SSO and audit logs.', confidence: 0.90 },
  ],
  transcript: [],
  utteranceEvidenceMap: {},
};

/* ─── Sub-components ──────────────────────────────────── */

function FeedbackHeader({
  report,
  onRegenerate,
  onBack,
  statusLabel,
  statusVariant,
  isDemo,
  isEnhanced,
  sessionNotes,
  sessionMemos,
  onTranscriptToggle,
  sessionId,
  baseApiUrl,
}: {
  report: FeedbackReport;
  onRegenerate: (mode?: 'full' | 'report-only') => void;
  onBack: () => void;
  statusLabel?: string;
  statusVariant?: 'success' | 'warning' | 'info' | 'error';
  isDemo?: boolean;
  isEnhanced?: boolean;
  sessionNotes?: string;
  sessionMemos?: Memo[];
  onTranscriptToggle?: () => void;
  sessionId?: string;
  baseApiUrl?: string;
}) {
  const [copiedText, setCopiedText] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);

  const handleCopyText = useCallback(async () => {
    setExporting('copy');
    try {
      const text = buildFullMarkdown(report, sessionNotes, sessionMemos);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    } finally {
      setExporting(null);
    }
  }, [report, sessionNotes, sessionMemos]);

  const handleExportMarkdown = useCallback(() => {
    setExporting('markdown');
    try {
      const md = buildFullMarkdown(report, sessionNotes, sessionMemos);
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${report.session_name.replace(/\s+/g, '_')}_feedback.md`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(null);
    }
  }, [report, sessionNotes, sessionMemos]);

  const handleRegenerate = (mode?: 'full' | 'report-only') => {
    setRegenerating(true);
    onRegenerate(mode);
    setTimeout(() => setRegenerating(false), 3000);
  };

  const handleExportSlack = async () => {
    const webhookUrl = localStorage.getItem('ifb_slack_webhook');
    if (!webhookUrl) {
      alert('Please configure Slack Webhook URL in Settings first.');
      return;
    }
    setExporting('slack');
    try {
      const blocks: Array<{ type: string; text: { type: string; text: string } }> = [
        { type: 'header', text: { type: 'plain_text', text: `Interview Report: ${report.session_name}` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Date:* ${report.date} | *Duration:* ${report.durationLabel || '\u2014'} | *Mode:* ${report.mode}` } },
      ];
      if (report.overall.recommendation) {
        const rec = report.overall.recommendation;
        const label = rec.decision === 'recommend' ? 'RECOMMEND' : rec.decision === 'tentative' ? 'TENTATIVE' : 'NOT RECOMMEND';
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${label}* \u2014 ${rec.rationale}` } });
      }
      for (const person of report.persons) {
        const scores = person.dimensions.map(d => `${d.label_zh || d.dimension}: ${d.score ?? '\u2014'}`).join(' | ');
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${person.person_name}:* ${scores}` } });
      }
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });
    } catch (err) {
      console.warn('Slack export failed:', err);
    } finally {
      setExporting(null);
    }
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
              {isDemo && <Chip variant="default">Demo Data</Chip>}
              <Chip variant={statusVariant || (report.status === 'final' ? 'success' : 'warning')}>
                {statusLabel || (report.status === 'final' ? 'Final Report' : 'Draft')}
              </Chip>
              {isEnhanced && <EnhancedBadge />}
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Button variant="secondary" size="sm" onClick={handleCopyText} disabled={!!exporting}>
          {copiedText ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {exporting === 'copy' ? 'Exporting\u2026' : copiedText ? 'Copied' : 'Copy Text'}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExportMarkdown} disabled={!!exporting}>
          <FileText className="w-3.5 h-3.5" />
          {exporting === 'markdown' ? 'Exporting\u2026' : 'Export Markdown'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!!exporting} onClick={() => {
          setExporting('docx');
          try {
            const md = buildFullMarkdown(report, sessionNotes, sessionMemos);
            const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><style>body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.5}h1{font-size:18pt;color:#0D6A63}h2{font-size:14pt;color:#1A2B33;border-bottom:1px solid #E0D9CE;padding-bottom:4pt}h3{font-size:12pt;color:#566A77}table{border-collapse:collapse;width:100%}td,th{border:1px solid #E0D9CE;padding:4pt 8pt;font-size:10pt}th{background:#F6F2EA}blockquote{border-left:3px solid #0D6A63;padding-left:8pt;color:#566A77;margin:8pt 0}</style></head>
<body>${markdownToSimpleHtml(md)}</body></html>`;
            const blob = new Blob([html], { type: 'application/vnd.ms-word' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${report.session_name.replace(/[/\\?%*:|"<>\s]+/g, '_')}_feedback.doc`;
            a.click();
            URL.revokeObjectURL(url);
          } finally {
            setExporting(null);
          }
        }}>
          <Download className="w-3.5 h-3.5" />
          {exporting === 'docx' ? 'Exporting\u2026' : 'Export DOCX'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!!exporting} onClick={async () => {
          setExporting('pdf');
          try {
            const html = buildPrintHtml(report, sessionNotes, sessionMemos);
            await window.desktopAPI.exportPDF({ sessionName: report.session_name, html });
          } catch (err) {
            console.warn('PDF export failed:', err);
          } finally {
            setExporting(null);
          }
        }}>
          <FileText className="w-3.5 h-3.5" />
          {exporting === 'pdf' ? 'Exporting\u2026' : 'Export PDF'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!!exporting} onClick={handleExportSlack}>
          <MessageSquare className="w-3.5 h-3.5" />
          {exporting === 'slack' ? 'Exporting\u2026' : 'Share to Slack'}
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        {onTranscriptToggle && (
          <Button variant="secondary" size="sm" onClick={onTranscriptToggle}>
            <PanelRight className="w-3.5 h-3.5" />
            Transcript
          </Button>
        )}
        <div className="w-px h-5 bg-border mx-1" />
        <SplitButton
          options={[
            { label: 'Re-generate Report', value: 'report-only', icon: <RefreshCw className="w-3.5 h-3.5" /> },
            { label: 'Full Re-analysis', value: 'full', icon: <FileText className="w-3.5 h-3.5" /> },
          ]}
          onSelect={(v) => handleRegenerate(v as 'full' | 'report-only')}
          loading={regenerating}
        />
      </div>
    </div>
  );
}

function OverallCard({
  report,
  onEvidenceClick,
  onFootnoteClick,
  suggestedDimensions,
  onAcceptSuggestions,
  onDismissSuggestions,
  onInlineEdit,
}: {
  report: FeedbackReport;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onFootnoteClick?: (evidenceId: string) => void;
  suggestedDimensions?: OverallFeedback['suggestedDimensions'];
  onAcceptSuggestions?: () => void;
  onDismissSuggestions?: () => void;
  onInlineEdit?: (fieldPath: string, newValue: string) => void;
}) {
  const [memosOpen, setMemosOpen] = useState(true);
  const [eventsOpen, setEventsOpen] = useState((report.overall?.interaction_events?.length ?? 0) > 0);

  const overallEvidenceMap = useMemo(() => {
    const map = new Map<string, { evidence_id: string; speaker?: { display_name?: string }; time_range_ms?: [number, number]; quote?: string }>();
    for (const ev of report.evidence) {
      map.set(ev.id, {
        evidence_id: ev.id,
        speaker: { display_name: ev.speaker },
        time_range_ms: [ev.timestamp_ms, ev.timestamp_ms],
        quote: ev.text,
      });
    }
    return map;
  }, [report.evidence]);

  const narrativeEvidenceRefs = report.overall.teamSummaryEvidenceRefs ?? report.overall.evidence_refs;
  const { footnoteEntries: overallFootnotes, getFootnoteIndex: getOverallFootnoteIndex } = useFootnotes(narrativeEvidenceRefs, overallEvidenceMap);
  const [expandedOverallRef, setExpandedOverallRef] = useState<string | null>(null);

  const hasNarrative = !!report.overall.teamSummaryNarrative;

  return (
    <Card glass className="border-t-2 border-t-accent p-5">
      <div className="flex items-center gap-3 text-xs text-secondary mb-4">
        <span>{report.date}</span>
        <span>·</span>
        <span>{report.durationLabel ?? formatDuration(report.duration_ms)}</span>
        {report.interviewType && <><span>·</span><span>{report.interviewType}</span></>}
        {report.positionTitle && <><span>·</span><span>目标: {report.positionTitle}</span></>}
      </div>

      <h2 className="text-sm font-semibold text-ink mb-3">{report.persons.length > 1 ? 'Team Summary' : 'Summary'}</h2>

      {hasNarrative ? (
        <div className="mb-4">
          {onInlineEdit ? (
            <InlineEditable
              value={report.overall.teamSummaryNarrative || ''}
              onSave={(v) => onInlineEdit('overall.narrative', v)}
              as="p"
              className="text-sm text-ink-secondary leading-relaxed"
            />
          ) : (
            <p className="text-sm text-ink-secondary leading-relaxed">
              {report.overall.teamSummaryNarrative}
            </p>
          )}
          <span>
            {narrativeEvidenceRefs.map((refId) => {
              const idx = getOverallFootnoteIndex(refId);
              if (idx === 0) return null;
              return (
                <FootnoteRef
                  key={refId}
                  index={idx}
                  expanded={expandedOverallRef === refId}
                  onClick={() => setExpandedOverallRef(expandedOverallRef === refId ? null : refId)}
                />
              );
            })}
          </span>
          <AnimatePresence>
            {expandedOverallRef && (() => {
              const evData = overallEvidenceMap.get(expandedOverallRef);
              if (!evData) return null;
              const startMs = evData.time_range_ms?.[0] ?? 0;
              const minutes = Math.floor(startMs / 60000);
              const seconds = Math.floor((startMs % 60000) / 1000);
              const ts = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
              return (
                <InlineEvidenceCard
                  key={expandedOverallRef}
                  quote={evData.quote ?? ''}
                  speaker={evData.speaker?.display_name ?? '?'}
                  timestamp={ts}
                  confidence={0.8}
                  onViewContext={() => onFootnoteClick?.(expandedOverallRef)}
                />
              );
            })()}
          </AnimatePresence>
          <FootnoteList entries={overallFootnotes} onFootnoteClick={onFootnoteClick} />
        </div>
      ) : (
        <p className="text-sm text-ink-secondary leading-relaxed mb-4">
          {report.overall.team_summary}
        </p>
      )}

      {report.overall.recommendation && (
        <RecommendationBadge recommendation={report.overall.recommendation} />
      )}

      {report.overall.keyFindings && report.overall.keyFindings.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Key Findings</h3>
          {report.overall.keyFindings.map((finding, i) => {
            const findingColor = finding.type === 'strength'
              ? 'border-l-emerald-400 bg-emerald-50/50'
              : finding.type === 'risk'
                ? 'border-l-amber-400 bg-amber-50/50'
                : 'border-l-blue-400 bg-blue-50/50';
            const findingLabel = finding.type === 'strength' ? '优势' : finding.type === 'risk' ? '风险' : '观察';
            return (
              <div key={i} className={`border-l-4 ${findingColor} rounded-r-lg p-3`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-medium text-ink-secondary">{findingLabel}</span>
                </div>
                {onInlineEdit ? (
                  <InlineEditable
                    value={finding.text}
                    onSave={(v) => onInlineEdit(`overall.key_findings.${i}.text`, v)}
                    as="p"
                    className="text-sm text-ink leading-relaxed"
                  />
                ) : (
                  <p className="text-sm text-ink leading-relaxed">{finding.text}</p>
                )}
                <span>
                  {(finding.evidence_refs ?? []).map((refId) => {
                    const idx = getOverallFootnoteIndex(refId);
                    if (idx === 0) return null;
                    return (
                      <FootnoteRef
                        key={refId}
                        index={idx}
                        expanded={expandedOverallRef === refId}
                        onClick={() => setExpandedOverallRef(expandedOverallRef === refId ? null : refId)}
                      />
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {report.mode === 'group' && report.persons.length >= 2 && (
        <CandidateComparison persons={report.persons} />
      )}

      {!hasNarrative && (
        <div className="flex flex-wrap gap-2 mb-4">
          {report.overall.evidence_refs.map((refId) => {
            const ev = getEvidenceById(report, refId);
            if (!ev) return null;
            return (
              <motion.div key={refId} whileHover={{ scale: 1.03 }} transition={{ type: 'spring', stiffness: 400, damping: 17 }}>
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
      )}

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

      {report.persons.length > 1 && report.overall.interaction_events.length > 0 && (
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
      )}

      {report.persons.length > 1 && report.overall.team_dynamics.length > 0 && (
        <div className="border-t border-border pt-3">
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink mb-2">
            <TrendingUp className="w-3.5 h-3.5 text-accent" />
            Team Dynamics
          </div>
          <div className="space-y-1.5 pl-6">
            {report.overall.team_dynamics.map((dyn, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 text-sm leading-relaxed ${dyn.type === 'highlight' ? 'text-success' : 'text-warning'}`}
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
      )}

      {report.improvements?.overall && (
        <div className="bg-blue-50/50 border border-blue-200/50 rounded-lg p-4 mt-4">
          <div className="flex items-center gap-2 mb-2">
            <Lightbulb className="w-4 h-4 text-blue-600" />
            <h3 className="text-sm font-semibold text-blue-900">改进建议</h3>
          </div>
          <p className="text-sm text-ink-secondary leading-relaxed mb-3">
            {report.improvements.overall.summary}
          </p>
          {report.improvements.overall.key_points.length > 0 && (
            <ul className="space-y-1.5">
              {report.improvements.overall.key_points.map((point, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-ink-secondary">
                  <span className="text-blue-500 mt-0.5 shrink-0">•</span>
                  {point}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {report.overall.interviewQuality && (
        <InterviewQualityCard quality={report.overall.interviewQuality} />
      )}

      {suggestedDimensions && suggestedDimensions.length > 0 && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 mt-4">
          <div className="flex items-center gap-2 text-sm font-medium text-accent mb-2">
            <Lightbulb className="w-4 h-4" />
            AI 建议
          </div>
          <div className="space-y-1.5">
            {suggestedDimensions.map((s) => (
              <p key={s.key} className="text-sm text-ink">
                • {s.action === 'add' ? '新增' : s.action === 'mark_not_applicable' ? '标记不适用' : '替换'}
                「{s.label_zh}」— {s.reason}
              </p>
            ))}
          </div>
          <div className="flex gap-2 mt-3">
            <button
              className="px-3 py-1 rounded-md bg-accent text-white text-xs hover:bg-accent/90 transition-colors cursor-pointer"
              onClick={() => onAcceptSuggestions?.()}
            >
              接受建议
            </button>
            <button
              className="px-3 py-1 rounded-md border border-border text-xs text-secondary hover:text-ink transition-colors cursor-pointer"
              onClick={() => onDismissSuggestions?.()}
            >
              保持原维度
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function PersonSummary({ summary, personName, onInlineEdit }: {
  summary: PersonFeedback['summary'];
  personName?: string;
  onInlineEdit?: (fieldPath: string, newValue: string) => void;
}) {
  const prefix = personName ? `persons.${personName}.summary` : 'summary';
  return (
    <div className="border-t border-border mt-4 pt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <h5 className="text-xs font-semibold text-success mb-1">Strengths</h5>
        {onInlineEdit ? (
          <InlineEditable value={summary.strengths} onSave={(v) => onInlineEdit(`${prefix}.strengths`, v)} as="p" className="text-xs text-ink-secondary leading-relaxed" />
        ) : (
          <p className="text-xs text-ink-secondary leading-relaxed">{summary.strengths}</p>
        )}
      </div>
      <div>
        <h5 className="text-xs font-semibold text-warning mb-1">Risks</h5>
        {onInlineEdit ? (
          <InlineEditable value={summary.risks} onSave={(v) => onInlineEdit(`${prefix}.risks`, v)} as="p" className="text-xs text-ink-secondary leading-relaxed" />
        ) : (
          <p className="text-xs text-ink-secondary leading-relaxed">{summary.risks}</p>
        )}
      </div>
      <div>
        <h5 className="text-xs font-semibold text-blue-700 mb-1">Actions</h5>
        {onInlineEdit ? (
          <InlineEditable value={summary.actions} onSave={(v) => onInlineEdit(`${prefix}.actions`, v)} as="p" className="text-xs text-ink-secondary leading-relaxed" />
        ) : (
          <p className="text-xs text-ink-secondary leading-relaxed">{summary.actions}</p>
        )}
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
  onFootnoteClick,
  onInlineEdit,
}: {
  person: PersonFeedback;
  report: FeedbackReport;
  onClaimEdit: (claim: Claim, person: PersonFeedback) => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidence: (claim: Claim) => void;
  onFootnoteClick?: (evidenceId: string) => void;
  onInlineEdit?: (fieldPath: string, newValue: string) => void;
}) {
  const allPersonEvidenceRefs = useMemo(() => {
    const refs: string[] = [];
    for (const dim of person.dimensions) {
      for (const claim of dim.claims) {
        refs.push(...claim.evidence_refs);
      }
    }
    return refs;
  }, [person.dimensions]);

  const personEvidenceMap = useMemo(() => {
    const map = new Map<string, { evidence_id: string; speaker?: { display_name?: string }; time_range_ms?: [number, number]; quote?: string }>();
    for (const ev of report.evidence) {
      map.set(ev.id, {
        evidence_id: ev.id,
        speaker: { display_name: ev.speaker },
        time_range_ms: [ev.timestamp_ms, ev.timestamp_ms],
        quote: ev.text,
      });
    }
    return map;
  }, [report.evidence]);

  const { footnoteEntries, getFootnoteIndex } = useFootnotes(allPersonEvidenceRefs, personEvidenceMap);

  return (
    <Card className="pt-2 px-5 pb-5">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-base font-semibold text-ink">{person.person_name}</h3>
        <Chip>{person.speaker_id}</Chip>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <Chip variant="success" className="text-xs">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'strength').length, 0)} strengths
        </Chip>
        <Chip variant="warning" className="text-xs">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'risk').length, 0)} risks
        </Chip>
        <Chip variant="info" className="text-xs">
          {person.dimensions.reduce((n, d) => n + d.claims.filter((c) => c.category === 'action').length, 0)} actions
        </Chip>
      </div>
      {person.dimensions.length >= 3 && (
        <RadarChart dimensions={person.dimensions} />
      )}
      {person.communicationMetrics && (
        <CommunicationMetrics metrics={person.communicationMetrics} />
      )}
      {person.dimensions.map((dim) => {
        const dimImprovement = report.improvements?.dimensions.find(
          di => di.dimension === dim.dimension
        );
        return (
          <DimensionSection
            key={dim.dimension}
            dim={dim}
            report={report}
            onClaimEdit={(claim) => onClaimEdit(claim, person)}
            onEvidenceClick={onEvidenceClick}
            onNeedsEvidence={onNeedsEvidence}
            getFootnoteIndex={getFootnoteIndex}
            onFootnoteClick={onFootnoteClick}
            dimensionImprovement={dimImprovement}
            onInlineEdit={onInlineEdit}
          />
        );
      })}
      <PersonSummary summary={person.summary} personName={person.person_name} onInlineEdit={onInlineEdit} />
      {report.improvements?.follow_up_questions && (
        <FollowUpQuestions questions={report.improvements.follow_up_questions} />
      )}
      {report.improvements?.action_plan && (
        <ActionPlanCard items={report.improvements.action_plan} />
      )}
      {footnoteEntries.length > 0 && (
        <FootnoteList entries={footnoteEntries} onFootnoteClick={onFootnoteClick} />
      )}
    </Card>
  );
}

/* ─── DraftBanner ────────────────────────────────────── */

function DraftBanner({
  message,
  isDemo,
  showRetry,
  onRetry,
}: {
  message?: string;
  isDemo?: boolean;
  showRetry?: boolean;
  onRetry?: () => void;
}) {
  const defaultMsg = isDemo
    ? 'This is demo data. Start a real session to generate an actual report.'
    : 'This report is a draft. Content may change once finalization completes.';
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-center gap-2 px-4 py-2.5 ${
        isDemo ? 'bg-blue-50 border-blue-200' : showRetry ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'
      } border rounded-[--radius-card] mb-4`}
    >
      <div className={`w-2 h-2 rounded-full ${isDemo ? 'bg-blue-400' : showRetry ? 'bg-error' : 'bg-warning'} ${showRetry ? '' : 'animate-pulse'} shrink-0`} />
      <span className={`text-sm ${isDemo ? 'text-blue-600' : showRetry ? 'text-error' : 'text-warning'} font-medium flex-1`}>
        {message || defaultMsg}
      </span>
      {showRetry && onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
        </Button>
      )}
    </motion.div>
  );
}

/* ─── Tier2Banner ────────────────────────────────────── */

function Tier2Banner({ status, progress }: { status: 'tier2_running' | 'tier2_ready'; progress?: number }) {
  if (status === 'tier2_ready') {
    return (
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-[--radius-card] mb-4"
      >
        <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
        <span className="text-sm text-emerald-700 font-medium flex-1">
          Enhanced report ready — transcript and speaker identification have been refined.
        </span>
      </motion.div>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 px-4 py-2.5 bg-blue-50 border border-blue-200 rounded-[--radius-card] mb-4"
    >
      <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
      <span className="text-sm text-blue-600 font-medium flex-1">
        Refining report with enhanced transcription...{progress != null && progress > 0 ? ` ${progress}%` : ''}
      </span>
    </motion.div>
  );
}

/* ─── EnhancedBadge ──────────────────────────────────── */

function EnhancedBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Sparkles className="w-3 h-3" />
      Enhanced
    </span>
  );
}

/* ─── SectionStickyHeader ────────────────────────────── */

function SectionStickyHeader({ icon: Icon, title }: { icon: typeof Activity; title: string }) {
  return (
    <div className="sticky top-0 z-10 bg-bg">
      <div className="flex items-center gap-2 py-1.5 border-b border-border/40">
        <Icon className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wider">{title}</span>
      </div>
    </div>
  );
}

/* ─── SectionNav ─────────────────────────────────────── */

function SectionNav({
  report,
  activeSection,
  onSectionClick,
  hasNotes,
}: {
  report: FeedbackReport;
  activeSection: string;
  onSectionClick: (id: string) => void;
  hasNotes?: boolean;
}) {
  const hasQuestions = (report.overall.questionAnalysis?.length ?? 0) > 0;
  const sections = [
    { id: 'overview', label: 'Overview' },
    ...(hasNotes ? [{ id: 'notes', label: 'Session Notes' }] : []),
    ...(hasQuestions ? [{ id: 'questions', label: 'Q&A Analysis' }] : []),
    ...report.persons.map((p) => ({ id: `person-${p.speaker_id}`, label: p.person_name })),
    ...(report.transcript.length > 0 ? [{ id: 'transcript', label: 'Transcript' }] : []),
  ];

  return (
    <nav className="w-44 shrink-0 pt-6 hidden lg:block overflow-y-auto">
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2 px-2">Sections</h3>
      <ul className="space-y-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              onClick={() => onSectionClick(section.id)}
              className={`w-full text-left px-2 py-1.5 rounded-[--radius-button] text-sm transition-colors cursor-pointer ${
                activeSection === section.id
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-ink-secondary hover:bg-surface-hover hover:text-ink'
              }`}
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ─── Main View ───────────────────────────────────────── */

export function FeedbackView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  const [sessionData] = useState<SessionData | null>(() => {
    if (sessionId) {
      try {
        const stored = localStorage.getItem(`ifb_session_data_${sessionId}`);
        if (stored) return JSON.parse(stored) as SessionData;
      } catch { /* ignore parse errors */ }
    }

    const locState = location.state as SessionData | null;
    if (locState?.sessionName) return locState;

    if (sessionId) {
      try {
        const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
        const match = sessions.find((s: Record<string, unknown>) => s.id === sessionId);
        if (match) {
          return {
            sessionName: match.name as string,
            mode: match.mode as string,
            participants: (match.participants as string[]) || [],
            date: match.date as string,
          };
        }
      } catch { /* ignore */ }
    }

    return null;
  });

  const {
    report,
    sessionMemos,
    sessionNotes,
    sessionStages,
    sessionStageArchives,
    finalizeStatus,
    finalizeError,
    finalizeProgressInfo,
    reportLoading,
    tier2Progress,
    isDemo,
    statusLabel,
    statusVariant,
    handleRetryFinalize,
    handleRegenerate,
    handleInlineEdit,
    setApiReport,
  } = useFeedbackData(sessionId, sessionData, DEMO_REPORT);

  // Modal state
  const [editClaim, setEditClaim] = useState<Claim | null>(null);
  const [detailEvidence, setDetailEvidence] = useState<EvidenceRef | null>(null);
  const [evidenceModalMode, setEvidenceModalMode] = useState<'browse' | 'claim-editor'>('browse');
  const [dismissedSuggestions, setDismissedSuggestions] = useState(false);

  const handleClaimEdit = (claim: Claim, _person: PersonFeedback) => { setEditClaim(claim); };
  const handleEvidenceClick = (ev: EvidenceRef) => { setDetailEvidence(ev); setEvidenceModalMode('browse'); };
  const handleEvidenceClickFromEditor = (ev: EvidenceRef) => { setDetailEvidence(ev); setEvidenceModalMode('claim-editor'); };
  const handleNeedsEvidence = (claim: Claim) => { setEditClaim(claim); };

  const handleSaveClaim = useCallback((claimId: string, text: string, evidenceRefs: string[]) => {
    setApiReport((prev) => prev ? updateClaimInReport(prev, claimId, (c) => ({ ...c, text, evidence_refs: evidenceRefs })) : null);
    if (sessionId && sessionData?.baseApiUrl) {
      window.desktopAPI.updateFeedbackClaimEvidence({
        baseUrl: sessionData.baseApiUrl,
        sessionId: sessionId!,
        body: { claim_id: claimId, text, evidence_refs: evidenceRefs },
      }).catch(() => { /* non-fatal */ });
    }
  }, [sessionId, sessionData?.baseApiUrl, setApiReport]);

  const handleAcceptSuggestions = useCallback(() => {
    console.log('Accepted dimension suggestions:', report?.overall?.suggestedDimensions);
    setDismissedSuggestions(true);
  }, [report]);

  const handleDismissSuggestions = useCallback(() => { setDismissedSuggestions(true); }, []);

  // Section navigation + scroll-spy
  const [activeSection, setActiveSection] = useState('overview');
  const contentRef = useRef<HTMLDivElement>(null);

  // Split view: transcript sidebar
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [scrollToUtteranceId, setScrollToUtteranceId] = useState<string | null>(null);
  const [highlightedUtteranceIds, setHighlightedUtteranceIds] = useState<Set<string>>(new Set());

  const handleSectionClick = useCallback((id: string) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  useEffect(() => {
    const container = contentRef.current;
    if (!container || reportLoading) return;

    let rafId = 0;
    const handleScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const sections = container.querySelectorAll<HTMLElement>('[data-section]');
        const offset = container.getBoundingClientRect().top;
        let current = 'overview';
        for (const section of sections) {
          if (section.getBoundingClientRect().top - offset <= 100) {
            current = section.id;
          }
        }
        setActiveSection(current);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafId);
    };
  }, [report, reportLoading]);

  const handleFootnoteClick = useCallback((evidenceId: string) => {
    const ev = report.evidence.find(e => e.id === evidenceId);
    if (!ev) return;
    const uttIds = new Set<string>();
    for (const [uid, evIds] of Object.entries(report.utteranceEvidenceMap)) {
      if (evIds.includes(evidenceId)) uttIds.add(uid);
    }
    if (uttIds.size === 0) {
      for (const u of report.transcript) {
        if (u.text && ev.text && u.text.includes(ev.text.slice(0, 30))) {
          uttIds.add(u.utterance_id);
        }
      }
    }
    setHighlightedUtteranceIds(uttIds);
    setScrollToUtteranceId(uttIds.size > 0 ? Array.from(uttIds)[0] : null);
    if (!transcriptOpen) setTranscriptOpen(true);
  }, [report, transcriptOpen]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {!reportLoading && (
        <div className="shrink-0 bg-bg border-b border-border">
          <div className="max-w-5xl mx-auto px-6 pt-6 pb-4">
            <FeedbackHeader
              report={report}
              onRegenerate={(mode) => handleRegenerate(mode || 'full')}
              onBack={() => navigate('/history')}
              statusLabel={statusLabel}
              statusVariant={statusVariant}
              isDemo={isDemo}
              isEnhanced={finalizeStatus === 'tier2_ready'}
              sessionNotes={sessionNotes}
              onTranscriptToggle={report.transcript.length > 0 ? () => setTranscriptOpen(v => !v) : undefined}
              sessionMemos={sessionMemos}
              sessionId={sessionId}
              baseApiUrl={sessionData?.baseApiUrl}
            />

            {(report.status === 'draft' || isDemo) && (
              <DraftBanner
                isDemo={isDemo}
                showRetry={finalizeStatus === 'error'}
                onRetry={handleRetryFinalize}
                message={
                  isDemo ? undefined
                    : finalizeStatus === 'finalizing' ? 'Report is being finalized. Content will update automatically.'
                    : finalizeStatus === 'error' ? finalizeError || 'Finalization failed or timed out.'
                    : undefined
                }
              />
            )}

            {(finalizeStatus === 'tier2_running' || finalizeStatus === 'tier2_ready') && (
              <Tier2Banner status={finalizeStatus} progress={tier2Progress} />
            )}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {reportLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
            <p className="text-sm text-ink-secondary">Loading report...</p>
          </div>
        ) : (
          <div className="flex h-full">
            <div className={`flex-1 overflow-hidden transition-all duration-300 ${transcriptOpen ? 'w-[60%]' : 'w-full'}`}>
              <div className="max-w-5xl mx-auto px-6 h-full flex gap-6">
                <SectionNav
                  report={report}
                  activeSection={activeSection}
                  onSectionClick={handleSectionClick}
                  hasNotes={sessionMemos.length > 0 || !!sessionNotes || (sessionStageArchives?.length ?? 0) > 0}
                />

                <motion.div
                  ref={contentRef}
                  initial="hidden"
                  animate="visible"
                  className="flex-1 min-w-0 overflow-y-auto scroll-smooth"
                >
                  <section id="overview" data-section className="pb-4 pt-6">
                    <SectionStickyHeader icon={Activity} title="Overview" />
                    <motion.div variants={fadeInUp} custom={1}>
                      <OverallCard
                        report={report}
                        onEvidenceClick={handleEvidenceClick}
                        onFootnoteClick={handleFootnoteClick}
                        suggestedDimensions={!dismissedSuggestions ? report.overall.suggestedDimensions : undefined}
                        onAcceptSuggestions={handleAcceptSuggestions}
                        onDismissSuggestions={handleDismissSuggestions}
                        onInlineEdit={handleInlineEdit}
                      />
                    </motion.div>
                  </section>

                  {(sessionMemos.length > 0 || sessionNotes || (sessionStageArchives?.length ?? 0) > 0) && (
                    <section id="notes" data-section className="pb-4">
                      <SectionStickyHeader icon={BookOpen} title="Session Notes" />
                      <motion.div variants={fadeInUp} custom={2}>
                        <StageMemosSection
                          memos={sessionMemos}
                          stages={sessionStages}
                          notes={sessionNotes}
                          stageArchives={sessionStageArchives}
                        />
                      </motion.div>
                    </section>
                  )}

                  {report.overall.questionAnalysis && report.overall.questionAnalysis.length > 0 && (
                    <section id="questions" data-section className="pb-4">
                      <SectionStickyHeader icon={HelpCircle} title="Question-by-Question Analysis" />
                      <motion.div variants={fadeInUp} custom={2.5}>
                        <Card className="p-5">
                          <QuestionBreakdownSection questions={report.overall.questionAnalysis} transcript={report.transcript} />
                        </Card>
                      </motion.div>
                    </section>
                  )}

                  {report.persons.length === 0 && (finalizeStatus === 'awaiting' || finalizeStatus === 'finalizing') && !isDemo && (
                    <motion.div variants={fadeInUp} custom={3} className="py-4">
                      <Card className="p-8 text-center">
                        <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto mb-3" />
                        <p className="text-sm text-ink-secondary">Generating feedback report...</p>
                        {finalizeProgressInfo ? (
                          <div className="mt-2">
                            <div className="w-48 h-1.5 bg-border rounded-full mx-auto overflow-hidden">
                              <div className="h-full bg-accent rounded-full transition-all duration-500" style={{ width: `${Math.min(finalizeProgressInfo.progress, 100)}%` }} />
                            </div>
                            <p className="text-xs text-ink-tertiary mt-1.5">
                              {finalizeProgressInfo.stage === 'local_asr' ? 'Transcribing audio' :
                               finalizeProgressInfo.stage === 'cluster' ? 'Identifying speakers' :
                               finalizeProgressInfo.stage === 'reconcile' ? 'Reconciling transcript' :
                               finalizeProgressInfo.stage === 'report' ? 'Generating analysis' :
                               finalizeProgressInfo.stage === 'persist' ? 'Saving results' :
                               finalizeProgressInfo.stage}... {finalizeProgressInfo.progress}%
                            </p>
                          </div>
                        ) : (
                          <p className="text-xs text-ink-tertiary mt-1">
                            This may take a few minutes. The page will update automatically.
                          </p>
                        )}
                      </Card>
                    </motion.div>
                  )}

                  {report.persons.map((person, index) => (
                    <section key={person.speaker_id} id={`person-${person.speaker_id}`} data-section className="pb-4">
                      <SectionStickyHeader icon={User} title={person.person_name} />
                      <motion.div variants={fadeInUp} custom={index + 3}>
                        <PersonFeedbackCard
                          person={person}
                          report={report}
                          onClaimEdit={handleClaimEdit}
                          onEvidenceClick={handleEvidenceClick}
                          onNeedsEvidence={handleNeedsEvidence}
                          onFootnoteClick={handleFootnoteClick}
                          onInlineEdit={handleInlineEdit}
                        />
                      </motion.div>
                    </section>
                  ))}

                  {report.transcript.length > 0 && (
                    <section id="transcript" data-section className="pb-4">
                      <SectionStickyHeader icon={ScrollText} title="Transcript" />
                      <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
                        <TranscriptSection
                          transcript={report.transcript}
                          evidenceMap={report.utteranceEvidenceMap}
                          onEvidenceBadgeClick={(evId) => {
                            const ev = report.evidence.find(e => e.id === evId);
                            if (ev) { setDetailEvidence(ev); setEvidenceModalMode('browse'); }
                          }}
                          scrollToUtteranceId={null}
                        />
                      </motion.div>
                    </section>
                  )}

                  <div className="h-16" aria-hidden="true" />
                </motion.div>
              </div>
            </div>

            {transcriptOpen && (
              <div className="w-[40%] border-l border-border flex flex-col bg-white shrink-0">
                <div className="flex items-center justify-between p-3 border-b border-border shrink-0">
                  <span className="text-sm font-medium text-ink">Transcript</span>
                  <button
                    onClick={() => setTranscriptOpen(false)}
                    className="text-ink-secondary hover:text-ink transition-colors cursor-pointer"
                    aria-label="Close transcript panel"
                  >
                    <PanelRightClose className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 overflow-hidden">
                  <TranscriptSection
                    transcript={report.transcript}
                    evidenceMap={report.utteranceEvidenceMap}
                    onEvidenceBadgeClick={(evId) => {
                      const ev = report.evidence.find(e => e.id === evId);
                      if (ev) { setDetailEvidence(ev); setEvidenceModalMode('browse'); }
                    }}
                    scrollToUtteranceId={scrollToUtteranceId}
                    highlightedUtteranceIds={highlightedUtteranceIds}
                    fillHeight
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <EditClaimModal
        open={editClaim !== null && detailEvidence === null}
        onClose={() => setEditClaim(null)}
        claim={editClaim}
        report={report}
        onEvidenceClick={handleEvidenceClickFromEditor}
        sessionId={sessionId}
        baseApiUrl={sessionData?.baseApiUrl}
        onSave={handleSaveClaim}
      />

      <EvidenceDetailModal
        open={detailEvidence !== null}
        onClose={() => { setDetailEvidence(null); }}
        evidence={detailEvidence}
        report={report}
        mode={evidenceModalMode}
        onUseAsEvidence={() => {
          if (editClaim && detailEvidence) {
            setApiReport((prev) => prev ? updateClaimInReport(prev, editClaim.id, (c) => ({
              ...c,
              evidence_refs: c.evidence_refs.includes(detailEvidence.id)
                ? c.evidence_refs
                : [...c.evidence_refs, detailEvidence.id],
            })) : null);
            setEditClaim((prev) => prev ? {
              ...prev,
              evidence_refs: prev.evidence_refs.includes(detailEvidence.id)
                ? prev.evidence_refs
                : [...prev.evidence_refs, detailEvidence.id],
            } : null);
            if (sessionId && sessionData?.baseApiUrl) {
              window.desktopAPI.updateFeedbackClaimEvidence({
                baseUrl: sessionData.baseApiUrl,
                sessionId: sessionId!,
                body: { claim_id: editClaim.id, evidence_refs: [...editClaim.evidence_refs, detailEvidence.id] },
              }).catch(() => { /* non-fatal */ });
            }
          }
          setDetailEvidence(null);
        }}
        onRemove={() => {
          if (editClaim && detailEvidence) {
            setApiReport((prev) => prev ? updateClaimInReport(prev, editClaim.id, (c) => ({
              ...c,
              evidence_refs: c.evidence_refs.filter(id => id !== detailEvidence.id),
            })) : null);
            setEditClaim((prev) => prev ? {
              ...prev,
              evidence_refs: prev.evidence_refs.filter(id => id !== detailEvidence.id),
            } : null);
          }
          setDetailEvidence(null);
        }}
      />
    </div>
  );
}
