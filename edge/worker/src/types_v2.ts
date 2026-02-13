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
  version: "v2";
  started_at: string;
  heartbeat_at?: string;
  finished_at?: string | null;
}

export interface EvidenceItem {
  evidence_id: string;
  type: "quote" | "segment";
  time_range_ms: [number, number];
  utterance_ids: string[];
  speaker: {
    cluster_id?: string | null;
    person_id?: string | null;
    display_name?: string | null;
  };
  quote: string;
  confidence: number;
}

export interface DimensionClaim {
  claim_id: string;
  text: string;
  evidence_refs: string[];
  confidence: number;
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
}

export interface SpeakerStatItem {
  speaker_key: string;
  speaker_name?: string | null;
  talk_time_ms: number;
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
    generated_at: string;
  };
}
