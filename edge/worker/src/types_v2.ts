export type StreamRole = "mixed" | "teacher" | "students";

export type MemoType = "observation" | "evidence" | "question" | "decision" | "score";

export interface MemoAnchor {
  mode: "time" | "utterance";
  time_range_ms?: [number, number];
  utterance_ids?: string[];
}

export interface MemoItem {
  memo_id: string;
  created_at_ms: number;
  author_role: "teacher";
  type: MemoType;
  tags: string[];
  text: string;
  anchors?: MemoAnchor;
  stage?: string;           // e.g., "Intro", "Q1: System Design"
  stage_index?: number;     // 0, 1, 2, ...
}

export interface SpeakerTurn {
  turn_id: string;
  start_ms: number;
  end_ms: number;
  stream_role: StreamRole;
  cluster_id: string;
  utterance_id?: string | null;
}

export interface SpeakerCluster {
  cluster_id: string;
  turn_ids: string[];
  confidence?: number | null;
}

export interface SpeakerMapItem {
  cluster_id: string;
  person_id?: string | null;
  display_name?: string | null;
  source?: "manual" | "enroll" | "name_extract" | "unknown";
}

export interface SpeakerLogs {
  source: "edge" | "cloud";
  window?: string;
  start_end_ms?: [number, number];
  turns: SpeakerTurn[];
  clusters: SpeakerCluster[];
  speaker_map: SpeakerMapItem[];
  updated_at: string;
}

export type FinalizeV2StatusState =
  | "idle"
  | "queued"
  | "running"
  | "succeeded"
  | "failed";

export type FinalizeV2Stage =
  | "idle"
  | "freeze"
  | "drain"
  | "replay_gap"
  | "local_asr"
  | "cluster"
  | "reconcile"
  | "stats"
  | "events"
  | "report"
  | "persist";

export interface FinalizeV2Status {
  job_id: string;
  status: FinalizeV2StatusState;
  stage: FinalizeV2Stage;
  progress: number;
  errors: string[];
  warnings: string[];
  degraded: boolean;
  backend_used: "primary" | "secondary" | "local" | "mixed";
  version: "v2";
  started_at: string;
  heartbeat_at?: string;
  finished_at?: string | null;
}

// ── Tier 2 Background Processing Status ──────────────────────────────────

export type Tier2StatusState =
  | "idle"
  | "pending"
  | "downloading"
  | "transcribing"
  | "diarizing"
  | "reconciling"
  | "reporting"
  | "persisting"
  | "succeeded"
  | "failed";

export interface Tier2Status {
  enabled: boolean;
  status: Tier2StatusState;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  report_version: "tier1_instant" | "tier2_refined";
  progress: number;
  warnings: string[];
}

export interface EvidenceItem {
  evidence_id: string;
  type: "quote" | "segment" | "stats_summary" | "interaction_pattern" | "transcript_quote";
  time_range_ms: [number, number];
  utterance_ids: string[];
  speaker: {
    cluster_id?: string | null;
    person_id?: string | null;
    display_name?: string | null;
  };
  quote: string;
  confidence: number;
  weak?: boolean;
  weak_reason?: string | null;
  source?: "explicit_anchor" | "semantic_match" | "speaker_fallback" | "memo_text" | "llm_backfill" | "auto_generated";
}

export interface DimensionClaim {
  claim_id: string;
  text: string;
  evidence_refs: string[];
  confidence: number;
  supporting_utterances?: string[];
}

export interface DimensionFeedback {
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  strengths: DimensionClaim[];
  risks: DimensionClaim[];
  actions: DimensionClaim[];
}

export interface PersonFeedbackItem {
  person_key: string;
  display_name: string;
  dimensions: DimensionFeedback[];
  summary: {
    strengths: string[];
    risks: string[];
    actions: string[];
  };
}

export interface ReportQualityMeta {
  generated_at: string;
  build_ms: number;
  validation_ms: number;
  claim_count: number;
  invalid_claim_count: number;
  needs_evidence_count: number;
  report_source?: "memo_first" | "llm_enhanced" | "llm_failed"
    | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback";
  report_model?: string | null;
  report_degraded?: boolean;
  report_error?: string | null;
}

export interface SpeakerStatItem {
  speaker_key: string;
  speaker_name?: string | null;
  talk_time_ms: number;
  talk_time_pct: number;
  turns: number;
  silence_ms: number;
  interruptions: number;
  interrupted_by_others: number;
}

export interface ResultV2 {
  session: {
    session_id: string;
    finalized_at: string;
    tentative: boolean;
    confidence_level: "high" | "medium" | "low";
    unresolved_cluster_count: number;
    diarization_backend: "cloud" | "edge";
  };
  transcript: Array<{
    utterance_id: string;
    stream_role: StreamRole;
    cluster_id?: string | null;
    speaker_name?: string | null;
    decision?: "auto" | "confirm" | "unknown" | null;
    text: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
  }>;
  speaker_logs: SpeakerLogs;
  stats: SpeakerStatItem[];
  memos: MemoItem[];
  evidence: EvidenceItem[];
  overall: unknown;
  per_person: PersonFeedbackItem[];
  quality: ReportQualityMeta;
  trace: {
    finalize_job_id: string;
    model_versions: Record<string, string>;
    thresholds: Record<string, number | string | boolean>;
    unknown_ratio: number;
    backend_timeline?: Array<{
      ts: string;
      endpoint: string;
      backend: string;
      outcome: "ok" | "failed" | "skipped";
      detail: string;
      attempt: number;
    }>;
    quality_gate_snapshot?: {
      finalize_success_target: number;
      students_unknown_ratio_target: number;
      sv_top1_target: number;
      echo_reduction_target: number;
      observed_unknown_ratio: number;
      observed_students_turns: number;
      observed_students_unknown: number;
      observed_echo_suppressed_chunks: number;
      observed_echo_recent_rate: number;
      observed_echo_leak_rate?: number;
      observed_suppression_false_positive_rate?: number;
    };
    report_pipeline?: {
      mode: "memo_first_with_llm_polish" | "llm_core_synthesis";
      source: "memo_first" | "llm_enhanced" | "llm_failed"
        | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback";
      llm_attempted: boolean;
      llm_success: boolean;
      llm_elapsed_ms: number | null;
      blocking_reason?: string | null;
    };
    quality_gate_failures?: string[];
    generated_at: string;
  };
}

export interface MemoSpeakerBinding {
  memo_id: string;
  extracted_names: string[];
  matched_speaker_keys: string[];
  confidence: number;
}

export interface SynthesisContextMeta {
  rubric_used: boolean;
  free_notes_used: boolean;
  historical_sessions_count: number;
  name_bindings_count: number;
  stages_count: number;
  transcript_tokens_approx: number;
  transcript_truncated: boolean;
}

export interface RubricDimension {
  name: string;
  description?: string;
  weight: number;
}

export interface RubricTemplate {
  template_name: string;
  dimensions: RubricDimension[];
}

export interface StageDescription {
  stage_index: number;
  stage_name: string;
  description?: string;
}

export interface SessionContextMeta {
  mode: "1v1" | "group";
  interviewer_name?: string;
  position_title?: string;
  company_name?: string;
  stage_descriptions: StageDescription[];
}

export interface HistoricalSummary {
  session_id: string;
  date: string;
  summary: string;
  strengths: string[];
  risks: string[];
}

export interface SynthesizeRequestPayload {
  session_id: string;
  transcript: Array<{
    utterance_id: string;
    stream_role: "mixed" | "teacher" | "students";
    speaker_name?: string | null;
    cluster_id?: string | null;
    decision?: "auto" | "confirm" | "unknown" | null;
    text: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
  }>;
  memos: MemoItem[];
  free_form_notes?: string | null;
  evidence: EvidenceItem[];
  stats: SpeakerStatItem[];
  events: Array<{
    event_id: string;
    event_type: string;
    actor?: string | null;
    target?: string | null;
    time_range_ms: number[];
    utterance_ids: string[];
    quote?: string | null;
    confidence: number;
    rationale?: string | null;
  }>;
  rubric?: RubricTemplate | null;
  session_context?: SessionContextMeta | null;
  memo_speaker_bindings: MemoSpeakerBinding[];
  historical: HistoricalSummary[];
  stages: string[];
  locale: string;
  name_aliases?: Record<string, string[]>;
  stats_observations?: string[];
}

// ── Incremental Checkpoint Types ────────────────────────────────────────

export interface CheckpointSpeakerNote {
  speaker_key: string;
  observations: string[];
}

export interface CheckpointDimensionSignal {
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  speaker_key: string;
  signal: "positive" | "negative" | "neutral";
  note: string;
}

export interface CheckpointRequestPayload {
  session_id: string;
  checkpoint_index: number;
  utterances: Array<{
    utterance_id: string;
    stream_role: "mixed" | "teacher" | "students";
    speaker_name?: string | null;
    cluster_id?: string | null;
    decision?: "auto" | "confirm" | "unknown" | null;
    text: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
  }>;
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  locale: string;
}

export interface CheckpointResult {
  session_id: string;
  checkpoint_index: number;
  timestamp_ms: number;
  summary: string;
  per_speaker_notes: CheckpointSpeakerNote[];
  dimension_signals: CheckpointDimensionSignal[];
}

export interface MergeCheckpointsRequestPayload {
  session_id: string;
  checkpoints: CheckpointResult[];
  final_stats: SpeakerStatItem[];
  final_memos: MemoItem[];
  evidence: Array<EvidenceItem & { speaker_key?: string | null }>;
  locale: string;
}

// ── Caption Source ──────────────────────────────────────────────────────
/** Caption data source. 'none' = use audio ASR, 'acs-teams' = use ACS captions. */
export type CaptionSource = 'none' | 'acs-teams';
