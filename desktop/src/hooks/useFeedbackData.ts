import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSessionStore } from '../stores/sessionStore';
import type { FeedbackReport, Memo } from '../components/feedback/types';

/* ─── Raw API types (normalization input) ─────────────────────────────────── */

interface RawClaim {
  claim_id?: string;
  id?: string;
  text?: string;
  category?: string;
  confidence?: number;
  evidence_refs?: string[];
}

interface RawDimension {
  dimension?: string;
  label_zh?: string;
  score?: number | string;
  score_rationale?: string;
  evidence_insufficient?: boolean;
  not_applicable?: boolean;
  claims?: RawClaim[];
  strengths?: RawClaim[];
  risks?: RawClaim[];
  actions?: RawClaim[];
}

interface RawSpeaker {
  speaker_name?: string;
  speaker_key?: string;
  display_name?: string;
  person_id?: string;
}

interface RawPerson {
  display_name?: string;
  person_name?: string;
  person_key?: string;
  speaker_id?: string;
  dimensions?: RawDimension[];
  summary?: {
    strengths?: string | string[];
    risks?: string | string[];
    actions?: string | string[];
  };
}

interface RawEvidenceItem {
  evidence_id?: string;
  id?: string;
  time_range_ms?: number[];
  timestamp_ms?: number;
  end_ms?: number;
  speaker?: string | { display_name?: string; person_id?: string };
  quote?: string;
  text?: string;
  confidence?: number;
  weak?: boolean;
  weak_reason?: string;
  utterance_ids?: string[];
}

interface RawSummarySection {
  bullets?: string[];
  evidence_ids?: string[];
}

interface RawMemo {
  stage?: string;
  text?: string;
}

interface RawUtterance {
  utterance_id?: string;
  speaker_name?: string;
  text?: string;
  start_ms?: number;
  end_ms?: number;
}

export interface RawApiReport {
  stats?: RawSpeaker[];
  participants?: (string | RawSpeaker)[];
  overall?: {
    team_summary?: string;
    summary_sections?: RawSummarySection[];
    narrative?: string;
    narrative_evidence_refs?: string[];
    key_findings?: FeedbackReport['overall']['keyFindings'];
    suggested_dimensions?: FeedbackReport['overall']['suggestedDimensions'];
    teacher_memos?: string[];
    team_dynamics?: FeedbackReport['overall']['team_dynamics'] | { highlights?: string[]; risks?: string[] };
    interaction_events?: string[];
    evidence_refs?: string[];
    recommendation?: FeedbackReport['overall']['recommendation'];
    question_analysis?: NonNullable<FeedbackReport['overall']['questionAnalysis']>;
    interview_quality?: FeedbackReport['overall']['interviewQuality'];
    interview_type?: string;
    position_title?: string;
    [key: string]: unknown;
  };
  per_person?: RawPerson[];
  persons?: RawPerson[];
  evidence?: RawEvidenceItem[];
  memos?: RawMemo[];
  transcript?: RawUtterance[];
  session?: { session_id?: string; caption_source?: string; [key: string]: unknown };
  session_id?: string;
  session_name?: string;
  date?: string;
  duration_ms?: number;
  mode?: string;
  caption_source?: string;
  interview_type?: string;
  position_title?: string;
  recommendation?: FeedbackReport['overall']['recommendation'];
  question_analysis?: NonNullable<FeedbackReport['overall']['questionAnalysis']>;
  interview_quality?: FeedbackReport['overall']['interviewQuality'];
  improvements?: FeedbackReport['improvements'];
  user_edits?: Array<{ field_path: string; edited_value: unknown; edited_at: string }>;
  [key: string]: unknown;
}

/* ─── Session data type (from localStorage or location.state) ─────────────── */

export type SessionData = {
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
  stageArchives?: Array<{
    stageIndex: number;
    stageName: string;
    archivedAt: string;
    freeformText: string;
    freeformHtml?: string;
    memoIds: string[];
  }>;
  elapsedSeconds?: number;
  date?: string;
  baseApiUrl?: string;
  report?: Record<string, unknown>;
};

type FinalizeStatus =
  | 'not_started'
  | 'awaiting'
  | 'finalizing'
  | 'final'
  | 'tier2_running'
  | 'tier2_ready'
  | 'error';

interface FinalizeStatusResult {
  status?: string;
  stage?: string;
  progress?: number;
  errors?: string[];
}

interface OpenFeedbackResult {
  report?: RawApiReport;
  blocking_reason?: string;
}

/* ─── Helpers ─────────────────────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function calculateLegacyScore(dim: RawDimension): number {
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

function stripInlineEvidenceRefs(text: string): { cleanText: string; extractedRefs: string[] } {
  const refs: string[] = [];
  const clean = text.replace(/\[e_\d+\]/g, (match) => {
    refs.push(match.slice(1, -1));
    return '';
  });
  return { cleanText: clean.trim(), extractedRefs: refs };
}

const FILLER_WORDS_EN = /\b(um|uh|like|you know|i mean|basically|actually|so yeah)\b/gi;
const FILLER_WORDS_ZH = /(就是|然后|那个|嗯|啊|对吧|这个)/g;

/**
 * Normalizes a raw API response (ResultV2) into the shape the UI expects.
 * Also computes per-person communication metrics from transcript data.
 */
export function normalizeApiReport(
  raw: RawApiReport,
  sessionMeta?: { name?: string; date?: string; durationMs?: number; mode?: string; participants?: string[] },
): FeedbackReport {
  const participants: string[] = (() => {
    if (Array.isArray(raw.stats)) {
      return raw.stats
        .map((s: RawSpeaker) => s.speaker_name || s.speaker_key || 'Unknown')
        .filter((n: string) => n !== 'Unknown');
    }
    if (Array.isArray(raw.participants)) {
      return raw.participants.map((p: string | RawSpeaker) =>
        typeof p === 'string' ? p : p?.display_name || p?.person_id || 'Unknown',
      );
    }
    return sessionMeta?.participants || [];
  })();

  const teamSummary: string = (() => {
    if (typeof raw.overall?.team_summary === 'string') return raw.overall.team_summary;
    if (Array.isArray(raw.overall?.summary_sections)) {
      return raw.overall.summary_sections
        .map((s: RawSummarySection) => (Array.isArray(s.bullets) ? s.bullets.join(' ') : ''))
        .filter(Boolean)
        .join('\n\n');
    }
    return '';
  })();

  let teamSummaryNarrative = '';
  let teamSummaryEvidenceRefs: string[] = [];
  const overall = raw.overall;
  if (overall?.narrative) {
    teamSummaryNarrative = overall.narrative;
    teamSummaryEvidenceRefs = overall.narrative_evidence_refs ?? [];
  } else if (overall?.summary_sections) {
    teamSummaryNarrative = (overall.summary_sections as RawSummarySection[])
      .map((s: RawSummarySection) => s.bullets?.join(' '))
      .filter(Boolean)
      .join('\n\n');
  }

  const keyFindings = overall?.key_findings ?? [];
  const suggestedDimensions = overall?.suggested_dimensions ?? [];

  const teacherMemos: string[] = (() => {
    if (Array.isArray(raw.overall?.teacher_memos)) return raw.overall.teacher_memos;
    if (Array.isArray(raw.memos)) {
      return raw.memos.map((m: RawMemo) => {
        const prefix = m.stage ? `[${m.stage}] ` : '';
        return `${prefix}${m.text || ''}`;
      });
    }
    return [];
  })();

  const teamDynamics: FeedbackReport['overall']['team_dynamics'] = (() => {
    const td = raw.overall?.team_dynamics;
    if (Array.isArray(td)) return td;
    if (td && typeof td === 'object' && !Array.isArray(td)) {
      const result: FeedbackReport['overall']['team_dynamics'] = [];
      const tdObj = td as { highlights?: string[]; risks?: string[] };
      if (Array.isArray(tdObj.highlights)) {
        for (const h of tdObj.highlights) result.push({ type: 'highlight', text: String(h) });
      }
      if (Array.isArray(tdObj.risks)) {
        for (const r of tdObj.risks) result.push({ type: 'risk', text: String(r) });
      }
      return result;
    }
    return [];
  })();

  const interactionEvents: string[] = Array.isArray(raw.overall?.interaction_events)
    ? raw.overall.interaction_events
    : [];

  const overallEvidenceRefs: string[] = (() => {
    if (Array.isArray(raw.overall?.evidence_refs)) return raw.overall.evidence_refs;
    if (Array.isArray(raw.overall?.summary_sections)) {
      return raw.overall.summary_sections
        .flatMap((s: RawSummarySection) => (Array.isArray(s.evidence_ids) ? s.evidence_ids : []));
    }
    return [];
  })();

  const persons: FeedbackReport['persons'] = (() => {
    const source = Array.isArray(raw.per_person) ? raw.per_person
      : Array.isArray(raw.persons) ? raw.persons
      : [];
    return source.map((p: RawPerson) => {
      const dimensions: FeedbackReport['persons'][number]['dimensions'] = (Array.isArray(p.dimensions) ? p.dimensions : []).map((d: RawDimension) => {
        const claims: FeedbackReport['persons'][number]['dimensions'][number]['claims'] = [];
        if (Array.isArray(d.claims)) {
          for (const c of d.claims) {
            claims.push({
              id: c.id || c.claim_id || `${d.dimension}_${claims.length}`,
              text: c.text || '',
              category: (c.category as 'strength' | 'risk' | 'action') || 'strength',
              confidence: typeof c.confidence === 'number' ? c.confidence : 0.5,
              evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [],
            });
          }
        } else {
          for (const c of (Array.isArray(d.strengths) ? d.strengths : [])) {
            claims.push({ id: c.claim_id || `${d.dimension}_s${claims.length}`, text: c.text || '', category: 'strength', confidence: typeof c.confidence === 'number' ? c.confidence : 0.5, evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [] });
          }
          for (const c of (Array.isArray(d.risks) ? d.risks : [])) {
            claims.push({ id: c.claim_id || `${d.dimension}_r${claims.length}`, text: c.text || '', category: 'risk', confidence: typeof c.confidence === 'number' ? c.confidence : 0.5, evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [] });
          }
          for (const c of (Array.isArray(d.actions) ? d.actions : [])) {
            claims.push({ id: c.claim_id || `${d.dimension}_a${claims.length}`, text: c.text || '', category: 'action', confidence: typeof c.confidence === 'number' ? c.confidence : 0.5, evidence_refs: Array.isArray(c.evidence_refs) ? c.evidence_refs : [] });
          }
        }
        const cleanedClaims = claims.map((claim) => {
          const { cleanText, extractedRefs } = stripInlineEvidenceRefs(claim.text);
          return { ...claim, text: cleanText || claim.text, evidence_refs: [...claim.evidence_refs, ...extractedRefs] };
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

  const evidence: FeedbackReport['evidence'] = (Array.isArray(raw.evidence) ? raw.evidence : []).map((e: RawEvidenceItem) => ({
    id: e.evidence_id || e.id || '',
    timestamp_ms: Array.isArray(e.time_range_ms) ? e.time_range_ms[0] : (e.timestamp_ms || 0),
    end_ms: Array.isArray(e.time_range_ms) ? e.time_range_ms[1] : (e.end_ms || undefined),
    speaker: typeof e.speaker === 'string' ? e.speaker : (e.speaker as { display_name?: string; person_id?: string })?.display_name || (e.speaker as { display_name?: string; person_id?: string })?.person_id || 'Unknown',
    text: e.quote || e.text || '',
    confidence: typeof e.confidence === 'number' ? e.confidence : 0.5,
    weak: e.weak || false,
    weak_reason: e.weak_reason,
    utterance_ids: Array.isArray(e.utterance_ids) ? e.utterance_ids : undefined,
  }));

  const normalizedTranscript: FeedbackReport['transcript'] = (() => {
    if (!Array.isArray(raw.transcript)) return [];
    return raw.transcript.map((u: RawUtterance) => ({
      utterance_id: u.utterance_id || '',
      speaker_name: u.speaker_name || null,
      text: u.text || '',
      start_ms: typeof u.start_ms === 'number' ? u.start_ms : 0,
      end_ms: typeof u.end_ms === 'number' ? u.end_ms : 0,
    }));
  })();

  const utteranceEvidenceMap: FeedbackReport['utteranceEvidenceMap'] = {};
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  for (const ev of rawEvidence) {
    const evId = ev.evidence_id || ev.id || '';
    const uttIds = Array.isArray(ev.utterance_ids) ? ev.utterance_ids : [];
    for (const uid of uttIds) {
      if (!utteranceEvidenceMap[uid]) utteranceEvidenceMap[uid] = [];
      utteranceEvidenceMap[uid].push(evId);
    }
  }

  const captionSource = typeof raw.session?.caption_source === 'string'
    ? raw.session.caption_source
    : typeof raw.caption_source === 'string' ? raw.caption_source : undefined;

  const durationMs = sessionMeta?.durationMs || raw.duration_ms || 0;

  // Compute per-person communication metrics from transcript
  for (const person of persons) {
    const personUtterances = normalizedTranscript.filter((u) => u.speaker_name === person.person_name);
    if (personUtterances.length === 0) continue;

    const speakingTimeSec = personUtterances.reduce((sum, u) => sum + (u.end_ms - u.start_ms) / 1000, 0);
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
      avgResponseSec: personUtterances.length > 0 ? Math.round(speakingTimeSec / personUtterances.length) : 0,
      fillerWordCount: fillerCount,
      fillerWordsPerMin: speakingTimeSec > 0 ? Math.round((fillerCount / speakingTimeSec) * 60 * 10) / 10 : 0,
      avgLatencySec: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length * 10) / 10 : 0,
      longestPauseSec: latencies.length > 0 ? Math.round(Math.max(...latencies) * 10) / 10 : 0,
      turnCount: personUtterances.length,
    };
  }

  const recommendation = raw.overall?.recommendation || raw.recommendation || undefined;
  const questionAnalysis = Array.isArray(raw.overall?.question_analysis) ? raw.overall.question_analysis
    : Array.isArray(raw.question_analysis) ? raw.question_analysis : undefined;
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
      teamSummaryNarrative: teamSummaryNarrative || undefined,
      teamSummaryEvidenceRefs: teamSummaryEvidenceRefs.length > 0 ? teamSummaryEvidenceRefs : undefined,
      keyFindings: keyFindings.length > 0 ? keyFindings : undefined,
      suggestedDimensions: suggestedDimensions.length > 0 ? suggestedDimensions : undefined,
      recommendation,
      questionAnalysis: questionAnalysis && questionAnalysis.length > 0 ? questionAnalysis : undefined,
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

/* ─── useFeedbackData return type ─────────────────────────────────────────── */

export interface FeedbackDataResult {
  report: FeedbackReport;
  sessionData: SessionData | null;
  sessionMemos: Memo[];
  sessionNotes: string;
  sessionStages: string[];
  sessionStageArchives: SessionData['stageArchives'];
  finalizeStatus: FinalizeStatus;
  finalizeError: string | null;
  finalizeProgressInfo: { stage: string; progress: number } | null;
  reportLoading: boolean;
  tier2Progress: number;
  isDemo: boolean;
  statusLabel: string;
  statusVariant: 'success' | 'warning' | 'info' | 'error';
  handleRetryFinalize: () => Promise<void>;
  handleRegenerate: (mode?: 'full' | 'report-only') => Promise<void>;
  handleInlineEdit: (fieldPath: string, newValue: string) => void;
  setApiReport: (report: FeedbackReport | null) => void;
}

/* ─── useFeedbackData ─────────────────────────────────────────────────────── */

/**
 * Encapsulates all data-fetching, polling, and transformation logic for
 * FeedbackView. Accepts sessionId and sessionData as arguments so it can be
 * used without depending on router hooks directly.
 */
export function useFeedbackData(
  sessionId: string | undefined,
  sessionData: SessionData | null,
  demoReport: FeedbackReport,
): FeedbackDataResult {
  const isDemo = !sessionData?.sessionName;

  const [finalizeStatus, setFinalizeStatus] = useState<FinalizeStatus>(
    isDemo || !sessionData?.baseApiUrl ? 'not_started' : 'awaiting',
  );
  const [apiReport, setApiReport] = useState<FeedbackReport | null>(null);
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [reportLoading, setReportLoading] = useState(!isDemo && !!sessionData?.baseApiUrl);
  const [tier2Progress, setTier2Progress] = useState(0);
  const [finalizeProgressInfo, setFinalizeProgressInfo] = useState<{ stage: string; progress: number } | null>(null);

  const finalizingRef = useRef(false);
  const tier2PollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartedAtRef = useRef<number>(Date.now());

  // Mark session as 'finalized' in localStorage
  useEffect(() => {
    if (finalizeStatus !== 'final' || !sessionId) return;
    try {
      const sessions = JSON.parse(localStorage.getItem('ifb_sessions') || '[]');
      const updated = sessions.map((s: Record<string, unknown>) =>
        s.id === sessionId ? { ...s, status: 'finalized' } : s,
      );
      localStorage.setItem('ifb_sessions', JSON.stringify(updated));
    } catch { /* ignore */ }
  }, [finalizeStatus, sessionId]);

  // If session data includes a pre-stored report, normalize and use it
  useEffect(() => {
    if (!sessionData?.report || apiReport) return;
    try {
      const normalized = normalizeApiReport(sessionData.report as RawApiReport, {
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
      console.warn('[useFeedbackData] Failed to normalize pre-stored report:', err);
    }
  }, [sessionData?.report]); // eslint-disable-line react-hooks/exhaustive-deps

  // Attempt to load finalized report from API on mount
  useEffect(() => {
    if (!sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;

    async function tryLoadReport() {
      try {
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! }) as FinalizeStatusResult | null;
        if (!cancelled && status && typeof status === 'object') {
          const backendStatus = status.status;
          if (backendStatus === 'failed') {
            const errors = status.errors;
            const msg = Array.isArray(errors) && errors.length > 0 ? errors.join('; ') : 'Finalization failed on the server.';
            setFinalizeError(msg);
            setFinalizeStatus('error');
            return;
          }
          if (backendStatus === 'running' || backendStatus === 'queued') {
            setFinalizeStatus('awaiting');
            return;
          }
        }

        const result = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as OpenFeedbackResult | null;
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
            const reason = result.blocking_reason || 'Report quality did not meet threshold.';
            setFinalizeError(reason);
            setFinalizeStatus('error');
          }
        }
      } catch {
        if (!cancelled) setFinalizeStatus('awaiting');
      } finally {
        if (!cancelled) setReportLoading(false);
      }
    }

    tryLoadReport();
    return () => { cancelled = true; };
  }, [sessionId, sessionData?.baseApiUrl, isDemo]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll for finalization status when awaiting (timeout 10 min)
  useEffect(() => {
    if (!sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;
    pollStartedAtRef.current = Date.now();
    const POLL_TIMEOUT_MS = 600_000;

    let interval: ReturnType<typeof setInterval> | null = null;

    const poll = async () => {
      if (Date.now() - pollStartedAtRef.current > POLL_TIMEOUT_MS) {
        if (interval) clearInterval(interval);
        if (!cancelled) {
          setFinalizeError('Finalization timed out after 10 minutes. The server may still be processing — try refreshing from History.');
          setFinalizeStatus('error');
        }
        return;
      }

      try {
        const status = await window.desktopAPI.getFinalizeStatus({ baseUrl, sessionId: sessionId! }) as FinalizeStatusResult | null;
        if (cancelled) return;

        if (status && typeof status === 'object') {
          const backendStatus = status.status;
          const stage = status.stage;
          const progress = status.progress;
          if (stage && typeof progress === 'number') {
            setFinalizeProgressInfo({ stage, progress });
          }

          if (backendStatus === 'failed') {
            if (interval) clearInterval(interval);
            const errors = status.errors;
            const msg = Array.isArray(errors) && errors.length > 0 ? errors.join('; ') : 'Finalization failed on the server.';
            setFinalizeError(msg);
            setFinalizeStatus('error');
            return;
          }

          if (backendStatus === 'completed' || backendStatus === 'succeeded') {
            if (interval) clearInterval(interval);
            setFinalizeStatus('finalizing');
            try {
              const result = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as OpenFeedbackResult | null;
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
                  const reason = result.blocking_reason || 'Report quality did not meet threshold.';
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
    poll();

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, sessionData?.baseApiUrl, isDemo]);

  // Post-finalization: poll incremental/Tier2 for enhanced report
  useEffect(() => {
    if (finalizeStatus !== 'final' || !sessionId || !sessionData?.baseApiUrl || isDemo) return;

    let cancelled = false;
    const baseUrl = sessionData.baseApiUrl;

    const startTier2Poll = () => {
      const checkTier2 = async () => {
        try {
          const result = await window.desktopAPI.getTier2Status({ baseUrl, sessionId: sessionId! });
          if (cancelled) return;
          const data = result as Record<string, unknown>;
          if (!data || typeof data !== 'object') return;

          const tier2Status = data.status as string;
          const tier2Enabled = Boolean(data.enabled);
          const progress = typeof data.progress === 'number' ? data.progress : 0;

          if (!tier2Enabled || tier2Status === 'idle') {
            if (tier2PollRef.current) clearInterval(tier2PollRef.current);
            return;
          }

          setTier2Progress(progress);

          if (tier2Status === 'succeeded') {
            if (tier2PollRef.current) clearInterval(tier2PollRef.current);
            try {
              const freshResult = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as OpenFeedbackResult | null;
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
            } catch { /* keep tier1 report */ }
            return;
          }

          if (tier2Status === 'failed') {
            if (tier2PollRef.current) clearInterval(tier2PollRef.current);
            return;
          }

          setFinalizeStatus('tier2_running');
        } catch {
          if (tier2PollRef.current) clearInterval(tier2PollRef.current);
        }
      };

      tier2PollRef.current = setInterval(checkTier2, 5000);
      checkTier2();
    };

    const tryIncrementalFirst = async () => {
      try {
        const incStatus = await window.desktopAPI.getIncrementalStatus({ baseUrl, sessionId: sessionId! });
        if (cancelled) return;

        if (incStatus && incStatus.enabled && incStatus.increments_completed > 0) {
          const checkIncremental = async () => {
            try {
              const result = await window.desktopAPI.getIncrementalStatus({ baseUrl, sessionId: sessionId! });
              if (cancelled) return;

              if (result.status === 'succeeded') {
                if (tier2PollRef.current) clearInterval(tier2PollRef.current);
                try {
                  const freshResult = await window.desktopAPI.openFeedback({ baseUrl, sessionId: sessionId! }) as OpenFeedbackResult | null;
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
                } catch { /* keep current report */ }
                return;
              }

              if (result.status === 'failed') {
                if (tier2PollRef.current) clearInterval(tier2PollRef.current);
                startTier2Poll();
                return;
              }

              setFinalizeStatus('tier2_running');
            } catch {
              if (tier2PollRef.current) clearInterval(tier2PollRef.current);
              startTier2Poll();
            }
          };

          tier2PollRef.current = setInterval(checkIncremental, 3000);
          checkIncremental();
          return;
        }
      } catch {
        // Incremental not available — fall through to Tier 2
      }

      if (!cancelled) startTier2Poll();
    };

    const startDelay = setTimeout(() => {
      if (!cancelled) tryIncrementalFirst();
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

  const sessionMemos: Memo[] = sessionData?.memos || [];
  const sessionNotes: string = sessionData?.notes || '';
  const sessionStages: string[] = sessionData?.stages || [];
  const sessionStageArchives = sessionData?.stageArchives || [];

  const derivedTeacherMemos = sessionMemos.length > 0
    ? sessionMemos.map((m) => `[${m.stage}] ${m.text}`)
    : [];

  const report: FeedbackReport = useMemo(() => {
    if (apiReport) {
      const mergedMemos = apiReport.overall.teacher_memos.length > 0
        ? apiReport.overall.teacher_memos
        : derivedTeacherMemos;
      return {
        ...apiReport,
        status: 'final' as const,
        session_name: apiReport.session_name || sessionData?.sessionName || '',
        date: apiReport.date || sessionData?.date || new Date().toISOString().slice(0, 10),
        duration_ms: apiReport.duration_ms || (sessionData?.elapsedSeconds || 0) * 1000,
        overall: { ...apiReport.overall, teacher_memos: mergedMemos },
      };
    }

    if (sessionData?.sessionName) {
      const participantNames = sessionData.participants || [];
      const durationMs = (sessionData.elapsedSeconds || 0) * 1000;
      const sessionDate = sessionData.date || new Date().toISOString().slice(0, 10);

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
            : participantNames.length > 0
              ? `Session "${sessionData.sessionName}" with ${participantNames.length} participant${participantNames.length > 1 ? 's' : ''}: ${participantNames.join(', ')}.`
              : 'Report will be generated after finalization completes.',
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

    return demoReport;
  }, [apiReport, sessionData, sessionId, derivedTeacherMemos, finalizeStatus, demoReport]);

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

  const buildFinalizeMetadata = useCallback(() => {
    if (!sessionData) return {};
    return {
      memos: (sessionData.memos || []).map((m) => ({
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
    } catch {
      setFinalizeStatus('error');
    } finally {
      finalizingRef.current = false;
      useSessionStore.getState().setFinalizeRequested(false);
    }
  }, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);

  const handleRegenerate = useCallback(async (mode: 'full' | 'report-only' = 'full') => {
    if (!sessionId || !sessionData?.baseApiUrl || finalizingRef.current) return;
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
    } catch {
      setFinalizeStatus('error');
    } finally {
      finalizingRef.current = false;
      useSessionStore.getState().setFinalizeRequested(false);
    }
  }, [sessionId, sessionData?.baseApiUrl, buildFinalizeMetadata]);

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
      let obj: Record<string, unknown> = stored.report;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]] as Record<string, unknown>;
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

  return {
    report,
    sessionData,
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
  };
}
