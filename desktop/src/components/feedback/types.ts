/* ─── Shared Feedback Types ───────────────────────────────────────────────────
 * Exported from here so ClaimCard, DimensionSection, RadarChart, and
 * useFeedbackData can all share the same type definitions without importing
 * from FeedbackView.tsx (which would create a circular dependency).
 * ─────────────────────────────────────────────────────────────────────────── */

import type { TranscriptUtterance, UtteranceEvidenceMap } from '../TranscriptSection';
import type { QuestionAnalysisItem } from '../QuestionBreakdownSection';

export type EvidenceRef = {
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

export type Claim = {
  id: string;
  text: string;
  category: 'strength' | 'risk' | 'action';
  confidence: number;
  evidence_refs: string[];
};

export type DimensionFeedback = {
  dimension: string;
  label_zh?: string;
  score?: number;
  score_rationale?: string;
  evidence_insufficient?: boolean;
  not_applicable?: boolean;
  claims: Claim[];
};

export type CommunicationMetricsData = {
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

export type PersonFeedback = {
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

export type TeamDynamic = {
  type: 'highlight' | 'risk';
  text: string;
};

export type Recommendation = {
  decision: 'recommend' | 'tentative' | 'not_recommend';
  confidence: number;
  rationale: string;
  context_type: 'hiring' | 'admission';
};

export type OverallFeedback = {
  team_summary: string;
  teacher_memos: string[];
  interaction_events: string[];
  team_dynamics: TeamDynamic[];
  evidence_refs: string[];
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

export type ClaimBeforeAfter = {
  before: string;
  after: string;
};

export type ClaimImprovement = {
  claim_id: string;
  advice: string;
  suggested_wording: string;
  before_after: ClaimBeforeAfter | null;
};

export type DimensionImprovement = {
  dimension: string;
  advice: string;
  framework: string;
  example_response: string;
};

export type OverallImprovement = {
  summary: string;
  key_points: string[];
};

export type ImprovementReport = {
  overall: OverallImprovement;
  dimensions: DimensionImprovement[];
  claims: ClaimImprovement[];
  follow_up_questions?: Array<{ question: string; purpose: string; related_claim_id?: string }>;
  action_plan?: Array<{ action: string; related_claim_id?: string; practice_method: string; expected_outcome: string }>;
};

export type FeedbackReport = {
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

export type Memo = {
  id: string;
  type: 'highlight' | 'issue' | 'question' | 'evidence';
  text: string;
  timestamp: number;
  stage: string;
};
