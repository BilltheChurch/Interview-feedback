/**
 * config.ts — Shared types, interfaces, constants, and pure utility functions
 * extracted from the monolithic index.ts for the edge worker.
 *
 * Contains:
 *  - Env interface (Cloudflare Worker bindings)
 *  - Session/audio/ASR/enrollment/ingest types and interfaces
 *  - Storage key constants
 *  - Route regex patterns
 *  - Timeout/budget constants
 *  - Pure utility functions (parsing, formatting, state defaults)
 */

import type {
  FinalizeV2Status,
  FinalizeStageCheckpoint,
  MemoItem,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SessionPhase,
  SpeakerStatItem,
  SpeakerLogs,
  CaptionSource,
  DimensionPresetItem
} from "./types_v2";
import { SESSION_PHASE_TRANSITIONS } from "./types_v2";
import type { TranscriptItem } from "./finalize_v2";
import type { DependencyHealthSnapshot, InferenceEndpointKey } from "./inference_client";
import type { CaptionEvent } from "./providers/types";
import { TARGET_SAMPLE_RATE, TARGET_CHANNELS } from "./audio-utils";

// ── Structured JSON logging ──────────────────────────────────────────
export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Structured JSON logger for Cloudflare Workers.
 * Outputs {"level":"info","msg":"...","ts":"...","extra":{...}} format
 * compatible with Cloudflare Logpush and `wrangler tail --format=json`.
 */
export function log(
  level: LogLevel,
  msg: string,
  extra?: Record<string, unknown>
): void {
  const entry: Record<string, unknown> = {
    level,
    msg,
    ts: new Date().toISOString(),
  };
  if (extra && Object.keys(extra).length > 0) {
    entry.extra = extra;
  }
  const line = JSON.stringify(entry);
  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    default:
      console.log(line);
  }
}

// ── V1 incremental feature flag ─────────────────────────────────────
export function incrementalV1Enabled(env: Env): boolean {
  return env.INCREMENTAL_V1_ENABLED === "true";
}

// ── Stream roles ────────────────────────────────────────────────────
export type StreamRole = "mixed" | "teacher" | "students";
export const STREAM_ROLES: StreamRole[] = ["mixed", "teacher", "students"];

// ── Audio types ─────────────────────────────────────────────────────
export interface AudioPayload {
  content_b64: string;
  format: "wav" | "pcm_s16le" | "mp3" | "m4a" | "ogg" | "flac";
  sample_rate?: number;
  channels?: number;
}

export interface RosterEntry {
  name: string;
  email?: string | null;
  aliases?: string[];
}

export interface ResolveRequest {
  audio: AudioPayload;
  asr_text?: string | null;
  roster?: RosterEntry[];
}

export interface ClusterState {
  cluster_id: string;
  centroid: number[];
  sample_count: number;
  bound_name?: string | null;
}

export interface ParticipantProfile {
  name: string;
  email?: string | null;
  centroid: number[];
  sample_count: number;
  sample_seconds: number;
  status: "collecting" | "ready";
}

export interface BindingMeta {
  participant_name: string;
  source: "enrollment_match" | "name_extract" | "manual_map";
  confidence: number;
  locked: boolean;
  updated_at: string;
}

export interface EnrollmentParticipantProgress {
  name: string;
  sample_seconds: number;
  sample_count: number;
  status: "collecting" | "ready";
}

export interface EnrollmentUnassignedProgress {
  sample_seconds: number;
  sample_count: number;
}

export interface EnrollmentState {
  mode: "idle" | "collecting" | "ready" | "closed";
  started_at?: string | null;
  stopped_at?: string | null;
  participants: Record<string, EnrollmentParticipantProgress>;
  unassigned_clusters: Record<string, EnrollmentUnassignedProgress>;
  updated_at: string;
}

export interface SessionState {
  clusters: ClusterState[];
  bindings: Record<string, string>;
  roster?: RosterEntry[];
  capture_by_stream?: Record<StreamRole, CaptureState>;
  config: Record<string, unknown>;
  participant_profiles: ParticipantProfile[];
  cluster_binding_meta: Record<string, BindingMeta>;
  prebind_by_cluster: Record<string, BindingMeta>;
  enrollment_state: EnrollmentState;
}

export interface SessionConfigRequest {
  participants?: Array<RosterEntry | string>;
  teams_participants?: Array<RosterEntry | string>;
  teams_interviewer_name?: string;
  interviewer_name?: string;
  diarization_backend?: "cloud" | "edge" | "local";
  mode?: "1v1" | "group";
  template_id?: string;
  booking_ref?: string;
  teams_join_url?: string;
  stages?: string[];
  free_form_notes?: string;
  interview_type?: string;
  dimension_presets?: DimensionPresetItem[];
}

export interface CaptureState {
  capture_state: "idle" | "running" | "recovering" | "failed";
  recover_attempts?: number;
  last_recover_at?: string | null;
  last_recover_error?: string | null;
  echo_suppressed_chunks?: number;
  echo_suppression_recent_rate?: number;
  updated_at?: string;
}

export interface ResolveEvidence {
  sv_score: number;
  threshold_low: number;
  threshold_high: number;
  segment_count: number;
  name_hit?: string | null;
  roster_hit?: boolean | null;
  profile_top_name?: string | null;
  profile_top_score?: number | null;
  profile_margin?: number | null;
  binding_source?: string | null;
  reason?: string | null;
}

export interface ResolveResponse {
  session_id: string;
  cluster_id: string;
  speaker_name?: string | null;
  decision: "auto" | "confirm" | "unknown";
  evidence: ResolveEvidence;
  updated_state: SessionState;
}

export interface SpeakerEvent {
  ts: string;
  stream_role: StreamRole;
  source: "inference_resolve" | "teacher_direct" | "manual_map";
  identity_source?:
    | "teams_participants"
    | "preconfig"
    | "name_extract"
    | "teacher"
    | "inference_resolve"
    | "enrollment_match"
    | "manual_map"
    | null;
  utterance_id?: string | null;
  cluster_id?: string | null;
  speaker_name?: string | null;
  decision?: "auto" | "confirm" | "unknown" | null;
  evidence?: ResolveEvidence | null;
  note?: string | null;
  metadata?: Record<string, unknown> | null;
  backend?: "primary" | "secondary" | "worker";
  fallback_reason?: string | null;
  confidence_bucket?: "high" | "medium" | "low" | "unknown";
}

export interface EnrollmentStartRequest {
  participants?: Array<RosterEntry | string>;
  teams_participants?: Array<RosterEntry | string>;
  interviewer_name?: string;
  teams_interviewer_name?: string;
}

export interface ClusterMapRequest {
  stream_role?: StreamRole;
  cluster_id: string;
  participant_name: string;
  lock?: boolean;
  mode?: "bind" | "prebind";
}

export interface InferenceEnrollRequest {
  session_id: string;
  participant_name: string;
  audio: AudioPayload;
  state: SessionState;
}

export interface InferenceEnrollResponse {
  session_id: string;
  participant_name: string;
  embedding_dim: number;
  sample_seconds: number;
  profile_updated: boolean;
  updated_state: SessionState;
}

export interface FinalizeRequest {
  metadata?: Record<string, unknown>;
}

export interface FeedbackRegenerateClaimRequest {
  person_key: string;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim_id?: string;
  text_hint?: string;
}

export interface FeedbackClaimEvidenceRequest {
  person_key: string;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim_id?: string;
  evidence_refs: string[];
}

export interface InferenceRegenerateClaimRequest {
  session_id: string;
  person_key: string;
  display_name?: string | null;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim_id?: string;
  claim_text?: string;
  text_hint?: string;
  allowed_evidence_ids: string[];
  evidence: Array<{
    evidence_id: string;
    time_range_ms: [number, number];
    utterance_ids: string[];
    speaker_key?: string | null;
    quote: string;
    confidence: number;
  }>;
  transcript: TranscriptItem[];
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  locale: string;
}

export interface InferenceRegenerateClaimResponse {
  session_id: string;
  person_key: string;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim: {
    claim_id: string;
    text: string;
    evidence_refs: string[];
    confidence: number;
  };
}

export interface FeedbackExportRequest {
  format?: "plain_text" | "markdown" | "docx";
  file_name?: string;
}

export interface IngestState {
  meeting_id: string;
  last_seq: number;
  received_chunks: number;
  duplicate_chunks: number;
  missing_chunks: number;
  bytes_stored: number;
  started_at: string;
  updated_at: string;
}

export interface UtteranceRaw {
  utterance_id: string;
  session_id: string;
  stream_role: StreamRole;
  text: string;
  start_seq: number;
  end_seq: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  asr_model: string;
  asr_provider: "dashscope" | "local-whisper";
  confidence?: number | null;
  created_at: string;
  latency_ms: number;
}

export interface UtteranceMerged {
  merged_id: string;
  session_id: string;
  stream_role: StreamRole;
  text: string;
  start_seq: number;
  end_seq: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  asr_model: string;
  asr_provider: "dashscope" | "local-whisper";
  created_at: string;
  source_utterance_ids: string[];
}

export interface FeedbackTimings {
  assemble_ms: number;
  events_ms: number;
  report_ms: number;
  validation_ms: number;
  persist_ms: number;
  total_ms: number;
}

export interface FeedbackCache {
  session_id: string;
  updated_at: string;
  ready: boolean;
  person_summary_cache: PersonFeedbackItem[];
  overall_summary_cache: unknown;
  evidence_index_cache: Record<string, string[]>;
  report: ResultV2 | null;
  quality: ReportQualityMeta;
  timings: FeedbackTimings;
  report_source: string;
  blocking_reason: string | null;
  quality_gate_passed: boolean;
}

export interface QualityMetrics {
  unknown_ratio: number;
  students_utterance_count: number;
  students_unknown_count: number;
  echo_suppressed_chunks: number;
  echo_suppression_recent_rate: number;
  echo_leak_rate: number;
  suppression_false_positive_rate: number;
}

export interface HistoryIndexItem {
  session_id: string;
  finalized_at: string;
  tentative: boolean;
  unresolved_cluster_count: number;
  ready: boolean;
  needs_evidence_count: number;
  report_source: string;
}

export interface AsrState {
  enabled: boolean;
  provider: "dashscope";
  model: string;
  mode?: "realtime" | "windowed";
  asr_ws_state?: "disconnected" | "connecting" | "running" | "error";
  backlog_chunks?: number;
  ingest_lag_seconds?: number;
  last_emit_at?: string | null;
  ingest_to_utterance_p50_ms?: number | null;
  ingest_to_utterance_p95_ms?: number | null;
  recent_ingest_to_utterance_ms?: number[];
  window_seconds: number;
  hop_seconds: number;
  last_window_end_seq: number;
  utterance_count: number;
  total_windows_processed: number;
  total_audio_seconds_processed: number;
  last_window_latency_ms?: number | null;
  avg_window_latency_ms?: number | null;
  avg_rtf?: number | null;
  consecutive_failures: number;
  next_retry_after_ms: number;
  last_error?: string | null;
  last_success_at?: string | null;
  updated_at: string;
}

export interface AsrRunResult {
  generated: number;
  last_window_end_seq: number;
  utterance_count: number;
  total_windows_processed: number;
  total_audio_seconds_processed: number;
  last_window_latency_ms?: number | null;
  avg_window_latency_ms?: number | null;
  avg_rtf?: number | null;
  last_error?: string | null;
}

export interface AsrReplayCursor {
  last_ingested_seq: number;
  last_sent_seq: number;
  last_emitted_seq: number;
  updated_at: string;
}

export interface AsrQueueChunk {
  seq: number;
  timestampMs: number;
  receivedAtMs: number;
  bytes: Uint8Array;
}

export interface AsrRealtimeRuntime {
  ws: WebSocket | null;
  connectPromise: Promise<void> | null;
  flushPromise: Promise<void> | null;
  readyPromise: Promise<void> | null;
  readyResolve: (() => void) | null;
  readyReject: ((error: Error) => void) | null;
  streamRole: StreamRole;
  connected: boolean;
  connecting: boolean;
  running: boolean;
  taskId: string | null;
  sendQueue: AsrQueueChunk[];
  reconnectBackoffMs: number;
  lastSentSeq: number;
  startedAt: number;
  currentStartSeq: number | null;
  currentStartTsMs: number | null;
  sentChunkTsBySeq: Map<number, number>;
  lastEmitAt: string | null;
  lastFinalTextNorm: string;
  drainGeneration: number;
}

export interface AudioChunkFrame {
  type: "chunk";
  meeting_id: string;
  seq: number;
  timestamp_ms: number;
  sample_rate: number;
  channels: number;
  format: "pcm_s16le";
  content_b64: string;
  stream_role?: StreamRole;
}

// ── Env interface (Cloudflare Worker bindings) ──────────────────────
export interface Env {
  INFERENCE_BASE_URL: string;
  INFERENCE_BASE_URL_PRIMARY?: string;
  INFERENCE_BASE_URL_SECONDARY?: string;
  INFERENCE_FAILOVER_ENABLED?: string;
  INFERENCE_RETRY_MAX?: string;
  INFERENCE_RETRY_BACKOFF_MS?: string;
  INFERENCE_CIRCUIT_OPEN_MS?: string;
  INFERENCE_API_KEY?: string;
  INFERENCE_TIMEOUT_MS?: string;
  INFERENCE_RESOLVE_PATH?: string;
  INFERENCE_ENROLL_PATH?: string;
  INFERENCE_EVENTS_PATH?: string;
  INFERENCE_REPORT_PATH?: string;
  INFERENCE_REGENERATE_CLAIM_PATH?: string;
  INFERENCE_SYNTHESIZE_PATH?: string;
  INFERENCE_CHECKPOINT_PATH?: string;
  INFERENCE_MERGE_CHECKPOINTS_PATH?: string;
  INFERENCE_EXTRACT_EMBEDDING_PATH?: string;
  INFERENCE_RESOLVE_AUDIO_WINDOW_SECONDS?: string;
  ALIYUN_DASHSCOPE_API_KEY?: string;
  ASR_ENABLED?: string;
  ASR_MODEL?: string;
  ASR_WS_URL?: string;
  ASR_WINDOW_SECONDS?: string;
  ASR_HOP_SECONDS?: string;
  ASR_TIMEOUT_MS?: string;
  ASR_SEND_PACING_MS?: string;
  ASR_STREAM_CHUNK_BYTES?: string;
  ASR_REALTIME_ENABLED?: string;
  ASR_DEBUG_LOG_EVENTS?: string;
  MEMOS_ENABLED?: string;
  FINALIZE_V2_ENABLED?: string;
  FINALIZE_TIMEOUT_MS?: string;
  FINALIZE_WATCHDOG_MS?: string;
  CHECKPOINT_INTERVAL_MS?: string;
  DIARIZATION_BACKEND_DEFAULT?: "cloud" | "edge" | "local";
  AUDIO_RETENTION_HOURS?: string;
  ASR_PROVIDER?: string;
  ASR_ENDPOINT?: string;
  ASR_LANGUAGE?: string;
  WORKER_API_KEY?: string;
  DEFAULT_LOCALE?: string;
  TIER2_ENABLED?: string;
  TIER2_AUTO_TRIGGER?: string;
  TIER2_BATCH_ENDPOINT?: string;
  INCREMENTAL_V1_ENABLED?: string;
  INCREMENTAL_INTERVAL_MS?: string;
  INCREMENTAL_OVERLAP_MS?: string;
  INCREMENTAL_CUMULATIVE_THRESHOLD?: string;
  INCREMENTAL_ANALYSIS_INTERVAL?: string;
  RESULT_BUCKET: R2Bucket;
  MEETING_SESSION: DurableObjectNamespace;
}

// ── Default state ───────────────────────────────────────────────────
export const DEFAULT_STATE: SessionState = {
  clusters: [],
  bindings: {},
  capture_by_stream: defaultCaptureByStream(),
  config: {},
  participant_profiles: [],
  cluster_binding_meta: {},
  prebind_by_cluster: {},
  enrollment_state: buildDefaultEnrollmentState()
};

// ── Report quality helpers ──────────────────────────────────────────
export function emptyReportQualityMeta(nowIso: string): ReportQualityMeta {
  return {
    generated_at: nowIso,
    build_ms: 0,
    validation_ms: 0,
    claim_count: 0,
    invalid_claim_count: 0,
    needs_evidence_count: 0,
    report_source: "memo_first",
    report_model: null,
    report_degraded: false,
    report_error: null
  };
}

export function emptyFeedbackCache(sessionId: string, nowIso: string): FeedbackCache {
  return {
    session_id: sessionId,
    updated_at: nowIso,
    ready: false,
    person_summary_cache: [],
    overall_summary_cache: {},
    evidence_index_cache: {},
    report: null,
    quality: emptyReportQualityMeta(nowIso),
    timings: {
      assemble_ms: 0,
      events_ms: 0,
      report_ms: 0,
      validation_ms: 0,
      persist_ms: 0,
      total_ms: 0
    },
    report_source: "memo_first",
    blocking_reason: "feedback_not_generated",
    quality_gate_passed: false
  };
}

// ── Route regex patterns ────────────────────────────────────────────
export const SESSION_ROUTE_REGEX =
  /^\/v1\/sessions\/([^/]+)\/(resolve|state|finalize|utterances|asr-run|asr-reset|config|events|cluster-map|unresolved-clusters|memos|speaker-logs|result|feedback-ready|feedback-open|feedback-regenerate-claim|feedback-claim-evidence|export)$/;
export const SESSION_ENROLL_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/enrollment\/(start|stop|state|profiles)$/;
export const SESSION_FINALIZE_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/finalize\/status$/;
export const SESSION_TIER2_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/tier2-status$/;
export const SESSION_INCREMENTAL_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/incremental-status$/;
export const SESSION_HISTORY_ROUTE_REGEX = /^\/v1\/sessions\/history$/;
export const SESSION_PURGE_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/data$/;
export const WS_INGEST_ROUTE_REGEX = /^\/v1\/audio\/ws\/([^/]+)$/;
export const WS_INGEST_ROLE_ROUTE_REGEX = /^\/v1\/audio\/ws\/([^/]+)\/([^/]+)$/;

// ── Storage key constants ───────────────────────────────────────────
export const STORAGE_KEY_STATE = "state";
export const STORAGE_KEY_EVENTS = "events";
export const STORAGE_KEY_UPDATED_AT = "updated_at";
export const STORAGE_KEY_FINALIZED_AT = "finalized_at";
export const STORAGE_KEY_RESULT_KEY = "result_key";
export const STORAGE_KEY_RESULT_KEY_V2 = "result_key_v2";
export const STORAGE_KEY_FINALIZE_V2_STATUS = "finalize_v2_status";
export const STORAGE_KEY_FINALIZE_LOCK = "finalize_lock";
export const STORAGE_KEY_TIER2_STATUS = "tier2_status";
export const STORAGE_KEY_TIER2_ALARM_TAG = "tier2_alarm_tag";
export const STORAGE_KEY_INCREMENTAL_STATUS = "incremental_status";
export const STORAGE_KEY_INCREMENTAL_ALARM_TAG = "incremental_alarm_tag";
export const STORAGE_KEY_INCREMENTAL_SPEAKER_PROFILES = "incremental_speaker_profiles";
export const STORAGE_KEY_INCREMENTAL_CHECKPOINT = "incremental_checkpoint";
export const STORAGE_KEY_MEMOS = "memos";
export const STORAGE_KEY_SPEAKER_LOGS = "speaker_logs";
export const STORAGE_KEY_ASR_CURSOR_BY_STREAM = "asr_cursor_by_stream";
export const STORAGE_KEY_FEEDBACK_CACHE = "feedback_cache";
export const STORAGE_KEY_DEPENDENCY_HEALTH = "dependency_health";
export const STORAGE_KEY_INGEST_STATE = "ingest_state";
export const STORAGE_KEY_ASR_STATE = "asr_state";
export const STORAGE_KEY_UTTERANCES_RAW = "utterances_raw";
export const STORAGE_KEY_INGEST_BY_STREAM = "ingest_by_stream";
export const STORAGE_KEY_ASR_BY_STREAM = "asr_by_stream";
export const STORAGE_KEY_UTTERANCES_RAW_BY_STREAM = "utterances_raw_by_stream";
export const STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM = "utterances_merged_by_stream";
export const STORAGE_KEY_CHECKPOINTS = "checkpoints";
export const STORAGE_KEY_LAST_CHECKPOINT_AT = "last_checkpoint_at";
export const STORAGE_KEY_CAPTION_SOURCE = "caption_source";
export const STORAGE_KEY_CAPTION_BUFFER = "caption_buffer";
export const STORAGE_KEY_INCREMENTAL_UTTERANCES = "incremental_utterances";
export const STORAGE_KEY_SESSION_PHASE = "session_phase";
export const STORAGE_KEY_FINALIZE_STAGE_DATA = "finalize_stage_data";
export const MAX_STORED_UTTERANCES = 2000;

// ── Protocol & audio constants ──────────────────────────────────────
export const TARGET_FORMAT = "pcm_s16le";
export const INFERENCE_MAX_AUDIO_SECONDS = 30;
export const DASHSCOPE_DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
export const DASHSCOPE_DEFAULT_MODEL = "fun-asr-realtime-2025-11-07";
export const FEEDBACK_REFRESH_INTERVAL_MS = 10_000;
export const FEEDBACK_TOTAL_BUDGET_MS = 8_000;
export const FEEDBACK_ASSEMBLE_BUDGET_MS = 1_200;
export const FEEDBACK_EVENTS_BUDGET_MS = 1_200;
export const FEEDBACK_REPORT_BUDGET_MS = 4_500;
export const FEEDBACK_VALIDATE_BUDGET_MS = 600;
export const FEEDBACK_PERSIST_FETCH_BUDGET_MS = 500;
export const HISTORY_PREFIX = "history/";
export const HISTORY_MAX_LIMIT = 50;
export const HISTORY_REVERSE_EPOCH_MAX = 9_999_999_999_999;

// ── Reliability & timeout constants ─────────────────────────────────
export const DASHSCOPE_TIMEOUT_CAP_MS = 15_000;
export const DEFAULT_ASR_TIMEOUT_MS = 45_000;
export const DRAIN_TIMEOUT_CAP_MS = 30_000;
export const WS_CLOSE_REASON_MAX_LEN = 120;
export const R2_LIST_LIMIT = 100;
/** GDPR data retention: full session data (results, history) retained for this many days.
 *  Audio chunks use AUDIO_RETENTION_HOURS (shorter). Configure R2 lifecycle rules to match. */
export const DEFAULT_DATA_RETENTION_DAYS = 30;
export const MAX_BACKOFF_MS = 60_000;
export const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Report sources considered "ready" for feedback delivery.
 * llm_enhanced       — legacy polish pipeline (inference /analysis/report)
 * llm_synthesized    — new synthesis pipeline (inference /analysis/synthesize)
 * llm_synthesized_truncated — synthesis succeeded but input was truncated
 */
export const ACCEPTED_REPORT_SOURCES: ReadonlySet<string> = new Set([
  "llm_enhanced",
  "llm_synthesized",
  "llm_synthesized_truncated"
]);

// ── Pure utility functions ──────────────────────────────────────────

/** Extract error message safely from unknown catch value. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Calculate total transcript duration from the last utterance's end_ms. */
export function calcTranscriptDurationMs(transcript: Array<{ end_ms: number }>): number {
  return transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;
}

export function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

export function badRequest(detail: string): Response {
  return jsonResponse({ detail }, 400);
}

export function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function safeSessionId(raw: string): string {
  const decoded = decodeURIComponent(raw);
  if (!decoded || decoded.length > 128) {
    throw new Error("session_id must be 1..128 chars");
  }
  return decoded;
}

export function safeObjectSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function parseStreamRole(raw: string | null | undefined, fallback: StreamRole = "mixed"): StreamRole {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (STREAM_ROLES.includes(normalized as StreamRole)) {
    return normalized as StreamRole;
  }
  throw new Error(`unsupported stream_role: ${raw}`);
}

export function resultObjectKey(sessionId: string): string {
  return `sessions/${safeObjectSegment(sessionId)}/result.json`;
}

export function resultObjectKeyV2(sessionId: string): string {
  return `sessions/${safeObjectSegment(sessionId)}/result_v2.json`;
}

export function historyObjectKey(sessionId: string, finalizedAtMs: number): string {
  const reverse = Math.max(0, HISTORY_REVERSE_EPOCH_MAX - Math.max(0, finalizedAtMs));
  const reversePart = String(reverse).padStart(13, "0");
  return `${HISTORY_PREFIX}${reversePart}_${safeObjectSegment(sessionId)}.json`;
}

export function chunkObjectKey(sessionId: string, streamRole: StreamRole, seq: number): string {
  const seqPart = String(seq).padStart(8, "0");
  if (streamRole === "mixed") {
    return `sessions/${safeObjectSegment(sessionId)}/chunks/${seqPart}.pcm`;
  }
  return `sessions/${safeObjectSegment(sessionId)}/chunks/${streamRole}/${seqPart}.pcm`;
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

export function parseTimeoutMs(raw: string | undefined): number {
  const timeout = Number(raw ?? "15000");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 15000;
  }
  return timeout;
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

export function getSessionLocale(state: SessionState | undefined, env?: Env): string {
  const fromConfig = (state?.config as Record<string, unknown>)?.locale as string | undefined;
  return fromConfig || env?.DEFAULT_LOCALE || 'zh-CN';
}

export function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute Levenshtein edit distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

export function toWebSocketHandshakeUrl(raw: string): string {
  if (raw.startsWith("wss://")) {
    return "https://" + raw.slice("wss://".length);
  }
  if (raw.startsWith("ws://")) {
    return "http://" + raw.slice("ws://".length);
  }
  return raw;
}

export function extractFirstString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractFirstString(item);
      if (text) return text;
    }
    return null;
  }

  const payload = value as Record<string, unknown>;
  const preferredKeys = ["text", "sentence", "transcript", "result", "asr_result"];
  for (const key of preferredKeys) {
    if (key in payload) {
      const text = extractFirstString(payload[key]);
      if (text) return text;
    }
  }
  for (const item of Object.values(payload)) {
    const text = extractFirstString(item);
    if (text) return text;
  }
  return null;
}

export function extractBooleanByKeys(value: unknown, keys: string[]): boolean | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractBooleanByKeys(item, keys);
      if (result !== null) return result;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    if (key in obj && typeof obj[key] === "boolean") {
      return obj[key] as boolean;
    }
  }
  for (const item of Object.values(obj)) {
    const result = extractBooleanByKeys(item, keys);
    if (result !== null) return result;
  }
  return null;
}

export function extractNumberByKeys(value: unknown, keys: string[]): number | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = extractNumberByKeys(item, keys);
      if (result !== null) return result;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;
  for (const key of keys) {
    const maybe = obj[key];
    if (typeof maybe === "number" && Number.isFinite(maybe)) {
      return maybe;
    }
  }
  for (const item of Object.values(obj)) {
    const result = extractNumberByKeys(item, keys);
    if (result !== null) return result;
  }
  return null;
}

export function extractNameFromText(text: string): string | null {
  const stopwords = new Set([
    "the",
    "and",
    "with",
    "from",
    "about",
    "which",
    "where",
    "when",
    "doing",
    "really",
    "excited",
    "levels",
    "going",
    "american",
    "school",
    "studying",
    "netherlands"
  ]);
  const patterns = [
    /\bmy name is\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\bi am\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\bi'm\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\b(?:usually\s+)?go(?:es)?\s+by\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\b(?:(?:you\s+)?can\s+)?call me\s+([A-Za-z][A-Za-z .'-]{0,60})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    const cleaned = match[1].trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
    const tokens = cleaned.split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || tokens.length > 3) continue;
    if (tokens.some((token) => !/^[A-Za-z][A-Za-z'-]{0,30}$/.test(token))) continue;
    if (tokens.some((token) => stopwords.has(token.toLowerCase()))) continue;
    if (cleaned.length >= 2 && cleaned.length <= 64) {
      return cleaned;
    }
  }
  return null;
}

export function parseRosterEntries(value: unknown): RosterEntry[] {
  if (!Array.isArray(value)) return [];
  const out: RosterEntry[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const name = valueAsString(item);
      if (!name) continue;
      out.push({ name });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = valueAsString(obj.name);
    if (!name) continue;
    const email = valueAsString(obj.email);
    const aliases = Array.isArray(obj.aliases)
      ? (obj.aliases as unknown[]).filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      : undefined;
    out.push({ name, email, aliases: aliases && aliases.length > 0 ? aliases : undefined });
  }
  return out;
}

// ── Text merge/stitch utilities ─────────────────────────────────────
export function normalizeTextForMerge(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .trim();
}

export function tokenizeForMerge(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function tokenOverlapSuffixPrefix(left: string[], right: string[], maxScan = 32): number {
  const max = Math.min(maxScan, left.length, right.length);
  for (let overlap = max; overlap >= 1; overlap -= 1) {
    let matched = true;
    for (let i = 0; i < overlap; i += 1) {
      if (left[left.length - overlap + i] !== right[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return overlap;
  }
  return 0;
}

export function computeTokenJaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function stitchTextByTokenOverlap(baseText: string, nextText: string, minOverlap = 3): string | null {
  const baseWords = baseText.trim().split(/\s+/).filter(Boolean);
  const nextWords = nextText.trim().split(/\s+/).filter(Boolean);
  if (baseWords.length === 0 || nextWords.length === 0) return null;

  const baseNorm = baseWords.map((item) => normalizeTextForMerge(item)).filter(Boolean);
  const nextNorm = nextWords.map((item) => normalizeTextForMerge(item)).filter(Boolean);
  const overlap = tokenOverlapSuffixPrefix(baseNorm, nextNorm);
  if (overlap < minOverlap) {
    return null;
  }

  const suffix = nextWords.slice(overlap).join(" ").trim();
  if (!suffix) return baseText.trim();
  return `${baseText.trim()} ${suffix}`.replace(/\s+/g, " ").trim();
}

export function mergeUtterances(utterances: UtteranceRaw[]): UtteranceMerged[] {
  const sorted = [...utterances].sort((a, b) => a.start_seq - b.start_seq || a.end_seq - b.end_seq);
  const merged: UtteranceMerged[] = [];

  for (const item of sorted) {
    const text = item.text.trim();
    if (!text) continue;

    const normalized = normalizeTextForMerge(text);
    const tokens = tokenizeForMerge(text);
    const last = merged[merged.length - 1];

    if (last) {
      const overlapsOrAdjacent = item.start_seq <= last.end_seq + 1;
      const lastNorm = normalizeTextForMerge(last.text);
      const lastTokens = tokenizeForMerge(last.text);
      const overlapTokens = tokenOverlapSuffixPrefix(lastTokens, tokens);
      const duplicateLike =
        normalized.length > 0 &&
        (normalized === lastNorm ||
          lastNorm.includes(normalized) ||
          normalized.includes(lastNorm) ||
          computeTokenJaccard(lastTokens, tokens) >= 0.9);

      if (overlapsOrAdjacent && duplicateLike) {
        if (normalized.length > lastNorm.length) {
          last.text = text;
        }
        last.end_seq = Math.max(last.end_seq, item.end_seq);
        last.end_ms = Math.max(last.end_ms, item.end_ms);
        last.duration_ms = last.end_ms - last.start_ms;
        last.source_utterance_ids.push(item.utterance_id);
        continue;
      }

      if (overlapsOrAdjacent && overlapTokens >= 3) {
        const stitched = stitchTextByTokenOverlap(last.text, text, 3);
        if (stitched) {
          last.text = stitched;
          last.end_seq = Math.max(last.end_seq, item.end_seq);
          last.end_ms = Math.max(last.end_ms, item.end_ms);
          last.duration_ms = last.end_ms - last.start_ms;
          last.source_utterance_ids.push(item.utterance_id);
          continue;
        }
      }
    }

    merged.push({
      merged_id: `${item.session_id}-${item.stream_role}-m-${String(item.end_seq).padStart(8, "0")}`,
      session_id: item.session_id,
      stream_role: item.stream_role,
      text,
      start_seq: item.start_seq,
      end_seq: item.end_seq,
      start_ms: item.start_ms,
      end_ms: item.end_ms,
      duration_ms: item.duration_ms,
      asr_model: item.asr_model,
      asr_provider: item.asr_provider,
      created_at: item.created_at,
      source_utterance_ids: [item.utterance_id]
    });
  }

  return merged;
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

export function parseChunkFrame(value: unknown): AudioChunkFrame {
  if (!value || typeof value !== "object") {
    throw new Error("frame payload must be an object");
  }

  const frame = value as Partial<AudioChunkFrame>;
  if (frame.type !== "chunk") {
    throw new Error("frame.type must be chunk");
  }
  if (!frame.meeting_id || typeof frame.meeting_id !== "string") {
    throw new Error("frame.meeting_id is required");
  }
  if (!Number.isInteger(frame.seq) || Number(frame.seq) <= 0) {
    throw new Error("frame.seq must be a positive integer");
  }
  if (!Number.isFinite(frame.timestamp_ms) || Number(frame.timestamp_ms) <= 0) {
    throw new Error("frame.timestamp_ms must be a positive number");
  }
  if (frame.sample_rate !== TARGET_SAMPLE_RATE) {
    throw new Error(`frame.sample_rate must be ${TARGET_SAMPLE_RATE}`);
  }
  if (frame.channels !== TARGET_CHANNELS) {
    throw new Error(`frame.channels must be ${TARGET_CHANNELS}`);
  }
  if (frame.format !== TARGET_FORMAT) {
    throw new Error(`frame.format must be ${TARGET_FORMAT}`);
  }
  if (!frame.content_b64 || typeof frame.content_b64 !== "string") {
    throw new Error("frame.content_b64 is required");
  }
  if (frame.stream_role !== undefined) {
    parseStreamRole(frame.stream_role, "mixed");
  }

  return frame as AudioChunkFrame;
}

export function parseCaptureStatusPayload(
  value: unknown
): { stream_role?: StreamRole; payload: Partial<CaptureState> } {
  if (!value || typeof value !== "object") {
    throw new Error("capture_status payload must be an object");
  }
  const message = value as Record<string, unknown>;
  if (message.type !== "capture_status") {
    throw new Error("capture_status.type must be capture_status");
  }

  const payloadRaw = message.payload;
  if (!payloadRaw || typeof payloadRaw !== "object") {
    throw new Error("capture_status.payload must be an object");
  }
  const payload = payloadRaw as Record<string, unknown>;
  const parsed: Partial<CaptureState> = {};

  const captureState = valueAsString(payload.capture_state);
  if (captureState) {
    if (!["idle", "running", "recovering", "failed"].includes(captureState)) {
      throw new Error("capture_status.capture_state must be idle|running|recovering|failed");
    }
    parsed.capture_state = captureState as CaptureState["capture_state"];
  }

  const recoverAttempts = Number(payload.recover_attempts);
  if (Number.isFinite(recoverAttempts) && recoverAttempts >= 0) {
    parsed.recover_attempts = Math.floor(recoverAttempts);
  }

  if (payload.last_recover_at === null) {
    parsed.last_recover_at = null;
  } else {
    const lastRecoverAt = valueAsString(payload.last_recover_at);
    if (lastRecoverAt) {
      parsed.last_recover_at = lastRecoverAt;
    }
  }

  if (payload.last_recover_error === null) {
    parsed.last_recover_error = null;
  } else {
    const lastRecoverError = valueAsString(payload.last_recover_error);
    if (lastRecoverError !== null) {
      parsed.last_recover_error = lastRecoverError;
    }
  }

  const echoSuppressed = Number(payload.echo_suppressed_chunks);
  if (Number.isFinite(echoSuppressed) && echoSuppressed >= 0) {
    parsed.echo_suppressed_chunks = Math.floor(echoSuppressed);
  }

  const echoRate = Number(payload.echo_suppression_recent_rate);
  if (Number.isFinite(echoRate)) {
    parsed.echo_suppression_recent_rate = Math.max(0, Math.min(1, echoRate));
  }

  const roleRaw = valueAsString(message.stream_role);
  const role = roleRaw ? parseStreamRole(roleRaw, "mixed") : undefined;
  return {
    stream_role: role,
    payload: parsed
  };
}

export function identitySourceFromBindingSource(
  value: string | null | undefined
): SpeakerEvent["identity_source"] {
  if (!value) return "inference_resolve";
  if (value === "enrollment_match") return "enrollment_match";
  if (value === "name_extract") return "name_extract";
  if (value === "manual_map") return "manual_map";
  return "inference_resolve";
}

export function buildIngestState(sessionId: string): IngestState {
  const now = new Date().toISOString();
  return {
    meeting_id: sessionId,
    last_seq: 0,
    received_chunks: 0,
    duplicate_chunks: 0,
    missing_chunks: 0,
    bytes_stored: 0,
    started_at: now,
    updated_at: now
  };
}

export function ingestStatusPayload(sessionId: string, streamRole: StreamRole, ingest: IngestState) {
  return {
    type: "status",
    session_id: sessionId,
    stream_role: streamRole,
    meeting_id: ingest.meeting_id,
    last_seq: ingest.last_seq,
    received_chunks: ingest.received_chunks,
    duplicate_chunks: ingest.duplicate_chunks,
    missing_chunks: ingest.missing_chunks,
    bytes_stored: ingest.bytes_stored,
    started_at: ingest.started_at,
    updated_at: ingest.updated_at
  };
}

export function valueAsString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function buildDefaultCaptureState(): CaptureState {
  return {
    capture_state: "idle",
    recover_attempts: 0,
    last_recover_at: null,
    last_recover_error: null,
    echo_suppressed_chunks: 0,
    echo_suppression_recent_rate: 0,
    updated_at: new Date().toISOString()
  };
}

export function buildDefaultEnrollmentState(): EnrollmentState {
  return {
    mode: "idle",
    started_at: null,
    stopped_at: null,
    participants: {},
    unassigned_clusters: {},
    updated_at: new Date().toISOString()
  };
}

export function defaultCaptureByStream(): Record<StreamRole, CaptureState> {
  return {
    mixed: buildDefaultCaptureState(),
    teacher: buildDefaultCaptureState(),
    students: buildDefaultCaptureState()
  };
}

export function sanitizeCaptureState(value: CaptureState | null | undefined): CaptureState {
  const merged = {
    ...buildDefaultCaptureState(),
    ...(value ?? {})
  };
  const normalizedState = String(merged.capture_state ?? "idle");
  merged.capture_state = ["idle", "running", "recovering", "failed"].includes(normalizedState)
    ? (normalizedState as CaptureState["capture_state"])
    : "idle";
  merged.recover_attempts = Number.isFinite(merged.recover_attempts) ? Number(merged.recover_attempts) : 0;
  merged.echo_suppressed_chunks = Number.isFinite(merged.echo_suppressed_chunks) ? Number(merged.echo_suppressed_chunks) : 0;
  merged.echo_suppression_recent_rate = Number.isFinite(merged.echo_suppression_recent_rate)
    ? Math.max(0, Math.min(1, Number(merged.echo_suppression_recent_rate)))
    : 0;
  merged.last_recover_at = merged.last_recover_at ?? null;
  merged.last_recover_error = merged.last_recover_error ?? null;
  merged.updated_at = new Date().toISOString();
  return merged;
}

export function normalizeSessionState(state: SessionState | null | undefined): SessionState {
  const merged = state ? { ...state } : structuredClone(DEFAULT_STATE);
  merged.clusters = Array.isArray(merged.clusters) ? merged.clusters : [];
  merged.bindings = merged.bindings && typeof merged.bindings === "object" ? merged.bindings : {};
  merged.config = merged.config && typeof merged.config === "object" ? merged.config : {};
  if (merged.config.diarization_backend !== "edge" && merged.config.diarization_backend !== "cloud") {
    merged.config.diarization_backend = "edge";
  }
  merged.participant_profiles = Array.isArray(merged.participant_profiles) ? merged.participant_profiles : [];
  merged.cluster_binding_meta =
    merged.cluster_binding_meta && typeof merged.cluster_binding_meta === "object" ? merged.cluster_binding_meta : {};
  merged.prebind_by_cluster =
    merged.prebind_by_cluster && typeof merged.prebind_by_cluster === "object" ? merged.prebind_by_cluster : {};
  const enrollment = merged.enrollment_state ?? buildDefaultEnrollmentState();
  merged.enrollment_state = {
    mode: ["idle", "collecting", "ready", "closed"].includes(String(enrollment.mode))
      ? enrollment.mode
      : "idle",
    started_at: enrollment.started_at ?? null,
    stopped_at: enrollment.stopped_at ?? null,
    participants: enrollment.participants && typeof enrollment.participants === "object" ? enrollment.participants : {},
    unassigned_clusters:
      enrollment.unassigned_clusters && typeof enrollment.unassigned_clusters === "object"
        ? enrollment.unassigned_clusters
        : {},
    updated_at: new Date().toISOString()
  };
  const capture = merged.capture_by_stream ?? defaultCaptureByStream();
  merged.capture_by_stream = {
    mixed: sanitizeCaptureState(capture.mixed),
    teacher: sanitizeCaptureState(capture.teacher),
    students: sanitizeCaptureState(capture.students)
  };
  return merged;
}

// ── Session Phase helpers ────────────────────────────────────────────
/**
 * Validate and execute a session phase transition.
 * Returns the new phase if the transition is valid, or the current phase if not.
 */
export function transitionSessionPhase(
  current: SessionPhase,
  target: SessionPhase
): { phase: SessionPhase; valid: boolean } {
  const allowed = SESSION_PHASE_TRANSITIONS[current];
  if (allowed && allowed.includes(target)) {
    return { phase: target, valid: true };
  }
  return { phase: current, valid: false };
}

export function emptyIngestByStream(sessionId: string): Record<StreamRole, IngestState> {
  return {
    mixed: buildIngestState(sessionId),
    teacher: buildIngestState(sessionId),
    students: buildIngestState(sessionId)
  };
}

export function emptyUtterancesRawByStream(): Record<StreamRole, UtteranceRaw[]> {
  return { mixed: [], teacher: [], students: [] };
}

export function emptyUtterancesMergedByStream(): Record<StreamRole, UtteranceMerged[]> {
  return { mixed: [], teacher: [], students: [] };
}
