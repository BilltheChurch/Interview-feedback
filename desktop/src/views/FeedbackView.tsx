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
} from 'lucide-react';
import { useSessionStore } from '../stores/sessionStore';
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
        return { dimension: d.dimension || 'unknown', claims };
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
    speaker: typeof e.speaker === 'string' ? e.speaker : (e.speaker?.display_name || e.speaker?.person_id || 'Unknown'),
    text: e.quote || e.text || '',
    confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
    weak: e.weak || false,
    weak_reason: e.weak_reason,
  }));

  return {
    session_id: raw.session?.session_id || raw.session_id || '',
    session_name: sessionMeta?.name || raw.session_name || '',
    date: sessionMeta?.date || raw.date || new Date().toISOString().slice(0, 10),
    duration_ms: sessionMeta?.durationMs || raw.duration_ms || 0,
    status: 'final',
    mode: (sessionMeta?.mode as '1v1' | 'group') || raw.mode || '1v1',
    participants,
    overall: {
      team_summary: teamSummary,
      teacher_memos: teacherMemos,
      interaction_events: interactionEvents,
      team_dynamics: teamDynamics,
      evidence_refs: overallEvidenceRefs,
    },
    persons,
    evidence,
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
                          dangerouslySetInnerHTML={{ __html: archive.freeformHtml || archive.freeformText }}
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
                      dangerouslySetInnerHTML={{ __html: notes }}
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
}: {
  report: FeedbackReport;
  onRegenerate: () => void;
  onBack: () => void;
  statusLabel?: string;
  statusVariant?: 'success' | 'warning' | 'info' | 'error';
  isDemo?: boolean;
  isEnhanced?: boolean;
  sessionNotes?: string;
  sessionMemos?: Memo[];
}) {
  const [copiedText, setCopiedText] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleCopyText = useCallback(async () => {
    const lines: string[] = [
      report.session_name,
      `${report.date} | ${formatDuration(report.duration_ms)}`,
      '',
    ];

    // Session notes (freeform)
    const notesText = sessionNotes?.replace(/<[^>]*>/g, '').trim();
    if (notesText) {
      lines.push('Session Notes:', notesText, '');
    }

    // Session memos (tagged by stage)
    if (sessionMemos && sessionMemos.length > 0) {
      lines.push('Session Memos:');
      for (const m of sessionMemos) {
        lines.push(`- [${m.stage}] ${m.text}`);
      }
      lines.push('');
    }

    lines.push('Team Summary:', report.overall.team_summary, '');

    if (report.overall.teacher_memos.length > 0) {
      lines.push('Teacher Memos:');
      lines.push(...report.overall.teacher_memos.map((m) => `- ${m}`));
      lines.push('');
    }

    if (report.overall.interaction_events.length > 0) {
      lines.push('Interaction Events:');
      lines.push(...report.overall.interaction_events.map((e) => `- ${e}`));
      lines.push('');
    }

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

    const text = lines.join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API may fail in Electron — fall back to execCommand
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
  }, [report, sessionNotes, sessionMemos]);

  const handleExportMarkdown = useCallback(() => {
    const lines: string[] = [
      `# ${report.session_name}`,
      `**Date:** ${report.date}  `,
      `**Duration:** ${formatDuration(report.duration_ms)}  `,
      `**Mode:** ${report.mode}  `,
      `**Participants:** ${report.participants.join(', ')}`,
      '',
    ];

    // Session notes (freeform)
    const notesText = sessionNotes?.replace(/<[^>]*>/g, '').trim();
    if (notesText) {
      lines.push('## Session Notes', '', notesText, '');
    }

    // Session memos (tagged by stage)
    if (sessionMemos && sessionMemos.length > 0) {
      lines.push('## Session Memos', '');
      for (const m of sessionMemos) {
        lines.push(`- **[${m.stage}]** ${m.text}`);
      }
      lines.push('');
    }

    lines.push('## Team Summary', '', report.overall.team_summary, '');

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

    if (report.evidence.length > 0) {
      lines.push('## Evidence Timeline');
      for (const ev of report.evidence) {
        const weakTag = ev.weak ? ' **(weak)** ' : '';
        lines.push(
          `- **[${formatTimestamp(ev.timestamp_ms)}]** ${ev.speaker}: "${ev.text}"${weakTag} _(${Math.round(ev.confidence * 100)}%)_`
        );
      }
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.session_name.replace(/\s+/g, '_')}_feedback.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [report, sessionNotes, sessionMemos]);

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
  const [eventsOpen, setEventsOpen] = useState((report.overall?.interaction_events?.length ?? 0) > 0);

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
          <Chip variant="warning" className="text-xs">weak</Chip>
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
      <div className="flex flex-wrap gap-1.5 mb-3">
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
      {/* Collapsible dimensions */}
      {person.dimensions.map((dim) => (
        <DimensionSummaryRow
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
                        className="text-xs text-ink-tertiary bg-surface-hover rounded px-1.5 py-0.5"
                      >
                        {person}: {claim.text.slice(0, 30)}...
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {ev.weak && <Chip variant="warning" className="text-xs">weak</Chip>}
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
  const cx = 90;
  const cy = 90;
  const r = 70;
  const n = dimensions.length;
  if (n < 3) return null;

  const angleStep = (2 * Math.PI) / n;

  // Score each dimension: ratio of strengths to total claims (0-1)
  const scores = dimensions.map((dim) => {
    const total = dim.claims.length;
    if (total === 0) return 0.5;
    const strengths = dim.claims.filter((c) => c.category === 'strength').length;
    return strengths / total;
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

  // Grid rings at 25%, 50%, 75%, 100%
  const rings = [0.25, 0.5, 0.75, 1.0];

  return (
    <div className="flex items-center justify-center py-3">
      <svg width="180" height="180" viewBox="0 0 180 180" className="overflow-visible">
        {/* Grid rings */}
        {rings.map((ring) => (
          <polygon
            key={ring}
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
        ))}

        {/* Axis lines */}
        {dimensions.map((_, i) => {
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

        {/* Labels */}
        {dimensions.map((dim, i) => {
          const angle = -Math.PI / 2 + i * angleStep;
          const labelR = r + 14;
          const x = cx + labelR * Math.cos(angle);
          const y = cy + labelR * Math.sin(angle);
          const label = dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1);
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fill="var(--color-ink-secondary)"
              fontSize="9"
              fontWeight="500"
            >
              {label.length > 10 ? label.slice(0, 8) + '...' : label}
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
      <div className="flex items-center gap-2 py-2 border-b border-border/40">
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
}: {
  report: FeedbackReport;
  activeSection: string;
  onSectionClick: (id: string) => void;
}) {
  const sections = [
    { id: 'overview', label: 'Overview' },
    { id: 'notes', label: 'Session Notes' },
    ...report.persons.map((p) => ({ id: `person-${p.speaker_id}`, label: p.person_name })),
    { id: 'evidence', label: 'Evidence' },
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
}: {
  dim: DimensionFeedback;
  report: FeedbackReport;
  onClaimEdit: (claim: Claim) => void;
  onEvidenceClick: (ev: EvidenceRef) => void;
  onNeedsEvidence: (claim: Claim) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = DIMENSION_ICONS[dim.dimension] ?? Layers;
  const label = dim.dimension.charAt(0).toUpperCase() + dim.dimension.slice(1);

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
        <span className="text-sm font-semibold text-ink flex-1 text-left">{label}</span>
        <span className="text-xs text-ink-tertiary">
          {strengthCount > 0 && <span className="text-success">{strengthCount}S</span>}
          {riskCount > 0 && <span className="ml-1.5 text-warning">{riskCount}R</span>}
          {actionCount > 0 && <span className="ml-1.5 text-blue-600">{actionCount}A</span>}
        </span>
      </button>
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

  // Attempt to load finalized report from API on mount
  useEffect(() => {
    if (!sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;

    async function tryLoadReport() {
      try {
        // First check finalization status — detect 'failed' early
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! });
        if (!cancelled && status && typeof status === 'object') {
          if ((status as any).status === 'failed') {
            const errors = (status as any).errors;
            const msg = Array.isArray(errors) && errors.length > 0
              ? errors.join('; ')
              : 'Finalization failed on the server.';
            setFinalizeError(msg);
            setFinalizeStatus('error');
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
    const POLL_TIMEOUT_MS = 180_000;

    // Declare interval before poll so the closure can clear it
    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      // Check for timeout using the stable ref
      if (Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        if (interval) clearInterval(interval);
        if (!cancelled) {
          setFinalizeError('Finalization timed out after 3 minutes. The server may still be processing.');
          setFinalizeStatus('error');
        }
        return;
      }

      try {
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! });
        if (cancelled) return;

        if (status && typeof status === 'object') {
          const backendStatus = (status as any).status;

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
  const [highlightEvidence, setHighlightEvidence] = useState<string | null>(null);

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
      };
    }

    // Case 3: No session data at all -- demo fallback
    return DEMO_REPORT;
  }, [apiReport, sessionData, sessionId, derivedTeacherMemos, finalizeStatus]);

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

  const handleRegenerate = useCallback(async () => {
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
      });
      // Polling will pick up the new report
    } catch {
      setFinalizeStatus('error');
    } finally {
      finalizingRef.current = false;
      useSessionStore.getState().setFinalizeRequested(false);
    }
  }, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);

  const handleTimelineEvidenceClick = (ev: EvidenceRef) => {
    setHighlightEvidence(ev.id);
    setDetailEvidence(ev);
    setEvidenceModalMode('browse');
  };

  // Section navigation + scroll-spy
  const [activeSection, setActiveSection] = useState('overview');
  const contentRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── Fixed header zone (never scrolls) ── */}
      {!reportLoading && (
        <div className="shrink-0 bg-bg border-b border-border">
          <div className="max-w-5xl mx-auto px-6 pt-6 pb-4">
            <FeedbackHeader
              report={report}
              onRegenerate={handleRegenerate}
              onBack={() => navigate('/history')}
              statusLabel={statusLabel}
              statusVariant={statusVariant}
              isDemo={isDemo}
              isEnhanced={finalizeStatus === 'tier2_ready'}
              sessionNotes={sessionNotes}
              sessionMemos={sessionMemos}
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
        <div className="max-w-5xl mx-auto px-6 h-full flex gap-6">
          {/* Fixed left navigation (never scrolls) */}
          <SectionNav report={report} activeSection={activeSection} onSectionClick={handleSectionClick} />

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
                <OverallCard report={report} onEvidenceClick={handleEvidenceClick} />
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

            {/* Awaiting Report UI — only show spinner when actively polling for finalization */}
            {report.persons.length === 0 && (finalizeStatus === 'awaiting' || finalizeStatus === 'finalizing') && !isDemo && (
              <motion.div variants={fadeInUp} custom={3} className="py-4">
                <Card className="p-8 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto mb-3" />
                  <p className="text-sm text-ink-secondary">
                    Generating feedback report...
                  </p>
                  <p className="text-xs text-ink-tertiary mt-1">
                    This may take up to a minute. The page will update automatically.
                  </p>
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
                  />
                </motion.div>
              </section>
            ))}

            {/* ── Evidence section ── */}
            <section id="evidence" data-section className="pb-6">
              <SectionStickyHeader icon={MessageSquare} title="Evidence Timeline" />
              <motion.div variants={fadeInUp} custom={report.persons.length + 3}>
                <EvidenceTimeline
                  report={report}
                  highlightEvidence={highlightEvidence}
                  onEvidenceClick={handleTimelineEvidenceClick}
                />
              </motion.div>
            </section>
          </motion.div>
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
          setHighlightEvidence(null);
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
