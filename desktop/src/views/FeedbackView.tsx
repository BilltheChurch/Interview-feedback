import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  Loader2,
  Sparkles,
  ScrollText,
  PanelRight,
  PanelRightClose,
  Lightbulb,
} from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
import { TranscriptSection, type TranscriptUtterance, type UtteranceEvidenceMap } from '../components/TranscriptSection';
import { SplitButton } from '../components/ui/SplitButton';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { Chip } from '../components/ui/Chip';
import { EvidenceChip } from '../components/ui/EvidenceChip';
import { ConfidenceBadge } from '../components/ui/ConfidenceBadge';
import { Modal } from '../components/ui/Modal';
import { TextArea } from '../components/ui/TextArea';
import { FootnoteRef } from '../components/ui/FootnoteRef';
import { FootnoteList, type FootnoteEntry } from '../components/ui/FootnoteList';
import { InlineEvidenceCard } from '../components/ui/InlineEvidenceCard';
import { InlineEditable } from '../components/ui/InlineEditable';
import { CommunicationMetrics } from '../components/CommunicationMetrics';
import { CandidateComparison } from '../components/CandidateComparison';
import { RecommendationBadge } from '../components/RecommendationBadge';
import { QuestionBreakdownSection, type QuestionAnalysisItem } from '../components/QuestionBreakdownSection';
import { escapeHtml, sanitizeHtml } from '../lib/sanitize';
import { InterviewQualityCard } from '../components/InterviewQualityCard';
import { FollowUpQuestions } from '../components/FollowUpQuestions';
import { ActionPlanCard } from '../components/ActionPlanCard';
import { useFootnotes } from '../hooks/useFootnotes';

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
  end_ms?: number;
  speaker: string;
  text: string;
  confidence: number;
  weak?: boolean;
  weak_reason?: string;
  utterance_ids?: string[];
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
  label_zh?: string;
  score?: number;                   // 0-10, from LLM
  score_rationale?: string;
  evidence_insufficient?: boolean;
  not_applicable?: boolean;
  claims: Claim[];
};

type CommunicationMetricsData = {
  speakingTimeSec: number;
  totalSessionSec: number;
  speakingRatio: number;
  avgResponseSec: number;
  fillerWordCount: number;
  fillerWordsPerMin: number;
  avgLatencySec: number;
  longestPauseSec: number;
  turnCount: number;
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
  communicationMetrics?: CommunicationMetricsData;
};

type TeamDynamic = {
  type: 'highlight' | 'risk';
  text: string;
};

type Recommendation = {
  decision: 'recommend' | 'tentative' | 'not_recommend';
  confidence: number;
  rationale: string;
  context_type: 'hiring' | 'admission';
};

type OverallFeedback = {
  team_summary: string;
  teacher_memos: string[];
  interaction_events: string[];
  team_dynamics: TeamDynamic[];
  evidence_refs: string[];
  // New narrative-based fields
  teamSummaryNarrative?: string;
  teamSummaryEvidenceRefs?: string[];
  keyFindings?: Array<{
    type: 'strength' | 'risk' | 'observation';
    text: string;
    evidence_refs: string[];
  }>;
  suggestedDimensions?: Array<{
    key: string;
    label_zh: string;
    reason: string;
    action: 'add' | 'replace' | 'mark_not_applicable';
    replaces?: string;
  }>;
  recommendation?: Recommendation;
  questionAnalysis?: QuestionAnalysisItem[];
  interviewQuality?: {
    coverage_ratio: number;
    follow_up_depth: number;
    structure_score: number;
    suggestions: string;
  };
};

type ClaimBeforeAfter = {
  before: string;
  after: string;
};

type ClaimImprovement = {
  claim_id: string;
  advice: string;
  suggested_wording: string;
  before_after: ClaimBeforeAfter | null;
};

type DimensionImprovement = {
  dimension: string;
  advice: string;
  framework: string;
  example_response: string;
};

type OverallImprovement = {
  summary: string;
  key_points: string[];
};

type ImprovementReport = {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
  follow_up_questions?: Array<{ question: string; purpose: string; related_claim_id?: string }>;
  action_plan?: Array<{ action: string; related_claim_id?: string; practice_method: string; expected_outcome: string }>;
};

type FeedbackReport = {
  session_id: string;
  session_name: string;
  date: string;
  duration_ms: number;
  durationLabel?: string;
  status: 'draft' | 'final';
  mode: '1v1' | 'group';
  participants: string[];
  overall: OverallFeedback;
  persons: PersonFeedback[];
  evidence: EvidenceRef[];
  transcript: TranscriptUtterance[];
  utteranceEvidenceMap: UtteranceEvidenceMap;
  captionSource?: string;
  interviewType?: string;
  positionTitle?: string;
  improvements?: ImprovementReport;
};

/* ─── Legacy Score Helpers ─────────────────────────────── */

function calculateLegacyScore(dim: any): number {
  const total = (dim.strengths?.length ?? 0) + (dim.risks?.length ?? 0) + (dim.actions?.length ?? 0);
  if (total === 0) return 5;
  const strengthRatio = (dim.strengths?.length ?? 0) / total;
  return Math.round(strengthRatio * 10 * 10) / 10;
}

function legacyDimensionLabel(dimension: string): string {
  const map: Record<string, string> = {
    leadership: '领导力', collaboration: '协作能力', logic: '逻辑推理',
    structure: '表达结构', initiative: '主动性',
  };
  return map[dimension] ?? dimension;
}

/* ─── Inline Evidence Ref Stripper ─────────────────────── */

function stripInlineEvidenceRefs(text: string): { cleanText: string; extractedRefs: string[] } {
  const refs: string[] = [];
  const clean = text.replace(/\[e_\d+\]/g, (match) => {
    refs.push(match.slice(1, -1));  // "e_000921"
    return '';
  });
  return { cleanText: clean.trim(), extractedRefs: refs };
}

/* ─── API → Frontend Report Transformer ───────────────── */
// The backend API (ResultV2) uses a different schema than the frontend FeedbackReport.
// This function normalizes the API response into the shape the UI expects.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function normalizeApiReport(raw: any, sessionMeta?: { name?: string; date?: string; durationMs?: number; mode?: string; participants?: string[] }): FeedbackReport {
  // ── participants: extract display_name from stats or speaker_map ──
  const participants: string[] = (() => {
    // If raw.stats exists, use speaker_name from stats
    if (Array.isArray(raw.stats)) {
      return raw.stats
        .map((s: any) => s.speaker_name || s.speaker_key || 'Unknown')
        .filter((n: string) => n !== 'Unknown');
    }
    // If raw.participants is string[], use directly
    if (Array.isArray(raw.participants)) {
      return raw.participants.map((p: any) =>
        typeof p === 'string' ? p : p?.display_name || p?.person_id || 'Unknown'
      );
    }
    return sessionMeta?.participants || [];
  })();

  // ── overall.team_summary: flatten summary_sections into a single string ──
  const teamSummary: string = (() => {
    if (typeof raw.overall?.team_summary === 'string') return raw.overall.team_summary;
    if (Array.isArray(raw.overall?.summary_sections)) {
      return raw.overall.summary_sections
        .map((s: any) => (Array.isArray(s.bullets) ? s.bullets.join(' ') : ''))
        .filter(Boolean)
        .join('\n\n');
    }
    return '';
  })();

  // ── Team Summary — new narrative format ──
  let teamSummaryNarrative = '';
  let teamSummaryEvidenceRefs: string[] = [];
  const overall = raw.overall;
  if (overall?.narrative) {
    teamSummaryNarrative = overall.narrative;
    teamSummaryEvidenceRefs = overall.narrative_evidence_refs ?? [];
  } else if (overall?.summary_sections) {
    // Legacy: flatten bullets into narrative
    teamSummaryNarrative = (overall.summary_sections as any[])
      .map((s: any) => s.bullets?.join(' '))
      .filter(Boolean)
      .join('\n\n');
  }

  const keyFindings = overall?.key_findings ?? [];
  const suggestedDimensions = overall?.suggested_dimensions ?? [];

  // ── overall.teacher_memos: from memos[] or overall ──
  const teacherMemos: string[] = (() => {
    if (Array.isArray(raw.overall?.teacher_memos)) return raw.overall.teacher_memos;
    if (Array.isArray(raw.memos)) {
      return raw.memos.map((m: any) => {
        const prefix = m.stage ? `[${m.stage}] ` : '';
        return `${prefix}${m.text || ''}`;
      });
    }
    return [];
  })();

  // ── overall.team_dynamics: normalize object {highlights, risks} → TeamDynamic[] ──
  const teamDynamics: TeamDynamic[] = (() => {
    const td = raw.overall?.team_dynamics;
    if (Array.isArray(td)) return td; // already correct shape
    if (td && typeof td === 'object') {
      const result: TeamDynamic[] = [];
      if (Array.isArray(td.highlights)) {
        for (const h of td.highlights) result.push({ type: 'highlight', text: String(h) });
      }
      if (Array.isArray(td.risks)) {
        for (const r of td.risks) result.push({ type: 'risk', text: String(r) });
      }
      return result;
    }
    return [];
  })();

  // ── overall.interaction_events ──
  const interactionEvents: string[] = Array.isArray(raw.overall?.interaction_events)
    ? raw.overall.interaction_events
    : [];

  // ── overall.evidence_refs ──
  const overallEvidenceRefs: string[] = (() => {
    if (Array.isArray(raw.overall?.evidence_refs)) return raw.overall.evidence_refs;
    if (Array.isArray(raw.overall?.summary_sections)) {
      return raw.overall.summary_sections
        .flatMap((s: any) => (Array.isArray(s.evidence_ids) ? s.evidence_ids : []));
    }
    return [];
  })();

  // ── persons: transform per_person[] → PersonFeedback[] ──
  const persons: PersonFeedback[] = (() => {
    const source = Array.isArray(raw.per_person) ? raw.per_person
      : Array.isArray(raw.persons) ? raw.persons
      : [];
    return source.map((p: any) => {
      // Dimensions: merge strengths/risks/actions into unified claims[]
      const dimensions: DimensionFeedback[] = (Array.isArray(p.dimensions) ? p.dimensions : []).map((d: any) => {
        const claims: Claim[] = [];
        // If already has claims[] array (frontend format), use it
        if (Array.isArray(d.claims)) {
          for (const c of d.claims) {
            claims.push({
              id: c.id || c.claim_id || `${d.dimension}_${claims.length}`,
              text: c.text || '',
              category: c.category || 'strength',
              confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
              evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [],
            });
          }
        } else {
          // API format: separate strengths/risks/actions arrays
          for (const c of (Array.isArray(d.strengths) ? d.strengths : [])) {
            claims.push({
              id: c.claim_id || `${d.dimension}_s${claims.length}`,
              text: c.text || '',
              category: 'strength',
              confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
              evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [],
            });
          }
          for (const c of (Array.isArray(d.risks) ? d.risks : [])) {
            claims.push({
              id: c.claim_id || `${d.dimension}_r${claims.length}`,
              text: c.text || '',
              category: 'risk',
              confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
              evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [],
            });
          }
          for (const c of (Array.isArray(d.actions) ? d.actions : [])) {
            claims.push({
              id: c.claim_id || `${d.dimension}_a${claims.length}`,
              text: c.text || '',
              category: 'action',
              confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
              evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [],
            });
          }
        }
        // Strip inline evidence refs like [e_000921] from claim text
        const cleanedClaims = claims.map(claim => {
          const { cleanText, extractedRefs } = stripInlineEvidenceRefs(claim.text);
          return {
            ...claim,
            text: cleanText || claim.text,
            evidence_refs: [...claim.evidence_refs, ...extractedRefs],
          };
        });
        return {
          dimension: d.dimension || 'unknown',
          label_zh: typeof d.label_zh === 'string' ? d.label_zh : legacyDimensionLabel(d.dimension || 'unknown'),
          score: typeof d.score === 'number' ? d.score : calculateLegacyScore(d),
          score_rationale: typeof d.score_rationale === 'string' ? d.score_rationale : '',
          evidence_insufficient: d.evidence_insufficient || false,
          not_applicable: d.not_applicable || false,
          claims: cleanedClaims,
        };
      });

      // Summary: join arrays into single strings
      const summary = p.summary || {};
      return {
        person_name: p.display_name || p.person_name || p.person_key || 'Unknown',
        speaker_id: p.person_key || p.speaker_id || `spk_${participants.indexOf(p.display_name || '')}`,
        dimensions,
        summary: {
          strengths: Array.isArray(summary.strengths) ? summary.strengths.join('. ') : (summary.strengths || ''),
          risks: Array.isArray(summary.risks) ? summary.risks.join('. ') : (summary.risks || ''),
          actions: Array.isArray(summary.actions) ? summary.actions.join('. ') : (summary.actions || ''),
        },
      };
    });
  })();

  // ── evidence: transform evidence[] ──
  const evidence: EvidenceRef[] = (Array.isArray(raw.evidence) ? raw.evidence : []).map((e: any) => ({
    id: e.evidence_id || e.id || '',
    timestamp_ms: Array.isArray(e.time_range_ms) ? e.time_range_ms[0] : (e.timestamp_ms || 0),
    end_ms: Array.isArray(e.time_range_ms) ? e.time_range_ms[1] : (e.end_ms || undefined),
    speaker: typeof e.speaker === 'string' ? e.speaker : (e.speaker?.display_name || e.speaker?.person_id || 'Unknown'),
    text: e.quote || e.text || '',
    confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
    weak: e.weak || false,
    weak_reason: e.weak_reason,
    utterance_ids: Array.isArray(e.utterance_ids) ? e.utterance_ids : undefined,
  }));

  // ── transcript: extract from raw.transcript ──
  const normalizedTranscript: TranscriptUtterance[] = (() => {
    if (!Array.isArray(raw.transcript)) return [];
    return raw.transcript.map((u: any) => ({
      utterance_id: u.utterance_id || '',
      speaker_name: u.speaker_name || null,
      text: u.text || '',
      start_ms: typeof u.start_ms === 'number' ? u.start_ms : 0,
      end_ms: typeof u.end_ms === 'number' ? u.end_ms : 0,
    }));
  })();

  // ── utteranceEvidenceMap: build from evidence[].utterance_ids ──
  const utteranceEvidenceMap: UtteranceEvidenceMap = {};
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  for (const ev of rawEvidence) {
    const evId = ev.evidence_id || ev.id || '';
    const uttIds = Array.isArray(ev.utterance_ids) ? ev.utterance_ids : [];
    for (const uid of uttIds) {
      if (!utteranceEvidenceMap[uid]) utteranceEvidenceMap[uid] = [];
      utteranceEvidenceMap[uid].push(evId);
    }
  }

  // ── captionSource: from session metadata ──
  const captionSource = typeof raw.session?.caption_source === 'string'
    ? raw.session.caption_source
    : typeof raw.caption_source === 'string'
      ? raw.caption_source
      : undefined;

  const durationMs = sessionMeta?.durationMs || raw.duration_ms || 0;

  // ── Communication metrics: compute per-person from transcript ──
  const FILLER_WORDS_EN = /\b(um|uh|like|you know|i mean|basically|actually|so yeah)\b/gi;
  const FILLER_WORDS_ZH = /(就是|然后|那个|嗯|啊|对吧|这个)/g;

  for (const person of persons) {
    const personUtterances = normalizedTranscript.filter(
      u => u.speaker_name === person.person_name
    );
    if (personUtterances.length === 0) continue;

    const speakingTimeSec = personUtterances.reduce(
      (sum, u) => sum + (u.end_ms - u.start_ms) / 1000, 0
    );
    const totalSessionSec = normalizedTranscript.length > 0
      ? (normalizedTranscript[normalizedTranscript.length - 1].end_ms - normalizedTranscript[0].start_ms) / 1000
      : 1;

    let fillerCount = 0;
    for (const u of personUtterances) {
      fillerCount += (u.text.match(FILLER_WORDS_EN) || []).length;
      fillerCount += (u.text.match(FILLER_WORDS_ZH) || []).length;
    }

    const latencies: number[] = [];
    for (let i = 1; i < normalizedTranscript.length; i++) {
      const prev = normalizedTranscript[i - 1];
      const curr = normalizedTranscript[i];
      if (curr.speaker_name === person.person_name && prev.speaker_name !== person.person_name) {
        latencies.push(Math.max(0, (curr.start_ms - prev.end_ms) / 1000));
      }
    }

    person.communicationMetrics = {
      speakingTimeSec: Math.round(speakingTimeSec),
      totalSessionSec: Math.round(totalSessionSec),
      speakingRatio: totalSessionSec > 0 ? speakingTimeSec / totalSessionSec : 0,
      avgResponseSec: personUtterances.length > 0
        ? Math.round(speakingTimeSec / personUtterances.length)
        : 0,
      fillerWordCount: fillerCount,
      fillerWordsPerMin: speakingTimeSec > 0
        ? Math.round((fillerCount / speakingTimeSec) * 60 * 10) / 10
        : 0,
      avgLatencySec: latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10
        : 0,
      longestPauseSec: latencies.length > 0 ? Math.round(Math.max(...latencies) * 10) / 10 : 0,
      turnCount: personUtterances.length,
    };
  }

  // ── Parse recommendation, questionAnalysis, interviewQuality ──
  const recommendation = raw.overall?.recommendation || raw.recommendation || undefined;
  const questionAnalysis = Array.isArray(raw.overall?.question_analysis)
    ? raw.overall.question_analysis
    : Array.isArray(raw.question_analysis)
      ? raw.question_analysis
      : undefined;
  const interviewQuality = raw.overall?.interview_quality || raw.interview_quality || undefined;

  return {
    session_id: raw.session?.session_id || raw.session_id || '',
    session_name: sessionMeta?.name || raw.session_name || '',
    date: sessionMeta?.date || raw.date || new Date().toISOString().slice(0, 10),
    duration_ms: durationMs,
    durationLabel: formatDuration(durationMs),
    status: 'final',
    mode: (sessionMeta?.mode as '1v1' | 'group') || raw.mode || '1v1',
    participants,
    overall: {
      team_summary: teamSummary,
      teacher_memos: teacherMemos,
      interaction_events: interactionEvents,
      team_dynamics: teamDynamics,
      evidence_refs: overallEvidenceRefs,
      // New narrative-based fields
      teamSummaryNarrative: teamSummaryNarrative || undefined,
      teamSummaryEvidenceRefs: teamSummaryEvidenceRefs.length > 0 ? teamSummaryEvidenceRefs : undefined,
      keyFindings: keyFindings.length > 0 ? keyFindings : undefined,
      suggestedDimensions: suggestedDimensions.length > 0 ? suggestedDimensions : undefined,
      recommendation,
      questionAnalysis: questionAnalysis?.length > 0 ? questionAnalysis : undefined,
      interviewQuality,
    },
    persons,
    evidence,
    transcript: normalizedTranscript,
    utteranceEvidenceMap,
    captionSource,
    interviewType: raw.interview_type || raw.overall?.interview_type || undefined,
    positionTitle: raw.position_title || raw.overall?.position_title || undefined,
    improvements: raw.improvements || undefined,
  };
}

/* ─── Demo Data (last-resort fallback only) ───────────── */

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
  transcript: [],
  utteranceEvidenceMap: {},
  improvements: {
    overall: {
      summary: '候选人在本次面试中展现了较强的推动讨论与收敛结论的能力，但在主导节奏与倾听他人之间仍需更好平衡。建议在表达时更主动地确认同伴观点，并采用结构化框架提升逻辑清晰度。',
      key_points: [
        '加强倾听与确认他人观点的回应',
        '使用"结论-依据-验证"三步法强化逻辑推理',
        '在关键节点前先明确分工并给出框架提纲',
      ],
    },
    dimensions: [
      {
        dimension: 'leadership',
        advice: '在主导讨论节奏的同时，应更主动地邀请和确认他人意见，避免单向推进导致协作感减弱。',
        framework: 'PREP 框架（Point-Reason-Example-Point）：先明确立场，再解释原因，举例说明，最后重申观点。',
        example_response: 'I see your point about the freeform notes being hard to manage. Let me summarize: you\'re suggesting we need a way to preserve unstructured thoughts without forcing categorization, right?',
      },
      {
        dimension: 'collaboration',
        advice: '在回应他人观点时，应增加复述与确认性语言，以确保理解一致并促进协作清晰度。',
        framework: 'Active Listening + Confirmation Loop：重复对方核心观点 + 用提问或总结确认理解。',
        example_response: 'So what I\'m hearing is that you\'re concerned about losing context when switching between stages—is that accurate?',
      },
      {
        dimension: 'logic',
        advice: '在提出结论前，应系统性地呈现"结论-依据-验证"链条，使推理更具说服力。',
        framework: '结论-依据-验证（C-I-V）三步法：先说结论，再列出支持依据，最后通过反问或假设验证其合理性。',
        example_response: 'My conclusion is that we should allow persistent freeform notes. The reason is that users often capture insights before they\'re ready to classify. To validate: imagine forcing categorization mid-flow—wouldn\'t that be disruptive?',
      },
    ],
    claims: [
      {
        claim_id: 'c_demo_leadership_02',
        advice: '在主导讨论时，应主动平衡话语权，避免长时间独白，适时引入他人视角。',
        suggested_wording: 'I\'d love to hear your take on this—what do you think about keeping some notes freeform?',
        before_after: {
          before: 'Okay, so yeah, and um. So I might have a problem where I just wanna.',
          after: 'Okay, so I\'ve been thinking about a potential issue here—what if we want to keep some notes freeform? What\'s your perspective?',
        },
      },
      {
        claim_id: 'c_demo_logic_02',
        advice: '在得出结论前，应明确展示证据与推理之间的衔接，避免跳跃式判断。',
        suggested_wording: 'The key insight here is that users need flexibility—because insights emerge unpredictably during interviews.',
        before_after: {
          before: 'So this is a big UX problem, we need to fix it.',
          after: 'So this is a significant UX issue because it breaks the natural note-taking flow. Users capture ideas in real time, but forced classification too early leads to lost insights.',
        },
      },
    ],
  },
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

/** Immutably update a specific claim within a report */
function updateClaimInReport(
  report: FeedbackReport,
  claimId: string,
  updater: (claim: Claim) => Claim,
): FeedbackReport {
  return {
    ...report,
    persons: report.persons.map((person) => ({
      ...person,
      dimensions: person.dimensions.map((dim) => ({
        ...dim,
        claims: dim.claims.map((claim) =>
          claim.id === claimId ? updater(claim) : claim,
        ),
      })),
    })),
  };
}

/** Get surrounding evidence items for context */
type SurroundingUtterance = {
  utterance_id: string;
  speaker: string;
  text: string;
  start_ms: number;
  isPartOfEvidence: boolean;
};

/**
 * Get transcript utterances surrounding an evidence item.
 * Uses the evidence's utterance_ids to find the referenced conversation,
 * then includes 2 utterances before and after for context (including interviewer questions).
 */
function getSurroundingContext(report: FeedbackReport, evidenceId: string): SurroundingUtterance[] {
  const ev = report.evidence.find(e => e.id === evidenceId);
  if (!ev) return [];

  const transcript = report.transcript;
  if (!transcript.length) return [];

  // If evidence has utterance_ids, use them directly
  const evUttIds = new Set(ev.utterance_ids || []);

  if (evUttIds.size > 0) {
    // Find the range of indices covered by this evidence
    const indices = transcript
      .map((u, i) => evUttIds.has(u.utterance_id) ? i : -1)
      .filter(i => i >= 0);
    if (indices.length === 0) return [];

    const minIdx = Math.min(...indices);
    const maxIdx = Math.max(...indices);

    // Include 2 utterances before and 2 after for context
    const startIdx = Math.max(0, minIdx - 2);
    const endIdx = Math.min(transcript.length - 1, maxIdx + 2);

    return transcript.slice(startIdx, endIdx + 1).map(u => ({
      utterance_id: u.utterance_id,
      speaker: u.speaker_name || 'Unknown',
      text: u.text,
      start_ms: u.start_ms,
      isPartOfEvidence: evUttIds.has(u.utterance_id),
    }));
  }

  // Fallback: find by timestamp range
  const evStart = ev.timestamp_ms;
  const evEnd = ev.end_ms || evStart + 1;
  const matchIdx = transcript.findIndex(u => u.start_ms >= evStart && u.start_ms < evEnd);
  if (matchIdx < 0) return [];

  const startIdx = Math.max(0, matchIdx - 2);
  const endIdx = Math.min(transcript.length - 1, matchIdx + 2);

  return transcript.slice(startIdx, endIdx + 1).map(u => ({
    utterance_id: u.utterance_id,
    speaker: u.speaker_name || 'Unknown',
    text: u.text,
    start_ms: u.start_ms,
    isPartOfEvidence: u.start_ms >= evStart && u.start_ms < evEnd,
  }));
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

type StageArchiveProp = {
  stageIndex: number;
  stageName: string;
  archivedAt: string;
  freeformText: string;
  freeformHtml?: string;
  memoIds: string[];
};

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
        map.set(memo.stage, [memo]);
      }
    }
    return map;
  }, [memos, stages]);

  // Build a memo lookup by ID for archive-based display
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

      {/* Stage archives — preferred layout when available */}
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
                      {/* Freeform notes for this stage */}
                      {(archive.freeformHtml || archive.freeformText) && (
                        <div
                          className="text-sm text-ink-secondary leading-relaxed prose prose-sm max-w-none memo-highlight-view"
                          dangerouslySetInnerHTML={{ __html: sanitizeHtml(archive.freeformHtml || archive.freeformText || '') }}
                        />
                      )}
                      {/* Memos for this stage */}
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
          {/* Legacy: Free-form Notes (when no stageArchives) */}
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

          {/* Legacy: Stage-grouped memos (when no stageArchives) */}
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

/* ─── Export Helpers ──────────────────────────────────── */

function buildFullMarkdown(
  report: FeedbackReport,
  sessionNotes?: string,
  sessionMemos?: Memo[],
): string {
  const lines: string[] = [
    `# ${report.session_name}`,
    `**Date:** ${report.date}  `,
    `**Duration:** ${formatDuration(report.duration_ms)}  `,
    `**Mode:** ${report.mode}  `,
    `**Participants:** ${report.participants.join(', ')}`,
    '',
  ];

  // Recommendation
  if (report.overall.recommendation) {
    const rec = report.overall.recommendation;
    const label = rec.decision === 'recommend' ? 'Recommend' : rec.decision === 'tentative' ? 'Tentative' : 'Not Recommend';
    lines.push(`## Recommendation: ${label}`, '');
    lines.push(`**Confidence:** ${Math.round(rec.confidence * 100)}%  `);
    lines.push(`**Rationale:** ${rec.rationale}`, '');
  }

  // Session notes
  const notesText = sessionNotes?.replace(/<[^>]*>/g, '').trim();
  if (notesText) {
    lines.push('## Session Notes', '', notesText, '');
  }

  // Session memos
  if (sessionMemos && sessionMemos.length > 0) {
    lines.push('## Session Memos', '');
    for (const m of sessionMemos) {
      lines.push(`- **[${m.stage}]** ${m.text}`);
    }
    lines.push('');
  }

  // Overall Narrative
  lines.push('## Overview', '');
  if (report.overall.teamSummaryNarrative) {
    lines.push(report.overall.teamSummaryNarrative, '');
  } else if (report.overall.team_summary) {
    lines.push(report.overall.team_summary, '');
  }

  // Key Findings
  if (report.overall.keyFindings && report.overall.keyFindings.length > 0) {
    lines.push('### Key Findings', '');
    for (const f of report.overall.keyFindings) {
      const icon = f.type === 'strength' ? '+' : f.type === 'risk' ? '!' : '>';
      lines.push(`- **[${icon}]** ${f.text}`);
    }
    lines.push('');
  }

  // Interview Quality
  if (report.overall.interviewQuality) {
    const q = report.overall.interviewQuality;
    lines.push('### Interview Quality', '');
    lines.push(`- **Coverage:** ${Math.round(q.coverage_ratio * 100)}%`);
    lines.push(`- **Follow-up Depth:** ${q.follow_up_depth}`);
    lines.push(`- **Structure Score:** ${q.structure_score.toFixed(1)}/10`);
    lines.push(`- **Suggestions:** ${q.suggestions}`);
    lines.push('');
  }

  // Team Dynamics
  if (report.overall.teacher_memos.length > 0) {
    lines.push('### Teacher Memos');
    lines.push(...report.overall.teacher_memos.map((m) => `- ${m}`));
    lines.push('');
  }

  if (report.overall.interaction_events.length > 0) {
    lines.push('### Interaction Events');
    lines.push(...report.overall.interaction_events.map((e) => `- ${e}`));
    lines.push('');
  }

  if (report.overall.team_dynamics.length > 0) {
    lines.push('### Team Dynamics');
    lines.push(...report.overall.team_dynamics.map((d) => `- ${d.type === 'highlight' ? '+' : '!'} ${d.text}`));
    lines.push('');
  }

  // Candidate Comparison (group mode)
  if (report.mode === 'group' && report.persons.length >= 2) {
    lines.push('### Candidate Comparison', '');
    const dims = report.persons[0].dimensions;
    const header = `| Dimension | ${report.persons.map(p => p.person_name).join(' | ')} |`;
    const sep = `|---|${report.persons.map(() => '---').join('|')}|`;
    lines.push(header, sep);
    for (const dim of dims) {
      const scores = report.persons.map(p => {
        const d = p.dimensions.find(pd => pd.dimension === dim.dimension);
        return d?.score !== undefined ? d.score.toFixed(1) : '\u2014';
      });
      lines.push(`| ${dim.label_zh || dim.dimension} | ${scores.join(' | ')} |`);
    }
    lines.push('');
  }

  // Question-by-Question Analysis
  if (report.overall.questionAnalysis && report.overall.questionAnalysis.length > 0) {
    lines.push('## Question-by-Question Analysis', '');
    for (const q of report.overall.questionAnalysis) {
      lines.push(`### [${q.answer_quality}] ${q.question_text}`, '');
      lines.push(`${q.comment}`, '');
      if (q.scoring_rationale) {
        lines.push(`**Scoring Rationale:** ${q.scoring_rationale}`, '');
      }
      if (q.answer_highlights && q.answer_highlights.length > 0) {
        lines.push('**Highlights:**');
        for (const h of q.answer_highlights) { lines.push(`- ${h}`); }
        lines.push('');
      }
      if (q.answer_weaknesses && q.answer_weaknesses.length > 0) {
        lines.push('**Areas for Improvement:**');
        for (const w of q.answer_weaknesses) { lines.push(`- ${w}`); }
        lines.push('');
      }
      if (q.suggested_better_answer) {
        lines.push(`**Suggested Approach:** ${q.suggested_better_answer}`, '');
      }
      if (q.related_dimensions.length > 0) {
        lines.push(`_Related: ${q.related_dimensions.join(', ')}_`, '');
      }
    }
  }

  // Per-person sections
  for (const person of report.persons) {
    lines.push(`## ${person.person_name}`, '');

    // Communication Metrics
    if (person.communicationMetrics) {
      const m = person.communicationMetrics;
      lines.push('### Communication Metrics', '');
      lines.push(`- **Speaking Time:** ${Math.floor(m.speakingTimeSec / 60)}m ${m.speakingTimeSec % 60}s (${Math.round(m.speakingRatio * 100)}% of session)`);
      lines.push(`- **Avg Response:** ${Math.floor(m.avgResponseSec / 60)}m ${Math.round(m.avgResponseSec % 60)}s (${m.turnCount} turns)`);
      lines.push(`- **Filler Words:** ${m.fillerWordCount} (${m.fillerWordsPerMin.toFixed(1)}/min)`);
      lines.push(`- **Response Latency:** ${m.avgLatencySec.toFixed(1)}s avg, ${m.longestPauseSec.toFixed(1)}s longest`);
      lines.push('');
    }

    // Dimensions + Claims
    for (const dim of person.dimensions) {
      const label = dim.label_zh || (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1));
      const scoreStr = dim.score !== undefined ? ` (${dim.score.toFixed(1)}/10)` : '';
      lines.push(`### ${label}${scoreStr}`, '');
      if (dim.score_rationale) {
        lines.push(`> ${dim.score_rationale}`, '');
      }
      for (const claim of dim.claims) {
        const tag = claim.category === 'strength' ? '+' : claim.category === 'risk' ? '!' : '>';
        lines.push(`- **[${tag}]** ${claim.text} _(${Math.round(claim.confidence * 100)}%)_`);
      }
      lines.push('');
    }

    // Person Summary
    lines.push('### Summary', '');
    lines.push(`- **Strengths:** ${person.summary.strengths}`);
    lines.push(`- **Risks:** ${person.summary.risks}`);
    lines.push(`- **Actions:** ${person.summary.actions}`);
    lines.push('');
  }

  // Improvement Suggestions
  if (report.improvements) {
    lines.push('## Improvement Suggestions', '');
    if (report.improvements.overall) {
      lines.push(report.improvements.overall.summary, '');
      if (report.improvements.overall.key_points?.length > 0) {
        for (const kp of report.improvements.overall.key_points) {
          lines.push(`- ${kp}`);
        }
        lines.push('');
      }
    }

    // Dimension improvements
    if (report.improvements.dimensions?.length > 0) {
      for (const di of report.improvements.dimensions) {
        lines.push(`### ${di.dimension} \u2014 Improvement`, '');
        lines.push(di.advice, '');
        if (di.framework) {
          lines.push(`**Framework:** ${di.framework}`, '');
        }
        if (di.example_response) {
          lines.push(`**Example:** "${di.example_response}"`, '');
        }
      }
    }

    // Claim improvements
    if (report.improvements.claims?.length > 0) {
      lines.push('### Claim-level Improvements', '');
      for (const ci of report.improvements.claims) {
        lines.push(`- **${ci.claim_id}:** ${ci.advice}`);
        if (ci.suggested_wording) {
          lines.push(`  > "${ci.suggested_wording}"`);
        }
      }
      lines.push('');
    }

    // Follow-up Questions
    if (report.improvements.follow_up_questions && report.improvements.follow_up_questions.length > 0) {
      lines.push('### Suggested Follow-up Questions', '');
      for (const q of report.improvements.follow_up_questions) {
        lines.push(`- **Q:** ${q.question}`);
        lines.push(`  _Purpose: ${q.purpose}_`);
      }
      lines.push('');
    }

    // Action Plan
    if (report.improvements.action_plan && report.improvements.action_plan.length > 0) {
      lines.push('### 30-Day Action Plan', '');
      for (let i = 0; i < report.improvements.action_plan.length; i++) {
        const item = report.improvements.action_plan[i];
        lines.push(`${i + 1}. **${item.action}**`);
        lines.push(`   - Practice: ${item.practice_method}`);
        lines.push(`   - Expected: ${item.expected_outcome}`);
      }
      lines.push('');
    }
  }

  // Evidence Timeline
  if (report.evidence.length > 0) {
    lines.push('## Evidence Timeline', '');
    for (const ev of report.evidence) {
      const weakTag = ev.weak ? ' **(weak)**' : '';
      lines.push(
        `- **[${formatTimestamp(ev.timestamp_ms)}]** ${ev.speaker}: "${ev.text}"${weakTag} _(${Math.round(ev.confidence * 100)}%)_`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

function markdownToSimpleHtml(md: string): string {
  return md
    .split('\n')
    .map(line => {
      // Headers
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      // Escape first, then apply inline formatting
      line = escapeHtml(line);
      // Bold (on escaped text, ** markers are safe since < > are escaped)
      line = line.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      // Italic
      line = line.replace(/_(.+?)_/g, '<i>$1</i>');
      // Numbered list items
      if (/^\d+\.\s/.test(line)) return `<li>${line.replace(/^\d+\.\s/, '')}</li>`;
      // List items
      if (line.startsWith('- ')) return `<li>${line.slice(2)}</li>`;
      // Blockquote
      if (line.startsWith('&gt; ')) return `<blockquote>${line.slice(5)}</blockquote>`;
      // Table rows (> is now &gt; from escapeHtml, | is safe)
      if (line.startsWith('|') && !line.match(/^\|[-|]+\|$/)) {
        const cells = line.split('|').filter(c => c.trim() !== '');
        return `<tr>${cells.map(c => `<td>${c.trim()}</td>`).join('')}</tr>`;
      }
      // Table separator — skip
      if (line.match(/^\|[-|]+\|$/)) return '';
      // Empty lines = paragraph breaks
      if (line.trim() === '') return '<br/>';
      return `<p>${line}</p>`;
    })
    .join('\n');
}

/**
 * Build a self-contained HTML document optimized for Chromium's printToPDF.
 * Loaded in a hidden offscreen BrowserWindow — no scrollable containers.
 */
function buildPrintHtml(
  report: FeedbackReport,
  sessionNotes?: string,
  sessionMemos?: Memo[],
): string {
  const md = buildFullMarkdown(report, sessionNotes, sessionMemos);
  const bodyHtml = markdownToSimpleHtml(md);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<style>
  @page {
    size: A4;
    margin: 16mm 14mm 18mm 14mm;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
      'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', sans-serif;
    font-size: 11px;
    line-height: 1.6;
    color: #1E2A32;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  h1 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 4px;
    color: #0D6A63;
    border-bottom: 2px solid #0D6A63;
    padding-bottom: 6px;
  }
  h2 {
    font-size: 15px;
    font-weight: 600;
    margin-top: 18px;
    margin-bottom: 6px;
    color: #1E2A32;
    border-bottom: 1px solid #E8E4DC;
    padding-bottom: 4px;
    break-after: avoid;
    page-break-after: avoid;
  }
  h3 {
    font-size: 12px;
    font-weight: 600;
    margin-top: 12px;
    margin-bottom: 4px;
    color: #566A77;
    break-after: avoid;
    page-break-after: avoid;
  }

  p {
    margin-bottom: 4px;
    orphans: 3;
    widows: 3;
  }
  b { font-weight: 600; }
  i { color: #566A77; }

  li {
    margin-left: 20px;
    margin-bottom: 3px;
    list-style-type: disc;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  li li { list-style-type: circle; }

  blockquote {
    margin: 4px 0 4px 12px;
    padding: 4px 10px;
    border-left: 3px solid #0D6A63;
    background: #F6F2EA;
    color: #566A77;
    font-style: italic;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    font-size: 10.5px;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td {
    border: 1px solid #E8E4DC;
    padding: 4px 8px;
    text-align: center;
  }
  tr:first-child td {
    background: #F6F2EA;
    font-weight: 600;
  }

  br { display: block; height: 4px; }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

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
  captionSource,
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
  captionSource?: string;
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
        // Clipboard API may fail in Electron -- fall back to execCommand
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
        <Button variant="secondary" size="sm" onClick={handleCopyText} disabled={!!exporting} className="transition-all duration-200">
          {copiedText ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {exporting === 'copy' ? 'Exporting\u2026' : copiedText ? 'Copied' : 'Copy Text'}
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExportMarkdown} disabled={!!exporting} className="transition-all duration-200">
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
        }} className="transition-all duration-200">
          <Download className="w-3.5 h-3.5" />
          {exporting === 'docx' ? 'Exporting\u2026' : 'Export DOCX'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!!exporting} onClick={async () => {
          setExporting('pdf');
          try {
            const html = buildPrintHtml(report, sessionNotes, sessionMemos);
            const result = await window.desktopAPI.exportPDF({
              sessionName: report.session_name,
              html,
            });
            if (result.success) {
              // success - no additional action needed
            }
          } catch (err) {
            console.warn('PDF export failed:', err);
          } finally {
            setExporting(null);
          }
        }} className="transition-all duration-200">
          <FileText className="w-3.5 h-3.5" />
          {exporting === 'pdf' ? 'Exporting\u2026' : 'Export PDF'}
        </Button>
        <Button variant="secondary" size="sm" disabled={!!exporting} onClick={handleExportSlack} className="transition-all duration-200">
          <MessageSquare className="w-3.5 h-3.5" />
          {exporting === 'slack' ? 'Exporting\u2026' : 'Share to Slack'}
        </Button>
        <Button variant="secondary" size="sm" onClick={async () => {
          try {
            const html = buildPrintHtml(report, sessionNotes, sessionMemos);
            const result = await window.desktopAPI.exportPDF({
              sessionName: report.session_name,
              html,
            });
            if (result.success) {
              // success - no additional action needed
            }
          } catch (err) {
            console.warn('PDF export failed:', err);
          }
        }} className="transition-all duration-200">
          <FileText className="w-3.5 h-3.5" />
          Export PDF
        </Button>
        <Button variant="secondary" size="sm" onClick={handleExportSlack} className="transition-all duration-200">
          <MessageSquare className="w-3.5 h-3.5" />
          Share to Slack
        </Button>
        <div className="w-px h-5 bg-border mx-1" />
        {onTranscriptToggle && (
          <Button variant="secondary" size="sm" onClick={onTranscriptToggle} className="transition-all duration-200">
            <PanelRight className="w-3.5 h-3.5" />
            Transcript
          </Button>
        )}
        <div className="w-px h-5 bg-border mx-1" />
        <SplitButton
          options={[
            { label: 'Re-generate Report', value: 'report-only', icon: <RefreshCw className="w-3.5 h-3.5" /> },
            { label: 'Full Re-analysis', value: 'full', icon: <Layers className="w-3.5 h-3.5" /> },
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

  // Build evidence map for useFootnotes
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
      {/* Interview metadata header */}
      <div className="flex items-center gap-3 text-xs text-secondary mb-4">
        <span>{report.date}</span>
        <span>·</span>
        <span>{report.durationLabel ?? formatDuration(report.duration_ms)}</span>
        {report.interviewType && <><span>·</span><span>{report.interviewType}</span></>}
        {report.positionTitle && <><span>·</span><span>目标: {report.positionTitle}</span></>}
      </div>

      <h2 className="text-sm font-semibold text-ink mb-3">{report.persons.length > 1 ? 'Team Summary' : 'Summary'}</h2>

      {/* New narrative format with footnotes */}
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

      {/* Recommendation Badge */}
      {report.overall.recommendation && (
        <RecommendationBadge recommendation={report.overall.recommendation} />
      )}

      {/* Key Findings */}
      {report.overall.keyFindings && report.overall.keyFindings.length > 0 && (
        <div className="mb-4 space-y-2">
          <h3 className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">Key Findings</h3>
          {report.overall.keyFindings.map((finding, i) => {
            const findingColor = finding.type === 'strength'
              ? 'border-l-emerald-400 bg-emerald-50/50'
              : finding.type === 'risk'
                ? 'border-l-amber-400 bg-amber-50/50'
                : 'border-l-blue-400 bg-blue-50/50';
            const findingLabel = finding.type === 'strength' ? '优势'
              : finding.type === 'risk' ? '风险' : '观察';
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
                  <p className="text-sm text-ink leading-relaxed">
                    {finding.text}
                  </p>
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

      {/* Candidate Comparison (group mode only) */}
      {report.mode === 'group' && report.persons.length >= 2 && (
        <CandidateComparison persons={report.persons} />
      )}

      {/* Legacy: Evidence chips (when no narrative) */}
      {!hasNarrative && (
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
      )}

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

      {/* Interaction Events — hidden for 1v1 or when empty */}
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

      {/* Team Dynamics — hidden for 1v1 or when empty */}
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
      )}

      {/* Overall Improvement Suggestions */}
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

      {/* Interview Quality Card */}
      {report.overall.interviewQuality && (
        <InterviewQualityCard quality={report.overall.interviewQuality} />
      )}

      {/* AI Dimension Suggestions */}
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

function ClaimCard({
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
      {/* Inline evidence expansion */}
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
      {/* Needs Evidence badge */}
      {claim.evidence_refs.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onNeedsEvidenceClick} className="cursor-pointer">
            <Chip variant="error">Needs Evidence</Chip>
          </button>
        </div>
      )}
      {/* Legacy: show EvidenceChips only when footnote system is not active */}
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
      {/* Weak indicator for footnote mode */}
      {hasFootnotes && claim.evidence_refs.some((refId) => {
        const ev = getEvidenceById(report, refId);
        return ev?.weak;
      }) && (
        <Chip variant="warning" className="text-xs mt-1">weak evidence</Chip>
      )}
      {/* Claim improvement suggestion (only for risk/action) */}
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
          <InlineEditable
            value={summary.strengths}
            onSave={(v) => onInlineEdit(`${prefix}.strengths`, v)}
            as="p"
            className="text-xs text-ink-secondary leading-relaxed"
          />
        ) : (
          <p className="text-xs text-ink-secondary leading-relaxed">{summary.strengths}</p>
        )}
      </div>
      <div>
        <h5 className="text-xs font-semibold text-warning mb-1">Risks</h5>
        {onInlineEdit ? (
          <InlineEditable
            value={summary.risks}
            onSave={(v) => onInlineEdit(`${prefix}.risks`, v)}
            as="p"
            className="text-xs text-ink-secondary leading-relaxed"
          />
        ) : (
          <p className="text-xs text-ink-secondary leading-relaxed">{summary.risks}</p>
        )}
      </div>
      <div>
        <h5 className="text-xs font-semibold text-blue-700 mb-1">Actions</h5>
        {onInlineEdit ? (
          <InlineEditable
            value={summary.actions}
            onSave={(v) => onInlineEdit(`${prefix}.actions`, v)}
            as="p"
            className="text-xs text-ink-secondary leading-relaxed"
          />
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
  // Collect all evidence_refs across all claims for this person
  const allPersonEvidenceRefs = useMemo(() => {
    const refs: string[] = [];
    for (const dim of person.dimensions) {
      for (const claim of dim.claims) {
        refs.push(...claim.evidence_refs);
      }
    }
    return refs;
  }, [person.dimensions]);

  // Build evidence map for useFootnotes
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
      {/* Compact summary chips */}
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
      {/* Competency radar chart */}
      {person.dimensions.length >= 3 && (
        <CompetencyRadar dimensions={person.dimensions} />
      )}
      {/* Communication Metrics */}
      {person.communicationMetrics && (
        <CommunicationMetrics metrics={person.communicationMetrics} />
      )}
      {/* Collapsible dimensions */}
      {person.dimensions.map((dim) => {
        const dimImprovement = report.improvements?.dimensions.find(
          di => di.dimension === dim.dimension
        );
        return (
          <DimensionSummaryRow
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
      {/* Follow-up Questions */}
      {report.improvements?.follow_up_questions && (
        <FollowUpQuestions questions={report.improvements.follow_up_questions} />
      )}
      {/* Action Plan */}
      {report.improvements?.action_plan && (
        <ActionPlanCard items={report.improvements.action_plan} />
      )}
      {/* Footnote list at the bottom of the person section */}
      {footnoteEntries.length > 0 && (
        <FootnoteList entries={footnoteEntries} onFootnoteClick={onFootnoteClick} />
      )}
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

  const surroundingUtterances = getSurroundingContext(report, evidence.id);
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

        {/* Conversation context — shows full dialogue including interviewer questions */}
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
                {u.isPartOfEvidence && (
                  <ArrowRight className="w-3 h-3 text-accent shrink-0 mt-0.5" />
                )}
                <span className="font-mono whitespace-nowrap">
                  [{formatTimestamp(u.start_ms)}]
                </span>
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

  const handleRegenerate = async () => {
    if (!sessionId || !baseApiUrl) return;
    setRegenerating(true);
    try {
      const result = await window.desktopAPI.regenerateFeedbackClaim({
        baseUrl: baseApiUrl,
        sessionId,
        body: { claim_id: claim.id, evidence_refs: refs },
      });
      if (result && typeof result === 'object' && (result as any).text) {
        setText((result as any).text);
        if (Array.isArray((result as any).evidence_refs)) {
          setRefs((result as any).evidence_refs);
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
            disabled={!sessionId || !baseApiUrl}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Regenerate with LLM
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="secondary" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─── CompetencyRadar (SVG) ──────────────────────────── */

function CompetencyRadar({
  dimensions,
}: {
  dimensions: DimensionFeedback[];
}) {
  // Filter out not_applicable dimensions
  const activeDims = dimensions.filter((d) => !d.not_applicable);
  if (activeDims.length < 3) return null;

  const cx = 90;
  const cy = 90;
  const r = 70;
  const n = activeDims.length;
  const maxScore = 10;
  const angleStep = (2 * Math.PI) / n;

  // Score: use LLM score (0-10) when available, fallback to strengths ratio
  const scores = activeDims.map((dim) => {
    if (typeof dim.score === 'number') {
      return Math.max(0, Math.min(dim.score, maxScore)) / maxScore;
    }
    // Fallback for old data without score field
    const total = dim.claims.length;
    if (total === 0) return 0.5;
    const strengths = dim.claims.filter((c) => c.category === 'strength').length;
    return strengths / total;
  });

  // Raw scores for label display
  const rawScores = activeDims.map((dim) => {
    if (typeof dim.score === 'number') {
      return Math.max(0, Math.min(dim.score, maxScore));
    }
    // Fallback: compute from claims ratio and scale to 0-10
    const total = dim.claims.length;
    if (total === 0) return 5;
    const strengths = dim.claims.filter((c) => c.category === 'strength').length;
    return Math.round((strengths / total) * maxScore * 10) / 10;
  });

  // Generate polygon points for the radar
  const polygonPoints = scores
    .map((score, i) => {
      const angle = -Math.PI / 2 + i * angleStep;
      const x = cx + r * score * Math.cos(angle);
      const y = cy + r * score * Math.sin(angle);
      return `${x},${y}`;
    })
    .join(' ');

  // Grid rings at 2.5, 5.0, 7.5, 10
  const rings = [0.25, 0.5, 0.75, 1.0];
  const ringLabels = ['2.5', '5.0', '7.5', '10'];

  return (
    <div className="flex items-center justify-center py-3">
      <svg width="180" height="180" viewBox="0 0 180 180" className="overflow-visible">
        {/* Grid rings with labels */}
        {rings.map((ring, ri) => (
          <g key={ring}>
            <polygon
              points={Array.from({ length: n })
                .map((_, i) => {
                  const angle = -Math.PI / 2 + i * angleStep;
                  const x = cx + r * ring * Math.cos(angle);
                  const y = cy + r * ring * Math.sin(angle);
                  return `${x},${y}`;
                })
                .join(' ')}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth="0.5"
              opacity={0.6}
            />
            {/* Ring label on the top axis */}
            <text
              x={cx}
              y={cy - r * ring - 2}
              textAnchor="middle"
              dominantBaseline="auto"
              fill="var(--color-ink-secondary)"
              fontSize="7"
              opacity={0.5}
            >
              {ringLabels[ri]}
            </text>
          </g>
        ))}

        {/* Axis lines */}
        {activeDims.map((_, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const x = cx + r * Math.cos(angle);
          const y = cy + r * Math.sin(angle);
          return (
            <line
              key={i}
              x1={cx}
              y1={cy}
              x2={x}
              y2={y}
              stroke="var(--color-border)"
              strokeWidth="0.5"
              opacity={0.6}
            />
          );
        })}

        {/* Data polygon */}
        <polygon
          points={polygonPoints}
          fill="var(--color-accent)"
          fillOpacity={0.15}
          stroke="var(--color-accent)"
          strokeWidth="1.5"
        />

        {/* Data points */}
        {scores.map((score, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const x = cx + r * score * Math.cos(angle);
          const y = cy + r * score * Math.sin(angle);
          return (
            <circle key={i} cx={x} cy={y} r="3" fill="var(--color-accent)" />
          );
        })}

        {/* Labels: label_zh + score, low score (<4) in risk color */}
        {activeDims.map((dim, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const labelR = r + 16;
          const x = cx + labelR * Math.cos(angle);
          const y = cy + labelR * Math.sin(angle);
          // Prefer label_zh, fallback to capitalized dimension key
          const displayLabel = dim.label_zh || (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1));
          const scoreVal = rawScores[i];
          const isLowScore = scoreVal < 4;
          // Truncate long labels
          const truncated = displayLabel.length > 6 ? displayLabel.slice(0, 5) + '…' : displayLabel;
          const labelText = typeof dim.score === 'number'
            ? `${truncated} ${scoreVal % 1 === 0 ? scoreVal.toFixed(0) : scoreVal.toFixed(1)}`
            : truncated;
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fill={isLowScore ? 'var(--color-risk, #dc2626)' : 'var(--color-ink-secondary)'}
              fontSize="9"
              fontWeight={isLowScore ? '600' : '500'}
            >
              {labelText}
            </text>
          );
        })}
      </svg>
    </div>
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

function Tier2Banner({
  status,
  progress,
}: {
  status: 'tier2_running' | 'tier2_ready';
  progress?: number;
}) {
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

/* ─── SectionStickyHeader (sticks at top of scroll area) ── */

function SectionStickyHeader({
  icon: Icon,
  title,
}: {
  icon: typeof Activity;
  title: string;
}) {
  return (
    <div className="sticky top-0 z-10 bg-bg">
      <div className="flex items-center gap-2 py-1.5 border-b border-border/40">
        <Icon className="w-3.5 h-3.5 text-accent shrink-0" />
        <span className="text-xs font-semibold text-ink-secondary uppercase tracking-wider">{title}</span>
      </div>
    </div>
  );
}

/* ─── SectionNav (sticky left sidebar) ───────────────── */

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
      <h3 className="text-xs font-medium text-ink-secondary uppercase tracking-wider mb-2 px-2">
        Sections
      </h3>
      <ul className="space-y-0.5">
        {sections.map((section) => (
          <li key={section.id}>
            <button
              onClick={() => onSectionClick(section.id)}
              className={`
                w-full text-left px-2 py-1.5 rounded-[--radius-button] text-sm transition-colors cursor-pointer
                ${activeSection === section.id
                  ? 'bg-accent-soft text-accent font-medium'
                  : 'text-ink-secondary hover:bg-surface-hover hover:text-ink'
                }
              `}
            >
              {section.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/* ─── DimensionSummaryRow (collapsed dimension) ──────── */

function DimensionSummaryRow({
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
        {expanded ? <ChevronDown className="w-3.5 h-3.5 text-ink-tertiary" /> : <ChevronRight className="w-3.5 h-3.5 text-ink-tertiary" />}
        <Icon className="w-4 h-4 text-accent" />
        <div className="flex items-center gap-2 flex-1 text-left">
          <span className="text-sm font-semibold text-ink">{dim.label_zh ?? (dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1))}</span>
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
                  ci => ci.claim_id === claim.id
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

/* ─── Dynamic Mock Generators ────────────────────────── */
// REMOVED: All mock data generators have been removed to prevent fake data in production

/* ─── Main View ───────────────────────────────────────── */

export function FeedbackView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const location = useLocation();
  const navigate = useNavigate();

  // ── Session data type from location.state or localStorage ──
  type StageArchiveData = {
    stageIndex: number;
    stageName: string;
    archivedAt: string;
    freeformText: string;
    freeformHtml?: string;
    memoIds: string[];
  };

  type SessionData = {
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
    stageArchives?: StageArchiveData[];
    elapsedSeconds?: number;
    date?: string;
    baseApiUrl?: string;
    report?: Record<string, unknown>;
  };

  // ── Resolve session data: localStorage (full) > location.state > session list ──
  const [sessionData] = useState<SessionData | null>(() => {
    // Priority 1: localStorage (full data with memos/notes/stages, persisted by orchestrator)
    if (sessionId) {
      try {
        const stored = localStorage.getItem(`ifb_session_data_${sessionId}`);
        if (stored) return JSON.parse(stored) as SessionData;
      } catch { /* ignore parse errors */ }
    }

    // Priority 2: location.state (may be incomplete when coming from Home's PendingFeedback)
    const locState = location.state as SessionData | null;
    if (locState?.sessionName) return locState;

    // Priority 3: basic session info from ifb_sessions list
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

  // Track whether we are using demo data
  const isDemo = !sessionData?.sessionName;

  // ── Finalization status tracking ──
  type FinalizeStatus = 'not_started' | 'awaiting' | 'finalizing' | 'final' | 'tier2_running' | 'tier2_ready' | 'error';
  // If no baseApiUrl is configured, treat as 'not_started' (no backend to finalize with)
  const [finalizeStatus, setFinalizeStatus] = useState<FinalizeStatus>(
    isDemo || !sessionData?.baseApiUrl ? 'not_started' : 'awaiting'
  );
  const [apiReport, setApiReport] = useState<FeedbackReport | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(!isDemo && !!sessionData?.baseApiUrl);
  const [tier2Progress, setTier2Progress] = useState(0);
  const [finalizeProgressInfo, setFinalizeProgressInfo] = useState<{ stage: string; progress: number } | null>(null);
  // Guard against double finalization (orchestrator setTimeout + FeedbackView retry)
  const finalizingRef = useRef(false);
  const tier2PollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Stable polling start time — must not reset when finalizeStatus changes (SF-8)
  const pollStartedAtRef = useRef<number>(Date.now());

  // Mark session as 'finalized' in localStorage so it leaves PendingFeedback
  useEffect(() => {
    if (finalizeStatus !== 'final' || !sessionId) return;
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const updated = sessions.map((s: Record<string, unknown>) =>
        s.id === sessionId ? { ...s, status: 'finalized' } : s
      );
      localStorage.setItem('ifb_sessions', JSON.stringify(updated));
    } catch { /* ignore */ }
  }, [finalizeStatus, sessionId]);

  // If session data includes a pre-stored report (e.g. demo injection), use it directly
  useEffect(() => {
    if (!sessionData?.report || apiReport) return;
    try {
      const normalized = normalizeApiReport(sessionData.report, {
        name: sessionData.sessionName,
        date: sessionData.date,
        durationMs: (sessionData.elapsedSeconds || 0) * 1000,
        mode: sessionData.mode,
        participants: sessionData.participants,
      });
      setApiReport(normalized);
      setFinalizeStatus('final');
      setReportLoading(false);
    } catch (err) {
      console.warn('[FeedbackView] Failed to normalize pre-stored report:', err);
    }
  }, [sessionData?.report]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attempt to load finalized report from API on mount
  useEffect(() => {
    if (!sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;

    async function tryLoadReport() {
      try {
        // First check finalization status — detect 'failed' or 'running' early
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! });
        if (!cancelled && status && typeof status === 'object') {
          const backendStatus = (status as any).status;
          if (backendStatus === 'failed') {
            const errors = (status as any).errors;
            const msg = Array.isArray(errors) && errors.length > 0
              ? errors.join('; ')
              : 'Finalization failed on the server.';
            setFinalizeError(msg);
            setFinalizeStatus('error');
            return;
          }
          // If finalization is still running, skip openFeedback — the poll
          // loop will pick it up once finalization completes. Calling
          // openFeedback while finalizeV2 is in progress can trigger a stale
          // cache rebuild that produces a broken report in caption mode.
          if (backendStatus === 'running' || backendStatus === 'queued') {
            setFinalizeStatus('awaiting');
            return;
          }
        }

        // Then try to load a finalized report via feedback-open (quality-gated)
        const result = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as any;
        if (!cancelled && result && typeof result === 'object') {
          if (result.report) {
            const normalized = normalizeApiReport(result.report, {
              name: sessionData?.sessionName,
              date: sessionData?.date,
              durationMs: (sessionData?.elapsedSeconds || 0) * 1000,
              mode: sessionData?.mode,
              participants: sessionData?.participants,
            });
            setApiReport(normalized);
            setFinalizeStatus('final');
          } else {
            // Quality gate failed — report withheld by backend
            const reason = result.blocking_reason || 'Report quality did not meet threshold.';
            setFinalizeError(reason);
            setFinalizeStatus('error');
          }
        }
      } catch {
        // No finalized report yet -- that's expected
        if (!cancelled) {
          setFinalizeStatus('awaiting');
        }
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    }

    tryLoadReport();
    return () => { cancelled = true; };
  }, [sessionId, sessionData?.baseApiUrl, isDemo]);

  // Poll for finalization status when awaiting (timeout after 3 min).
  // NOTE: finalizeStatus is deliberately NOT in the dependency array (SF-8 fix).
  // Including it caused the effect to re-run on status changes, resetting the
  // pollStartedAt timer and extending the timeout indefinitely.
  useEffect(() => {
    if (!sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;
    // Set poll start time once when this effect mounts
    pollStartedAtRef.current = Date.now();
    const POLL_TIMEOUT_MS = 600_000; // 10 min — local_asr can take 10+ min for long sessions

    // Declare interval before poll so the closure can clear it
    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      // Check for timeout using the stable ref
      if (Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        if (interval) clearInterval(interval);
        if (!cancelled) {
          setFinalizeError('Finalization timed out after 10 minutes. The server may still be processing — try refreshing from History.');
          setFinalizeStatus('error');
        }
        return;
      }

      try {
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! });
        if (cancelled) return;

        if (status && typeof status === 'object') {
          const backendStatus = (status as any).status;
          // Surface progress info from Worker so user sees what stage we're at
          const stage = (status as any).stage as string | undefined;
          const progress = (status as any).progress as number | undefined;
          if (stage && typeof progress === 'number') {
            setFinalizeProgressInfo({ stage, progress });
          }

          if (backendStatus === 'failed') {
            // Backend explicitly says finalization failed — stop polling immediately
            if (interval) clearInterval(interval);
            const errors = (status as any).errors;
            const msg = Array.isArray(errors) && errors.length > 0
              ? errors.join('; ')
              : 'Finalization failed on the server.';
            setFinalizeError(msg);
            setFinalizeStatus('error');
            return;
          }

          if (backendStatus === 'completed' || backendStatus === 'succeeded') {
            // Stop polling BEFORE the async fetch to prevent timeout race
            if (interval) clearInterval(interval);
            setFinalizeStatus('finalizing');
            try {
              const result = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as any;
              if (!cancelled && result && typeof result === 'object') {
                if (result.report) {
                  const normalized = normalizeApiReport(result.report, {
                    name: sessionData?.sessionName,
                    date: sessionData?.date,
                    durationMs: (sessionData?.elapsedSeconds || 0) * 1000,
                    mode: sessionData?.mode,
                    participants: sessionData?.participants,
                  });
                  setApiReport(normalized);
                  setFinalizeStatus('final');
                } else {
                  // Quality gate failed — report withheld by backend
                  const reason = (result as any).blocking_reason || 'Report quality did not meet threshold.';
                  setFinalizeError(reason);
                  setFinalizeStatus('error');
                }
              }
            } catch {
              if (!cancelled) {
                setFinalizeError('Failed to load the finalized report.');
                setFinalizeStatus('error');
              }
            }
            return;
          }
        }
      } catch {
        // Keep polling unless timed out
      }
    };

    interval = setInterval(poll, 5000);
    poll(); // Initial check

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionData?.baseApiUrl, isDemo]);

  // ── Tier 2 polling: starts after finalizeStatus becomes 'final' ──
  useEffect(() => {
    if (finalizeStatus !== 'final' || !sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;

    const checkTier2 = async () => {
      try {
        const result = await window.desktopAPI.getTier2Status({
          baseUrl,
          sessionId: sessionId!,
        });
        if (cancelled) return;
        const data = result as Record<string, unknown>;
        if (!data || typeof data !== 'object') return;

        const tier2Status = data.status as string;
        const tier2Enabled = Boolean(data.enabled);
        const progress = typeof data.progress === 'number' ? data.progress : 0;

        if (!tier2Enabled || tier2Status === 'idle') {
          // Tier 2 not active — stop polling
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
          return;
        }

        setTier2Progress(progress);

        if (tier2Status === 'succeeded') {
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
          // Fetch the enhanced report
          try {
            const freshResult = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as any;
            if (!cancelled && freshResult?.report) {
              const normalized = normalizeApiReport(freshResult.report, {
                name: sessionData?.sessionName,
                date: sessionData?.date,
                durationMs: (sessionData?.elapsedSeconds || 0) * 1000,
                mode: sessionData?.mode,
                participants: sessionData?.participants,
              });
              setApiReport(normalized);
              setFinalizeStatus('tier2_ready');
            }
          } catch {
            // Keep tier1 report if fetch fails
          }
          return;
        }

        if (tier2Status === 'failed') {
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
          // Tier 2 failed — keep tier1 report, no user-facing error
          return;
        }

        // Still running
        if (finalizeStatus === 'final') {
          setFinalizeStatus('tier2_running');
        }
      } catch {
        // Tier 2 status endpoint not available — stop silently
        if (tier2PollRef.current) clearInterval(tier2PollRef.current);
      }
    };

    // Small delay before first check (tier2 needs 2s to schedule)
    const startDelay = setTimeout(() => {
      if (!cancelled) {
        tier2PollRef.current = setInterval(checkTier2, 5000);
        checkTier2();
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearTimeout(startDelay);
      if (tier2PollRef.current) clearInterval(tier2PollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalizeStatus === 'final', sessionId, sessionData?.baseApiUrl, isDemo]);

  // Cleanup tier2 poll on unmount
  useEffect(() => {
    return () => {
      if (tier2PollRef.current) clearInterval(tier2PollRef.current);
    };
  }, []);

  // Modal state
  const [editClaim, setEditClaim] = useState<Claim | null>(null);
  const [detailEvidence, setDetailEvidence] = useState<EvidenceRef | null>(null);
  const [evidenceModalMode, setEvidenceModalMode] = useState<'browse' | 'claim-editor'>('browse');

  // Suggestion banner state
  const [dismissedSuggestions, setDismissedSuggestions] = useState(false);

  // ── Extract session metadata ──
  const sessionMemos: Memo[] = sessionData?.memos || [];
  const sessionStages: string[] = sessionData?.stages || [];
  const sessionNotes: string = sessionData?.notes || '';
  const sessionStageArchives: StageArchiveData[] = sessionData?.stageArchives || [];

  // Derive teacher memos from ALL real session memos (all types)
  const derivedTeacherMemos = sessionMemos.length > 0
    ? sessionMemos.map(m => `[${m.stage}] ${m.text}`)
    : [];

  // ── Build the effective report ──
  // If we have a finalized API report, use it directly
  // If we have real session data, build a placeholder report from it
  // Otherwise fall back to DEMO_REPORT
  const report: FeedbackReport = useMemo(() => {
    // Case 1: Finalized report from API (already normalized by normalizeApiReport)
    if (apiReport) {
      // Merge local teacher memos if API returned none
      const mergedMemos = apiReport.overall.teacher_memos.length > 0
        ? apiReport.overall.teacher_memos
        : derivedTeacherMemos;
      return {
        ...apiReport,
        status: 'final' as const,
        // Supplement missing metadata from local session data
        session_name: apiReport.session_name || sessionData?.sessionName || '',
        date: apiReport.date || sessionData?.date || new Date().toISOString().slice(0, 10),
        duration_ms: apiReport.duration_ms || (sessionData?.elapsedSeconds || 0) * 1000,
        overall: {
          ...apiReport.overall,
          teacher_memos: mergedMemos,
        },
      };
    }

    // Case 2: Real session data available (draft state)
    if (sessionData?.sessionName) {
      const participantNames = sessionData.participants || [];
      const durationMs = (sessionData.elapsedSeconds || 0) * 1000;
      const sessionDate = sessionData.date || new Date().toISOString().slice(0, 10);

      if (participantNames.length > 0) {
        return {
          session_id: sessionId || '',
          session_name: sessionData.sessionName,
          date: sessionDate,
          duration_ms: durationMs,
          status: 'draft' as const,
          mode: (sessionData.mode as '1v1' | 'group') || '1v1',
          participants: participantNames,
          overall: {
            team_summary: finalizeStatus === 'awaiting' || finalizeStatus === 'finalizing'
              ? 'Report will be generated after finalization completes. The session data has been captured and is ready for processing.'
              : `Session "${sessionData.sessionName}" with ${participantNames.length} participant${participantNames.length > 1 ? 's' : ''}: ${participantNames.join(', ')}.`,
            teacher_memos: derivedTeacherMemos,
            interaction_events: [],
            team_dynamics: [],
            evidence_refs: [],
          },
          persons: [],
          evidence: [],
          transcript: [],
          utteranceEvidenceMap: {},
        };
      }

      // Participants list empty but we have session name
      return {
        session_id: sessionId || '',
        session_name: sessionData.sessionName,
        date: sessionDate,
        duration_ms: durationMs,
        status: 'draft' as const,
        mode: (sessionData.mode as '1v1' | 'group') || '1v1',
        participants: [],
        overall: {
          team_summary: 'Report will be generated after finalization completes.',
          teacher_memos: derivedTeacherMemos,
          interaction_events: [],
          team_dynamics: [],
          evidence_refs: [],
        },
        persons: [],
        evidence: [],
        transcript: [],
        utteranceEvidenceMap: {},
      };
    }

    // Case 3: No session data at all -- demo fallback
    return DEMO_REPORT;
  }, [apiReport, sessionData, sessionId, derivedTeacherMemos, finalizeStatus]);

  const handleAcceptSuggestions = useCallback(() => {
    // Record acceptance — actual re-generate logic requires Worker API (future)
    console.log('Accepted dimension suggestions:', report?.overall?.suggestedDimensions);
    // TODO: call session config update + report regenerate
    setDismissedSuggestions(true);
  }, [report]);

  const handleDismissSuggestions = useCallback(() => {
    setDismissedSuggestions(true);
  }, []);

  const handleInlineEdit = useCallback((fieldPath: string, newValue: string) => {
    if (!sessionId) return;
    try {
      const dataKey = `ifb_session_data_${sessionId}`;
      const stored = JSON.parse(localStorage.getItem(dataKey) || '{}');
      if (!stored.report) return;

      if (!stored.report.user_edits) stored.report.user_edits = [];
      stored.report.user_edits.push({
        field_path: fieldPath,
        edited_value: newValue,
        edited_at: new Date().toISOString(),
      });

      const keys = fieldPath.split('.');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let obj: any = stored.report;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]];
        if (!obj) return;
      }
      obj[keys[keys.length - 1]] = newValue;

      localStorage.setItem(dataKey, JSON.stringify(stored));

      const normalized = normalizeApiReport(stored.report, {
        name: stored.sessionName,
        date: stored.date,
        durationMs: (stored.elapsedSeconds || 0) * 1000,
        mode: stored.mode,
        participants: stored.participants,
      });
      setApiReport(normalized);
    } catch (err) {
      console.warn('[InlineEdit] Failed to save:', err);
    }
  }, [sessionId]);

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

  const handleSaveClaim = useCallback((claimId: string, text: string, evidenceRefs: string[]) => {
    if (apiReport) {
      setApiReport(updateClaimInReport(apiReport, claimId, (c) => ({
        ...c,
        text,
        evidence_refs: evidenceRefs,
      })));
    }
    // Persist to backend if available
    if (sessionId && sessionData?.baseApiUrl) {
      window.desktopAPI.updateFeedbackClaimEvidence({
        baseUrl: sessionData.baseApiUrl,
        sessionId: sessionId!,
        body: { claim_id: claimId, text, evidence_refs: evidenceRefs },
      }).catch(() => { /* non-fatal */ });
    }
  }, [apiReport, sessionId, sessionData?.baseApiUrl]);

  // Build metadata payload from session data for finalize requests
  const buildFinalizeMetadata = useCallback(() => {
    if (!sessionData) return {};
    return {
      memos: (sessionData.memos || []).map(m => ({
        memo_id: m.id,
        type: m.type,
        text: m.text,
        tags: [] as string[],
        created_at_ms: Date.now(),
        author_role: 'teacher' as const,
        stage: m.stage,
        stage_index: undefined,
      })),
      free_form_notes: sessionData.notes || null,
      stages: sessionData.stages || [],
      participants: sessionData.participants || [],
    };
  }, [sessionData]);

  const handleRetryFinalize = useCallback(async () => {
    if (!sessionId || !sessionData?.baseApiUrl || finalizingRef.current) return;
    // Guard against double finalization via store flag
    const storeState = useSessionStore.getState();
    if (storeState.finalizeRequested && finalizingRef.current) return;
    finalizingRef.current = true;
    storeState.setFinalizeRequested(true);
    setFinalizeError(null);
    setFinalizeStatus('awaiting');
    try {
      await window.desktopAPI.finalizeV2({
        baseUrl: sessionData.baseApiUrl,
        sessionId: sessionId!,
        metadata: buildFinalizeMetadata(),
      });
      // Polling will resume via useEffect dependency on finalizeStatus
    } catch {
      setFinalizeStatus('error');
    } finally {
      finalizingRef.current = false;
      useSessionStore.getState().setFinalizeRequested(false);
    }
  }, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);

  const handleRegenerate = useCallback(async (mode: 'full' | 'report-only' = 'full') => {
    if (!sessionId || !sessionData?.baseApiUrl || finalizingRef.current) return;
    // Guard against double finalization via store flag
    const storeState = useSessionStore.getState();
    if (storeState.finalizeRequested && finalizingRef.current) return;
    finalizingRef.current = true;
    storeState.setFinalizeRequested(true);
    setFinalizeError(null);
    setFinalizeStatus('awaiting');
    setApiReport(null);
    try {
      await window.desktopAPI.finalizeV2({
        baseUrl: sessionData.baseApiUrl,
        sessionId: sessionId!,
        metadata: buildFinalizeMetadata(),
        mode,
      });
      // Polling will pick up the new report
    } catch {
      setFinalizeStatus('error');
    } finally {
      finalizingRef.current = false;
      useSessionStore.getState().setFinalizeRequested(false);
    }
  }, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);


  // Section navigation + scroll-spy
  const [activeSection, setActiveSection] = useState('overview');
  const contentRef = useRef<HTMLDivElement>(null);

  // Split view: transcript sidebar state
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [scrollToUtteranceId, setScrollToUtteranceId] = useState<string | null>(null);
  const [highlightedUtteranceIds, setHighlightedUtteranceIds] = useState<Set<string>>(new Set());

  const handleSectionClick = useCallback((id: string) => {
    setActiveSection(id);
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Scroll-spy: track which section is at the top of the scroll area
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
          // Section becomes "active" when its top is within 100px of the container top
          if (section.getBoundingClientRect().top - offset <= 100) {
            current = section.id;
          }
        }

        setActiveSection(current);
      });
    };

    container.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll(); // Initial check
    return () => {
      container.removeEventListener('scroll', handleScroll);
      cancelAnimationFrame(rafId);
    };
  }, [report, reportLoading]);

  // ── Compute status badge label & variant ──
  const statusLabel = useMemo(() => {
    if (isDemo) return 'Demo Data';
    switch (finalizeStatus) {
      case 'tier2_ready': return 'Enhanced Report';
      case 'tier2_running': return 'Refining...';
      case 'final': return 'Final Report';
      case 'finalizing': return 'Finalizing...';
      case 'awaiting': return 'Draft -- awaiting finalization';
      case 'error': return 'Finalization failed';
      case 'not_started': return 'Draft';
      default: return 'Draft';
    }
  }, [finalizeStatus, isDemo]);

  const statusVariant = useMemo((): 'success' | 'warning' | 'info' | 'error' => {
    if (isDemo) return 'info';
    switch (finalizeStatus) {
      case 'tier2_ready': return 'success';
      case 'tier2_running': return 'info';
      case 'final': return 'success';
      case 'finalizing': return 'warning';
      case 'awaiting': return 'warning';
      case 'error': return 'error';
      default: return 'warning';
    }
  }, [finalizeStatus, isDemo]);

  // Handle footnote / evidence click → open transcript sidebar + scroll + highlight
  const handleFootnoteClick = useCallback((evidenceId: string) => {
    const ev = report.evidence.find(e => e.id === evidenceId);
    if (!ev) return;
    // Try to find utterance IDs from the utteranceEvidenceMap (reverse lookup)
    const uttIds = new Set<string>();
    for (const [uid, evIds] of Object.entries(report.utteranceEvidenceMap)) {
      if (evIds.includes(evidenceId)) uttIds.add(uid);
    }
    // If no direct mapping, try to find transcript entries matching the evidence text
    if (uttIds.size === 0) {
      for (const u of report.transcript) {
        if (u.text && ev.text && u.text.includes(ev.text.slice(0, 30))) {
          uttIds.add(u.utterance_id);
        }
      }
    }
    setHighlightedUtteranceIds(uttIds);
    const firstUttId = uttIds.size > 0 ? Array.from(uttIds)[0] : null;
    setScrollToUtteranceId(firstUttId);
    if (!transcriptOpen) setTranscriptOpen(true);
  }, [report, transcriptOpen]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fixed header zone (never scrolls) ── */}
      {!reportLoading && (
        <div className="shrink-0 bg-bg border-b border-border">
          <div className="max-w-5xl mx-auto px-6 pt-6 pb-4">
            <FeedbackHeader
              report={report}
              onRegenerate={(mode) => handleRegenerate(mode || (apiReport?.captionSource === 'acs-teams' ? 'report-only' : 'full'))}
              onBack={() => navigate('/history')}
              statusLabel={statusLabel}
              statusVariant={statusVariant}
              isDemo={isDemo}
              isEnhanced={finalizeStatus === 'tier2_ready'}
              sessionNotes={sessionNotes}
              onTranscriptToggle={report.transcript.length > 0 ? () => setTranscriptOpen(v => !v) : undefined}
              sessionMemos={sessionMemos}
              captionSource={apiReport?.captionSource}
              sessionId={sessionId}
              baseApiUrl={sessionData?.baseApiUrl}
            />

            {/* Draft / demo banner */}
            {(report.status === 'draft' || isDemo) && (
              <DraftBanner
                isDemo={isDemo}
                showRetry={finalizeStatus === 'error'}
                onRetry={handleRetryFinalize}
                message={
                  isDemo
                    ? undefined
                    : finalizeStatus === 'finalizing'
                      ? 'Report is being finalized. Content will update automatically.'
                      : finalizeStatus === 'error'
                        ? finalizeError || 'Finalization failed or timed out.'
                        : undefined
                }
              />
            )}

            {/* Tier 2 refinement banner */}
            {(finalizeStatus === 'tier2_running' || finalizeStatus === 'tier2_ready') && (
              <Tier2Banner status={finalizeStatus} progress={tier2Progress} />
            )}
          </div>
        </div>
      )}

      {/* ── Body: fixed sidebar + scrollable content ── */}
      <div className="flex-1 min-h-0">
        {reportLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3">
            <Loader2 className="w-8 h-8 text-accent animate-spin" />
            <p className="text-sm text-ink-secondary">Loading report...</p>
          </div>
        ) : (
        <div className="flex h-full">
        {/* Main content area */}
        <div className={`flex-1 overflow-hidden transition-all duration-300 ${transcriptOpen ? 'w-[60%]' : 'w-full'}`}>
        <div className="max-w-5xl mx-auto px-6 h-full flex gap-6">
          {/* Fixed left navigation (never scrolls) */}
          <SectionNav report={report} activeSection={activeSection} onSectionClick={handleSectionClick} hasNotes={sessionMemos.length > 0 || !!sessionNotes || sessionStageArchives.length > 0} />

          {/* Scrollable content area with sticky section headers */}
          <motion.div
            ref={contentRef}
            initial="hidden"
            animate="visible"
            className="flex-1 min-w-0 overflow-y-auto scroll-smooth"
          >
            {/* ── Overview section ── */}
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

            {/* ── Session Notes section ── */}
            {(sessionMemos.length > 0 || sessionNotes || sessionStageArchives.length > 0) && (
              <section id="notes" data-section className="pb-4">
                <SectionStickyHeader icon={BookOpen} title="Session Notes" />
                <motion.div variants={fadeInUp} custom={2}>
                  <StageMemosSection memos={sessionMemos} stages={sessionStages} notes={sessionNotes} stageArchives={sessionStageArchives} />
                </motion.div>
              </section>
            )}

            {/* ── Question-by-Question Analysis section ── */}
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

            {/* Awaiting Report UI — only show spinner when actively polling for finalization */}
            {report.persons.length === 0 && (finalizeStatus === 'awaiting' || finalizeStatus === 'finalizing') && !isDemo && (
              <motion.div variants={fadeInUp} custom={3} className="py-4">
                <Card className="p-8 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto mb-3" />
                  <p className="text-sm text-ink-secondary">
                    Generating feedback report...
                  </p>
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

            {/* ── Person sections ── */}
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

            {/* ── Transcript section ── */}
            {report.transcript.length > 0 && (
              <section id="transcript" data-section className="pb-4">
                <SectionStickyHeader icon={ScrollText} title="Transcript" />
                <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
                  <TranscriptSection
                    transcript={report.transcript}
                    evidenceMap={report.utteranceEvidenceMap}
                    onEvidenceBadgeClick={(evId) => {
                      const ev = report.evidence.find(e => e.id === evId);
                      if (ev) {
                        setDetailEvidence(ev);
                        setEvidenceModalMode('browse');
                      }
                    }}
                    scrollToUtteranceId={null}
                  />
                </motion.div>
              </section>
            )}

            {/* Bottom spacer to prevent last section from being obscured */}
            <div className="h-16" aria-hidden="true" />

          </motion.div>
        </div>
        </div>

        {/* Transcript sidebar */}
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
                  if (ev) {
                    setDetailEvidence(ev);
                    setEvidenceModalMode('browse');
                  }
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

      {/* Edit Claim Modal */}
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

      {/* Evidence Detail Modal */}
      <EvidenceDetailModal
        open={detailEvidence !== null}
        onClose={() => {
          setDetailEvidence(null);
        }}
        evidence={detailEvidence}
        report={report}
        mode={evidenceModalMode}
        onUseAsEvidence={() => {
          // When in claim-editor mode, add evidence to the current claim
          if (editClaim && detailEvidence && apiReport) {
            const updatedReport = updateClaimInReport(apiReport, editClaim.id, (c) => ({
              ...c,
              evidence_refs: c.evidence_refs.includes(detailEvidence.id)
                ? c.evidence_refs
                : [...c.evidence_refs, detailEvidence.id],
            }));
            setApiReport(updatedReport);
            // Also update editClaim to reflect the change
            setEditClaim((prev) => prev ? {
              ...prev,
              evidence_refs: prev.evidence_refs.includes(detailEvidence.id)
                ? prev.evidence_refs
                : [...prev.evidence_refs, detailEvidence.id],
            } : null);
            // Persist
            if (sessionId && sessionData?.baseApiUrl) {
              const updatedClaim = updatedReport.persons
                .flatMap(p => p.dimensions)
                .flatMap(d => d.claims)
                .find(c => c.id === editClaim.id);
              if (updatedClaim) {
                window.desktopAPI.updateFeedbackClaimEvidence({
                  baseUrl: sessionData.baseApiUrl,
                  sessionId: sessionId!,
                  body: { claim_id: editClaim.id, evidence_refs: updatedClaim.evidence_refs },
                }).catch(() => { /* non-fatal */ });
              }
            }
          }
          setDetailEvidence(null);
        }}
        onRemove={() => {
          // Remove evidence from the current claim
          if (editClaim && detailEvidence && apiReport) {
            setApiReport(updateClaimInReport(apiReport, editClaim.id, (c) => ({
              ...c,
              evidence_refs: c.evidence_refs.filter(id => id !== detailEvidence.id),
            })));
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
