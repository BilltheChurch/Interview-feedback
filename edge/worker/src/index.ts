import { DurableObject } from "cloudflare:workers";
import {
  attachEvidenceToMemos,
  buildEvidence,
  buildMemoFirstReport,
  buildMultiEvidence,
  buildReportExportMarkdown,
  buildReportExportText,
  buildResultV2,
  buildSynthesizePayload,
  collectEnrichedContext,
  computeSpeakerStats,
  computeUnknownRatio,
  enforceQualityGates,
  enrichEvidencePack,
  extractMemoNames,
  generateStatsObservations,
  addStageMetadata,
  memoAssistedBinding,
  backfillSupportingUtterances,
  validatePersonFeedbackEvidence
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { filterMemos, nextMemoId, parseMemoPayload } from "./memos";
import { emptySpeakerLogs, mergeSpeakerLogs, parseSpeakerLogsPayload } from "./speaker_logs";
import {
  InferenceFailoverClient,
  InferenceRequestError,
  type DependencyHealthSnapshot,
  type InferenceBackendTimelineItem,
  type InferenceEndpointKey
} from "./inference_client";
import { analyzeEventsLocally } from "./local_events_analyzer";
import { validateApiKey } from "./auth";
import {
  decodeBase64ToBytes,
  bytesToBase64,
  concatUint8Arrays,
  pcm16ToWavBytes,
  truncatePcm16WavToSeconds,
  tailPcm16BytesToWavForSeconds,
  buildDocxBytesFromText,
  encodeUtf8,
  TARGET_SAMPLE_RATE,
  TARGET_CHANNELS,
  ONE_SECOND_PCM_BYTES
} from "./audio-utils";
import {
  buildReconciledTranscript,
  resolveStudentBinding
} from "./reconcile";
import { EmbeddingCache } from "./embedding-cache";
import { globalCluster, mapClustersToRoster } from "./global-cluster";
import type { CachedEmbedding, GlobalClusterResult, CaptionEvent } from "./providers/types";
import { LocalWhisperASRProvider } from "./providers/asr-local-whisper";
import { ACSCaptionASRProvider } from "./providers/asr-acs-caption";
import { ACSCaptionDiarizationProvider } from "./providers/diarization-acs-caption";
import type { RosterParticipant } from "./global-cluster";
import type {
  CheckpointRequestPayload,
  CheckpointResult,
  FinalizeV2Status,
  MemoItem,
  MemoSpeakerBinding,
  MergeCheckpointsRequestPayload,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SpeakerStatItem,
  SpeakerLogs,
  SpeakerMapItem,
  SynthesizeRequestPayload,
  Tier2Status,
  CaptionSource
} from "./types_v2";

type StreamRole = "mixed" | "teacher" | "students";
const STREAM_ROLES: StreamRole[] = ["mixed", "teacher", "students"];

interface AudioPayload {
  content_b64: string;
  format: "wav" | "pcm_s16le" | "mp3" | "m4a" | "ogg" | "flac";
  sample_rate?: number;
  channels?: number;
}

interface RosterEntry {
  name: string;
  email?: string | null;
  aliases?: string[];
}

interface ResolveRequest {
  audio: AudioPayload;
  asr_text?: string | null;
  roster?: RosterEntry[];
}

interface ClusterState {
  cluster_id: string;
  centroid: number[];
  sample_count: number;
  bound_name?: string | null;
}

interface ParticipantProfile {
  name: string;
  email?: string | null;
  centroid: number[];
  sample_count: number;
  sample_seconds: number;
  status: "collecting" | "ready";
}

interface BindingMeta {
  participant_name: string;
  source: "enrollment_match" | "name_extract" | "manual_map";
  confidence: number;
  locked: boolean;
  updated_at: string;
}

interface EnrollmentParticipantProgress {
  name: string;
  sample_seconds: number;
  sample_count: number;
  status: "collecting" | "ready";
}

interface EnrollmentUnassignedProgress {
  sample_seconds: number;
  sample_count: number;
}

interface EnrollmentState {
  mode: "idle" | "collecting" | "ready" | "closed";
  started_at?: string | null;
  stopped_at?: string | null;
  participants: Record<string, EnrollmentParticipantProgress>;
  unassigned_clusters: Record<string, EnrollmentUnassignedProgress>;
  updated_at: string;
}

interface SessionState {
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

interface SessionConfigRequest {
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
}

interface CaptureState {
  capture_state: "idle" | "running" | "recovering" | "failed";
  recover_attempts?: number;
  last_recover_at?: string | null;
  last_recover_error?: string | null;
  echo_suppressed_chunks?: number;
  echo_suppression_recent_rate?: number;
  updated_at?: string;
}

interface ResolveEvidence {
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

interface ResolveResponse {
  session_id: string;
  cluster_id: string;
  speaker_name?: string | null;
  decision: "auto" | "confirm" | "unknown";
  evidence: ResolveEvidence;
  updated_state: SessionState;
}

interface SpeakerEvent {
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

interface EnrollmentStartRequest {
  participants?: Array<RosterEntry | string>;
  teams_participants?: Array<RosterEntry | string>;
  interviewer_name?: string;
  teams_interviewer_name?: string;
}

interface ClusterMapRequest {
  stream_role?: StreamRole;
  cluster_id: string;
  participant_name: string;
  lock?: boolean;
  mode?: "bind" | "prebind";
}

interface InferenceEnrollRequest {
  session_id: string;
  participant_name: string;
  audio: AudioPayload;
  state: SessionState;
}

interface InferenceEnrollResponse {
  session_id: string;
  participant_name: string;
  embedding_dim: number;
  sample_seconds: number;
  profile_updated: boolean;
  updated_state: SessionState;
}

interface FinalizeRequest {
  metadata?: Record<string, unknown>;
}

interface FeedbackRegenerateClaimRequest {
  person_key: string;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim_id?: string;
  text_hint?: string;
}

interface FeedbackClaimEvidenceRequest {
  person_key: string;
  dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
  claim_type: "strengths" | "risks" | "actions";
  claim_id?: string;
  evidence_refs: string[];
}

interface InferenceRegenerateClaimRequest {
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

interface InferenceRegenerateClaimResponse {
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

interface FeedbackExportRequest {
  format?: "plain_text" | "markdown" | "docx";
  file_name?: string;
}

interface IngestState {
  meeting_id: string;
  last_seq: number;
  received_chunks: number;
  duplicate_chunks: number;
  missing_chunks: number;
  bytes_stored: number;
  started_at: string;
  updated_at: string;
}

interface UtteranceRaw {
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

interface UtteranceMerged {
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

interface FeedbackTimings {
  assemble_ms: number;
  events_ms: number;
  report_ms: number;
  validation_ms: number;
  persist_ms: number;
  total_ms: number;
}

interface FeedbackCache {
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

interface QualityMetrics {
  unknown_ratio: number;
  students_utterance_count: number;
  students_unknown_count: number;
  echo_suppressed_chunks: number;
  echo_suppression_recent_rate: number;
  echo_leak_rate: number;
  suppression_false_positive_rate: number;
}

interface HistoryIndexItem {
  session_id: string;
  finalized_at: string;
  tentative: boolean;
  unresolved_cluster_count: number;
  ready: boolean;
  needs_evidence_count: number;
  report_source: string;
}

interface AsrState {
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

interface AsrRunResult {
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

interface AsrReplayCursor {
  last_ingested_seq: number;
  last_sent_seq: number;
  last_emitted_seq: number;
  updated_at: string;
}

interface AsrQueueChunk {
  seq: number;
  timestampMs: number;
  receivedAtMs: number;
  bytes: Uint8Array;
}

interface AsrRealtimeRuntime {
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

interface AudioChunkFrame {
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

interface Env {
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
  RESULT_BUCKET: R2Bucket;
  MEETING_SESSION: DurableObjectNamespace<MeetingSessionDO>;
}

const DEFAULT_STATE: SessionState = {
  clusters: [],
  bindings: {},
  capture_by_stream: defaultCaptureByStream(),
  config: {},
  participant_profiles: [],
  cluster_binding_meta: {},
  prebind_by_cluster: {},
  enrollment_state: buildDefaultEnrollmentState()
};

function emptyReportQualityMeta(nowIso: string): ReportQualityMeta {
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

function emptyFeedbackCache(sessionId: string, nowIso: string): FeedbackCache {
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

const SESSION_ROUTE_REGEX =
  /^\/v1\/sessions\/([^/]+)\/(resolve|state|finalize|utterances|asr-run|asr-reset|config|events|cluster-map|unresolved-clusters|memos|speaker-logs|result|feedback-ready|feedback-open|feedback-regenerate-claim|feedback-claim-evidence|export)$/;
const SESSION_ENROLL_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/enrollment\/(start|stop|state|profiles)$/;
const SESSION_FINALIZE_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/finalize\/status$/;
const SESSION_TIER2_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/tier2-status$/;
const SESSION_HISTORY_ROUTE_REGEX = /^\/v1\/sessions\/history$/;
const WS_INGEST_ROUTE_REGEX = /^\/v1\/audio\/ws\/([^/]+)$/;
const WS_INGEST_ROLE_ROUTE_REGEX = /^\/v1\/audio\/ws\/([^/]+)\/([^/]+)$/;

const STORAGE_KEY_STATE = "state";
const STORAGE_KEY_EVENTS = "events";
const STORAGE_KEY_UPDATED_AT = "updated_at";
const STORAGE_KEY_FINALIZED_AT = "finalized_at";
const STORAGE_KEY_RESULT_KEY = "result_key";
const STORAGE_KEY_RESULT_KEY_V2 = "result_key_v2";
const STORAGE_KEY_FINALIZE_V2_STATUS = "finalize_v2_status";
const STORAGE_KEY_FINALIZE_LOCK = "finalize_lock";
const STORAGE_KEY_TIER2_STATUS = "tier2_status";
const STORAGE_KEY_TIER2_ALARM_TAG = "tier2_alarm_tag";
const STORAGE_KEY_MEMOS = "memos";
const STORAGE_KEY_SPEAKER_LOGS = "speaker_logs";
const STORAGE_KEY_ASR_CURSOR_BY_STREAM = "asr_cursor_by_stream";
const STORAGE_KEY_FEEDBACK_CACHE = "feedback_cache";
const STORAGE_KEY_DEPENDENCY_HEALTH = "dependency_health";

const STORAGE_KEY_INGEST_STATE = "ingest_state";
const STORAGE_KEY_ASR_STATE = "asr_state";
const STORAGE_KEY_UTTERANCES_RAW = "utterances_raw";

const STORAGE_KEY_INGEST_BY_STREAM = "ingest_by_stream";
const STORAGE_KEY_ASR_BY_STREAM = "asr_by_stream";
const STORAGE_KEY_UTTERANCES_RAW_BY_STREAM = "utterances_raw_by_stream";
const STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM = "utterances_merged_by_stream";
const STORAGE_KEY_CHECKPOINTS = "checkpoints";
const STORAGE_KEY_LAST_CHECKPOINT_AT = "last_checkpoint_at";

const TARGET_FORMAT = "pcm_s16le";
const INFERENCE_MAX_AUDIO_SECONDS = 30;
const DASHSCOPE_DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const DASHSCOPE_DEFAULT_MODEL = "fun-asr-realtime-2025-11-07";
const FEEDBACK_REFRESH_INTERVAL_MS = 10_000;
const FEEDBACK_TOTAL_BUDGET_MS = 8_000;
const FEEDBACK_ASSEMBLE_BUDGET_MS = 1_200;
const FEEDBACK_EVENTS_BUDGET_MS = 1_200;
const FEEDBACK_REPORT_BUDGET_MS = 4_500;
const FEEDBACK_VALIDATE_BUDGET_MS = 600;
const FEEDBACK_PERSIST_FETCH_BUDGET_MS = 500;
const HISTORY_PREFIX = "history/";
const HISTORY_MAX_LIMIT = 50;
const HISTORY_REVERSE_EPOCH_MAX = 9_999_999_999_999;

/**
 * Report sources considered "ready" for feedback delivery.
 * llm_enhanced       — legacy polish pipeline (inference /analysis/report)
 * llm_synthesized    — new synthesis pipeline (inference /analysis/synthesize)
 * llm_synthesized_truncated — synthesis succeeded but input was truncated
 */
const ACCEPTED_REPORT_SOURCES: ReadonlySet<string> = new Set([
  "llm_enhanced",
  "llm_synthesized",
  "llm_synthesized_truncated"
]);

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function badRequest(detail: string): Response {
  return jsonResponse({ detail }, 400);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function safeSessionId(raw: string): string {
  const decoded = decodeURIComponent(raw);
  if (!decoded || decoded.length > 128) {
    throw new Error("session_id must be 1..128 chars");
  }
  return decoded;
}

function safeObjectSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseStreamRole(raw: string | null | undefined, fallback: StreamRole = "mixed"): StreamRole {
  const normalized = String(raw ?? "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (STREAM_ROLES.includes(normalized as StreamRole)) {
    return normalized as StreamRole;
  }
  throw new Error(`unsupported stream_role: ${raw}`);
}

function resultObjectKey(sessionId: string): string {
  return `sessions/${safeObjectSegment(sessionId)}/result.json`;
}

function resultObjectKeyV2(sessionId: string): string {
  return `sessions/${safeObjectSegment(sessionId)}/result_v2.json`;
}

function historyObjectKey(sessionId: string, finalizedAtMs: number): string {
  const reverse = Math.max(0, HISTORY_REVERSE_EPOCH_MAX - Math.max(0, finalizedAtMs));
  const reversePart = String(reverse).padStart(13, "0");
  return `${HISTORY_PREFIX}${reversePart}_${safeObjectSegment(sessionId)}.json`;
}

function chunkObjectKey(sessionId: string, streamRole: StreamRole, seq: number): string {
  const seqPart = String(seq).padStart(8, "0");
  if (streamRole === "mixed") {
    return `sessions/${safeObjectSegment(sessionId)}/chunks/${seqPart}.pcm`;
  }
  return `sessions/${safeObjectSegment(sessionId)}/chunks/${streamRole}/${seqPart}.pcm`;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function parseTimeoutMs(raw: string | undefined): number {
  const timeout = Number(raw ?? "15000");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 15000;
  }
  return timeout;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function getSessionLocale(state: SessionState | undefined, env?: Env): string {
  const fromConfig = (state?.config as Record<string, unknown>)?.locale as string | undefined;
  return fromConfig || env?.DEFAULT_LOCALE || 'zh-CN';
}

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute Levenshtein edit distance between two strings. */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Use a single-row DP approach for space efficiency.
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

function toWebSocketHandshakeUrl(raw: string): string {
  if (raw.startsWith("wss://")) {
    return "https://" + raw.slice("wss://".length);
  }
  if (raw.startsWith("ws://")) {
    return "http://" + raw.slice("ws://".length);
  }
  return raw;
}

function extractFirstString(value: unknown): string | null {
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

function extractBooleanByKeys(value: unknown, keys: string[]): boolean | null {
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

function extractNumberByKeys(value: unknown, keys: string[]): number | null {
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

function extractNameFromText(text: string): string | null {
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

function parseRosterEntries(value: unknown): RosterEntry[] {
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

function normalizeTextForMerge(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .trim();
}

function tokenizeForMerge(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenOverlapSuffixPrefix(left: string[], right: string[], maxScan = 32): number {
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

function computeTokenJaccard(a: string[], b: string[]): number {
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

function stitchTextByTokenOverlap(baseText: string, nextText: string, minOverlap = 3): string | null {
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

function mergeUtterances(utterances: UtteranceRaw[]): UtteranceMerged[] {
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

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)));
  return sorted[idx];
}

function parseChunkFrame(value: unknown): AudioChunkFrame {
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

function parseCaptureStatusPayload(
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

function identitySourceFromBindingSource(
  value: string | null | undefined
): SpeakerEvent["identity_source"] {
  if (!value) return "inference_resolve";
  if (value === "enrollment_match") return "enrollment_match";
  if (value === "name_extract") return "name_extract";
  if (value === "manual_map") return "manual_map";
  return "inference_resolve";
}

function buildIngestState(sessionId: string): IngestState {
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

function ingestStatusPayload(sessionId: string, streamRole: StreamRole, ingest: IngestState) {
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

function valueAsString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildDefaultCaptureState(): CaptureState {
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

function buildDefaultEnrollmentState(): EnrollmentState {
  return {
    mode: "idle",
    started_at: null,
    stopped_at: null,
    participants: {},
    unassigned_clusters: {},
    updated_at: new Date().toISOString()
  };
}

function defaultCaptureByStream(): Record<StreamRole, CaptureState> {
  return {
    mixed: buildDefaultCaptureState(),
    teacher: buildDefaultCaptureState(),
    students: buildDefaultCaptureState()
  };
}

function sanitizeCaptureState(value: CaptureState | null | undefined): CaptureState {
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

function normalizeSessionState(state: SessionState | null | undefined): SessionState {
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

async function proxyToDO(request: Request, env: Env, sessionId: string, action: string): Promise<Response> {
  const id = env.MEETING_SESSION.idFromName(sessionId);
  const stub = env.MEETING_SESSION.get(id);

  const headers = new Headers();
  const idemKey = request.headers.get("x-idempotency-key");
  if (idemKey) {
    headers.set("x-idempotency-key", idemKey);
  }
  headers.set("x-session-id", sessionId);

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
    headers.set("content-type", "application/json");
  }

  const query = new URL(request.url).search;
  return stub.fetch("https://do.internal/" + action + query, {
    method: request.method,
    headers,
    body
  });
}

async function proxyWebSocketToDO(
  request: Request,
  env: Env,
  sessionId: string,
  streamRole: StreamRole
): Promise<Response> {
  const id = env.MEETING_SESSION.idFromName(sessionId);
  const stub = env.MEETING_SESSION.get(id);

  const headers = new Headers(request.headers);
  headers.set("x-session-id", sessionId);
  headers.set("x-stream-role", streamRole);

  return stub.fetch("https://do.internal/ingest-ws", {
    method: "GET",
    headers
  });
}

function emptyIngestByStream(sessionId: string): Record<StreamRole, IngestState> {
  return {
    mixed: buildIngestState(sessionId),
    teacher: buildIngestState(sessionId),
    students: buildIngestState(sessionId)
  };
}

function emptyUtterancesRawByStream(): Record<StreamRole, UtteranceRaw[]> {
  return { mixed: [], teacher: [], students: [] };
}

function emptyUtterancesMergedByStream(): Record<StreamRole, UtteranceMerged[]> {
  return { mixed: [], teacher: [], students: [] };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && request.method === "GET") {
      const asrProvider = (env.ASR_PROVIDER ?? "funASR").toLowerCase();
      const asrEnabled = parseBool(env.ASR_ENABLED, true) && (asrProvider === "local-whisper" || Boolean((env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim()));
      const asrRealtimeEnabled = parseBool(env.ASR_REALTIME_ENABLED, true);
      return jsonResponse({
        status: "ok",
        app: "interview-feedback-gateway",
        durable_object: "MEETING_SESSION",
        r2_bucket: "RESULT_BUCKET",
        asr_enabled: asrEnabled,
        asr_realtime_enabled: asrRealtimeEnabled,
        asr_mode: asrRealtimeEnabled ? "realtime" : "windowed",
        asr_model: env.ASR_MODEL ?? DASHSCOPE_DEFAULT_MODEL,
        asr_window_seconds: parsePositiveInt(env.ASR_WINDOW_SECONDS, 10),
        asr_hop_seconds: parsePositiveInt(env.ASR_HOP_SECONDS, 3),
        inference_failover_enabled: parseBool(env.INFERENCE_FAILOVER_ENABLED, true),
        inference_retry_max: parsePositiveInt(env.INFERENCE_RETRY_MAX, 2),
        inference_circuit_open_ms: parsePositiveInt(env.INFERENCE_CIRCUIT_OPEN_MS, 15000),
        stream_roles: STREAM_ROLES
      });
    }

    // ── Auth gate (skipped for /health, skipped when WORKER_API_KEY is empty) ──
    const authError = validateApiKey(request, env as unknown as Record<string, unknown>);
    if (authError) return authError;

    const wsRoleMatch = path.match(WS_INGEST_ROLE_ROUTE_REGEX);
    if (wsRoleMatch) {
      const [, rawSessionId, rawRole] = wsRoleMatch;
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (!isWebSocketRequest(request)) {
        return jsonResponse({ detail: "websocket upgrade required" }, 426);
      }

      let sessionId: string;
      let streamRole: StreamRole;
      try {
        sessionId = safeSessionId(rawSessionId);
        streamRole = parseStreamRole(rawRole, "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }

      return proxyWebSocketToDO(request, env, sessionId, streamRole);
    }

    const wsMatch = path.match(WS_INGEST_ROUTE_REGEX);
    if (wsMatch) {
      const [, rawSessionId] = wsMatch;
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (!isWebSocketRequest(request)) {
        return jsonResponse({ detail: "websocket upgrade required" }, 426);
      }

      let sessionId: string;
      try {
        sessionId = safeSessionId(rawSessionId);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      return proxyWebSocketToDO(request, env, sessionId, "mixed");
    }

    const enrollMatch = path.match(SESSION_ENROLL_ROUTE_REGEX);
    if (enrollMatch) {
      const [, rawSessionId, enrollAction] = enrollMatch;
      let sessionId: string;
      try {
        sessionId = safeSessionId(rawSessionId);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const action = `enrollment-${enrollAction}`;
      if (action === "enrollment-start" && request.method !== "POST") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (action === "enrollment-stop" && request.method !== "POST") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (action === "enrollment-state" && request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (action === "enrollment-profiles" && request.method !== "POST") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      return proxyToDO(request, env, sessionId, action);
    }

    const finalizeStatusMatch = path.match(SESSION_FINALIZE_STATUS_ROUTE_REGEX);
    if (finalizeStatusMatch) {
      const [, rawSessionId] = finalizeStatusMatch;
      let sessionId: string;
      try {
        sessionId = safeSessionId(rawSessionId);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      return proxyToDO(request, env, sessionId, "finalize-status");
    }

    const tier2StatusMatch = path.match(SESSION_TIER2_STATUS_ROUTE_REGEX);
    if (tier2StatusMatch) {
      const [, rawSessionId] = tier2StatusMatch;
      let sessionId: string;
      try {
        sessionId = safeSessionId(rawSessionId);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      return proxyToDO(request, env, sessionId, "tier2-status");
    }

    if (SESSION_HISTORY_ROUTE_REGEX.test(path)) {
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      const limitRaw = Number(url.searchParams.get("limit") ?? "20");
      const cursorRaw = String(url.searchParams.get("cursor") ?? "").trim();
      const limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : 20));
      const listing = await env.RESULT_BUCKET.list({
        prefix: HISTORY_PREFIX,
        cursor: cursorRaw || undefined,
        limit
      });
      const items: HistoryIndexItem[] = [];
      for (const obj of listing.objects) {
        const object = await env.RESULT_BUCKET.get(obj.key);
        if (!object) continue;
        try {
          const parsed = JSON.parse(await object.text()) as HistoryIndexItem;
          if (!parsed || typeof parsed !== "object") continue;
          items.push(parsed);
        } catch {
          continue;
        }
      }
      return jsonResponse({
        items,
        limit,
        cursor: listing.truncated ? listing.cursor ?? null : null,
        has_more: listing.truncated
      });
    }

    const match = path.match(SESSION_ROUTE_REGEX);
    if (!match) {
      return jsonResponse({ detail: "route not found" }, 404);
    }

    const [, rawSessionId, action] = match;

    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      return badRequest((error as Error).message);
    }

    if (action === "resolve" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "state" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "finalize" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "utterances" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "asr-run" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "asr-reset" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "config" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "events" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "cluster-map" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "unresolved-clusters" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "memos" && !["GET", "POST"].includes(request.method)) {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "speaker-logs" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "result" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "feedback-ready" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "feedback-open" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "feedback-regenerate-claim" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "feedback-claim-evidence" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "export" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }

    return proxyToDO(request, env, sessionId, action);
  }
};

export class MeetingSessionDO extends DurableObject<Env> {
  private mutationQueue: Promise<void> = Promise.resolve();
  private asrProcessingByStream: Record<StreamRole, boolean> = {
    mixed: false,
    teacher: false,
    students: false
  };
  private asrRealtimeByStream: Record<StreamRole, AsrRealtimeRuntime>;
  private inferenceClient: InferenceFailoverClient;
  private localWhisperProvider: LocalWhisperASRProvider | null = null;
  /** Embedding cache for global speaker clustering at finalization. */
  readonly embeddingCache: EmbeddingCache = new EmbeddingCache();
  /** Buffer for ACS Teams caption events. */
  private captionBuffer: CaptionEvent[] = [];
  /** Caption data source for this session. */
  private captionSource: CaptionSource = 'none';
  /** Session start time in epoch ms, set on first "hello". 0 = not yet initialized.
   *  NOTE: In-memory only — does not survive DO eviction. Acceptable for active sessions. */
  private sessionStartMs: number = 0;

  /** Get the caption buffer for finalization. */
  getCaptionBuffer(): CaptionEvent[] {
    return this.captionBuffer;
  }

  /** Get the current caption source mode. */
  getCaptionSource(): CaptionSource {
    return this.captionSource;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.asrRealtimeByStream = {
      mixed: this.buildRealtimeRuntime("mixed"),
      teacher: this.buildRealtimeRuntime("teacher"),
      students: this.buildRealtimeRuntime("students")
    };
    const primaryBaseUrl = normalizeBaseUrl((env.INFERENCE_BASE_URL_PRIMARY ?? env.INFERENCE_BASE_URL ?? "").trim());
    if (!primaryBaseUrl) {
      throw new Error("INFERENCE_BASE_URL or INFERENCE_BASE_URL_PRIMARY must be configured");
    }
    const secondaryRaw = normalizeBaseUrl((env.INFERENCE_BASE_URL_SECONDARY ?? "").trim());
    this.inferenceClient = new InferenceFailoverClient({
      primaryBaseUrl,
      secondaryBaseUrl: secondaryRaw || null,
      failoverEnabled: parseBool(env.INFERENCE_FAILOVER_ENABLED, true),
      apiKey: (env.INFERENCE_API_KEY ?? "").trim() || undefined,
      timeoutMs: parseTimeoutMs(env.INFERENCE_TIMEOUT_MS),
      retryMax: Math.max(0, Math.min(5, parsePositiveInt(env.INFERENCE_RETRY_MAX, 2))),
      retryBackoffMs: Math.max(50, parsePositiveInt(env.INFERENCE_RETRY_BACKOFF_MS, 180)),
      circuitOpenMs: Math.max(1_000, parsePositiveInt(env.INFERENCE_CIRCUIT_OPEN_MS, 15_000)),
      now: () => this.currentIsoTs()
    });
  }

  async alarm(): Promise<void> {
    await this.enqueueMutation(async () => {
      // Check if this alarm is for Tier 2 background processing
      const tier2Tag = await this.ctx.storage.get<string>(STORAGE_KEY_TIER2_ALARM_TAG);
      if (tier2Tag) {
        await this.ctx.storage.delete(STORAGE_KEY_TIER2_ALARM_TAG);
        const tier2Status = await this.loadTier2Status();
        if (tier2Status.status === "pending") {
          const sessionId = await this.resolveSessionId();
          await this.runTier2Job(sessionId);
          return; // Don't run other alarm tasks after tier2
        }
      }
      await this.failStuckFinalizeIfNeeded("alarm");
      await this.cleanupExpiredAudioChunks();
    });
  }

  private async resolveSessionId(): Promise<string> {
    // Derive session ID from the stored result key (set during Tier 1 finalization)
    const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (resultKey) {
      const match = resultKey.match(/sessions\/([^/]+)\//);
      if (match) return match[1];
    }
    return "unknown-session";
  }

  private async cleanupExpiredAudioChunks(): Promise<void> {
    const finalizedAt = await this.ctx.storage.get<string>(STORAGE_KEY_FINALIZED_AT);
    if (!finalizedAt) return;

    const age = Date.now() - new Date(finalizedAt).getTime();
    const retentionMs = (Number(this.env.AUDIO_RETENTION_HOURS) || 72) * 3600 * 1000;
    if (age <= retentionMs) return;

    // Derive the session R2 prefix from the stored result key
    const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (!resultKey) return;

    // resultKey is "sessions/{sessionSegment}/result_v2.json"
    const sessionPrefix = resultKey.replace(/\/result_v2\.json$/, "");
    const chunksPrefix = `${sessionPrefix}/chunks/`;

    let cursor: string | undefined;
    let deletedCount = 0;
    do {
      const listing = await this.env.RESULT_BUCKET.list({
        prefix: chunksPrefix,
        cursor,
        limit: 100
      });
      if (listing.objects.length > 0) {
        await Promise.all(
          listing.objects.map((obj) => this.env.RESULT_BUCKET.delete(obj.key))
        );
        deletedCount += listing.objects.length;
      }
      cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
    } while (cursor);

    if (deletedCount > 0) {
      console.log(`[cleanup] deleted ${deletedCount} expired audio chunks from ${chunksPrefix}`);
    }
  }

  private asrRealtimeEnabled(): boolean {
    return parseBool(this.env.ASR_REALTIME_ENABLED, true);
  }

  private async enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private asrDebugEnabled(): boolean {
    return parseBool(this.env.ASR_DEBUG_LOG_EVENTS, false);
  }

  private resolveAudioWindowSeconds(): number {
    const configured = parsePositiveInt(this.env.INFERENCE_RESOLVE_AUDIO_WINDOW_SECONDS, 6);
    return Math.max(1, Math.min(INFERENCE_MAX_AUDIO_SECONDS, configured));
  }

  private currentIsoTs(): string {
    return new Date().toISOString();
  }

  private memosEnabled(): boolean {
    return parseBool(this.env.MEMOS_ENABLED, true);
  }

  private finalizeV2Enabled(): boolean {
    return parseBool(this.env.FINALIZE_V2_ENABLED, false);
  }

  private finalizeTimeoutMs(): number {
    return parseTimeoutMs(this.env.FINALIZE_TIMEOUT_MS ?? "180000");
  }

  private finalizeWatchdogMs(): number {
    const configured = Number(this.env.FINALIZE_WATCHDOG_MS ?? "");
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return Math.max(this.finalizeTimeoutMs() + 120_000, 240_000);
  }

  private diarizationBackendDefault(): "cloud" | "edge" {
    const val = this.env.DIARIZATION_BACKEND_DEFAULT;
    return val === "edge" || val === "local" ? "edge" : "cloud";
  }

  private scoreNumber(value: number | null | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return -1;
    }
    return value;
  }

  private participantProgressFromProfiles(state: SessionState): Record<string, EnrollmentParticipantProgress> {
    const out: Record<string, EnrollmentParticipantProgress> = {};
    for (const profile of state.participant_profiles ?? []) {
      const key = profile.name.trim().toLowerCase();
      if (!key) continue;
      out[key] = {
        name: profile.name,
        sample_seconds: Number.isFinite(profile.sample_seconds) ? Number(profile.sample_seconds) : 0,
        sample_count: Number.isFinite(profile.sample_count) ? Number(profile.sample_count) : 0,
        status: profile.status === "ready" ? "ready" : "collecting"
      };
    }
    return out;
  }

  private refreshEnrollmentMode(state: SessionState): void {
    const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
    const participants = enrollment.participants ?? {};
    const keys = Object.keys(participants);
    const allReady = keys.length > 0 && keys.every((key) => participants[key].status === "ready");
    if (enrollment.mode === "collecting" && allReady) {
      enrollment.mode = "ready";
    }
    enrollment.updated_at = this.currentIsoTs();
    state.enrollment_state = enrollment;
  }

  private rosterNameByCandidate(state: SessionState, candidate: string | null): string | null {
    if (!candidate) return null;
    const normalized = candidate.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (!normalized) return null;
    const roster = state.roster ?? [];
    let fuzzySubstring: string | null = null;
    let fuzzyEdit: string | null = null;
    let bestEditDist = Infinity;
    for (const item of roster) {
      const rosterNorm = item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!rosterNorm) continue;
      // 1. Exact match — return immediately.
      if (rosterNorm === normalized) {
        return item.name;
      }
      // 2. Substring match (4+ chars).
      if (normalized.length >= 4 && (normalized.includes(rosterNorm) || rosterNorm.includes(normalized))) {
        fuzzySubstring = item.name;
      }
      // 3. Edit-distance match: both names >= 5 chars and distance <= 2.
      if (normalized.length >= 5 && rosterNorm.length >= 5) {
        const dist = levenshteinDistance(normalized, rosterNorm);
        if (dist <= 2 && dist < bestEditDist) {
          bestEditDist = dist;
          fuzzyEdit = item.name;
        }
      }
    }
    // Prefer substring match over edit-distance match.
    return fuzzySubstring ?? fuzzyEdit ?? null;
  }

  private inferParticipantFromText(state: SessionState, asrText: string): string | null {
    const extracted = extractNameFromText(asrText);
    return this.rosterNameByCandidate(state, extracted);
  }

  private updateUnassignedEnrollmentByCluster(
    state: SessionState,
    clusterId: string | null | undefined,
    durationSeconds: number
  ): void {
    if (!clusterId || durationSeconds <= 0) return;
    const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
    const current = enrollment.unassigned_clusters[clusterId] ?? { sample_seconds: 0, sample_count: 0 };
    current.sample_seconds += durationSeconds;
    current.sample_count += 1;
    enrollment.unassigned_clusters[clusterId] = current;
    enrollment.updated_at = this.currentIsoTs();
    state.enrollment_state = enrollment;
  }

  private async callInferenceWithFailover<T>(params: {
    endpoint: InferenceEndpointKey;
    path: string;
    body: unknown;
    timeoutMs?: number;
  }): Promise<{
    data: T;
    backend: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    try {
      const response = await this.inferenceClient.callJson<T>({
        endpoint: params.endpoint,
        path: params.path,
        body: params.body,
        timeoutMs: params.timeoutMs
      });
      await this.storeDependencyHealth(response.health);
      return response;
    } catch (error) {
      if (error instanceof InferenceRequestError) {
        await this.storeDependencyHealth(error.health);
      } else {
        await this.storeDependencyHealth(this.inferenceClient.snapshot());
      }
      throw error;
    }
  }

  private async callInferenceEnroll(
    sessionId: string,
    participantName: string,
    audio: AudioPayload,
    state: SessionState
  ): Promise<{
    payload: InferenceEnrollResponse;
    backend: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const enrollPath = this.env.INFERENCE_ENROLL_PATH ?? "/speaker/enroll";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS);
    const response = await this.callInferenceWithFailover<InferenceEnrollResponse>({
      endpoint: "enroll",
      path: enrollPath,
      timeoutMs,
      body: {
        session_id: sessionId,
        participant_name: participantName,
        audio,
        state
      } satisfies InferenceEnrollRequest
    });
    return {
      payload: response.data,
      backend: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  /**
   * Extract speaker embeddings for edge diarization turns and populate the cache.
   *
   * For each speaker turn with sufficient duration (>500ms), loads the corresponding
   * PCM audio from R2, calls the inference service's /sv/extract_embedding endpoint,
   * and stores the result in the EmbeddingCache for global clustering at finalization.
   *
   * Skips segments already in the cache (idempotent). Non-critical: failures are
   * logged but do not block the pipeline.
   */
  async extractEmbeddingsForTurns(
    sessionId: string,
    speakerLogs: SpeakerLogs,
    streamRole: "students" | "teacher" = "students"
  ): Promise<{ extracted: number; skipped: number; failed: number }> {
    const turns = speakerLogs.turns.filter(
      (t) => t.stream_role === streamRole
    );
    let extracted = 0;
    let skipped = 0;
    let failed = 0;

    for (const turn of turns) {
      const durationMs = turn.end_ms - turn.start_ms;
      if (durationMs < 500) { skipped++; continue; }

      const segmentId = `${streamRole}_${turn.turn_id}`;
      if (this.embeddingCache.getEmbedding(segmentId)) { skipped++; continue; }

      try {
        // Determine which R2 chunks cover this turn's time range
        const startSeq = Math.max(0, Math.floor(turn.start_ms / 1000));
        const endSeq = Math.ceil(turn.end_ms / 1000);
        const chunks = await this.loadChunkRange(sessionId, streamRole, startSeq, endSeq);
        if (chunks.length === 0) { skipped++; continue; }

        const pcmData = concatUint8Arrays(chunks);
        const wavBytes = pcm16ToWavBytes(pcmData, TARGET_SAMPLE_RATE, TARGET_CHANNELS);
        const audioPayload: AudioPayload = {
          content_b64: bytesToBase64(wavBytes),
          format: "wav",
          sample_rate: TARGET_SAMPLE_RATE,
          channels: TARGET_CHANNELS
        };

        const response = await this.callInferenceWithFailover<{ embedding: number[] }>({
          endpoint: "sv_extract_embedding",
          path: this.env.INFERENCE_EXTRACT_EMBEDDING_PATH ?? "/sv/extract_embedding",
          body: {
            session_id: sessionId,
            audio: audioPayload
          },
          timeoutMs: 10_000
        });

        const embedding = new Float32Array(response.data.embedding);
        const added = this.embeddingCache.addEmbedding({
          segment_id: segmentId,
          embedding,
          start_ms: turn.start_ms,
          end_ms: turn.end_ms,
          window_cluster_id: turn.cluster_id,
          stream_role: streamRole
        });
        if (added) { extracted++; } else { skipped++; }
      } catch {
        failed++;
      }
    }

    return { extracted, skipped, failed };
  }

  private buildRealtimeRuntime(streamRole: StreamRole): AsrRealtimeRuntime {
    return {
      ws: null,
      connectPromise: null,
      flushPromise: null,
      readyPromise: null,
      readyResolve: null,
      readyReject: null,
      streamRole,
      connected: false,
      connecting: false,
      running: false,
      taskId: null,
      sendQueue: [],
      reconnectBackoffMs: 500,
      lastSentSeq: 0,
      startedAt: 0,
      currentStartSeq: null,
      currentStartTsMs: null,
      sentChunkTsBySeq: new Map(),
      lastEmitAt: null,
      lastFinalTextNorm: "",
      drainGeneration: 0
    };
  }

  private sendWsJson(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload));
  }

  private sendWsError(socket: WebSocket, detail: string): void {
    this.sendWsJson(socket, {
      type: "error",
      detail
    });
  }

  private asrEnabled(): boolean {
    if (!parseBool(this.env.ASR_ENABLED, true)) return false;
    // local-whisper uses the inference service, not DashScope — no API key needed
    if (this.getAsrProvider() === "local-whisper") return true;
    return Boolean((this.env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim());
  }

  private buildDefaultAsrState(): AsrState {
    return {
      enabled: this.asrEnabled(),
      provider: "dashscope",
      model: this.env.ASR_MODEL ?? DASHSCOPE_DEFAULT_MODEL,
      mode: this.asrRealtimeEnabled() ? "realtime" : "windowed",
      asr_ws_state: "disconnected",
      backlog_chunks: 0,
      ingest_lag_seconds: 0,
      last_emit_at: null,
      ingest_to_utterance_p50_ms: null,
      ingest_to_utterance_p95_ms: null,
      recent_ingest_to_utterance_ms: [],
      window_seconds: parsePositiveInt(this.env.ASR_WINDOW_SECONDS, 10),
      hop_seconds: parsePositiveInt(this.env.ASR_HOP_SECONDS, 3),
      last_window_end_seq: 0,
      utterance_count: 0,
      total_windows_processed: 0,
      total_audio_seconds_processed: 0,
      last_window_latency_ms: null,
      avg_window_latency_ms: null,
      avg_rtf: null,
      consecutive_failures: 0,
      next_retry_after_ms: 0,
      last_error: null,
      last_success_at: null,
      updated_at: new Date().toISOString()
    };
  }

  private sanitizeAsrState(current: AsrState): AsrState {
    current.enabled = this.asrEnabled();
    current.model = this.env.ASR_MODEL ?? current.model ?? DASHSCOPE_DEFAULT_MODEL;
    current.mode = this.asrRealtimeEnabled() ? "realtime" : "windowed";
    current.asr_ws_state = current.asr_ws_state ?? "disconnected";
    current.backlog_chunks = Number.isFinite(current.backlog_chunks) ? current.backlog_chunks : 0;
    current.ingest_lag_seconds = Number.isFinite(current.ingest_lag_seconds) ? current.ingest_lag_seconds : 0;
    current.last_emit_at = current.last_emit_at ?? null;
    current.ingest_to_utterance_p50_ms = current.ingest_to_utterance_p50_ms ?? null;
    current.ingest_to_utterance_p95_ms = current.ingest_to_utterance_p95_ms ?? null;
    current.recent_ingest_to_utterance_ms = Array.isArray(current.recent_ingest_to_utterance_ms)
      ? current.recent_ingest_to_utterance_ms.filter((item) => Number.isFinite(item)).slice(-200)
      : [];
    current.window_seconds = parsePositiveInt(this.env.ASR_WINDOW_SECONDS, current.window_seconds || 10);
    current.hop_seconds = parsePositiveInt(this.env.ASR_HOP_SECONDS, current.hop_seconds || 3);
    current.total_windows_processed = Number.isFinite(current.total_windows_processed)
      ? current.total_windows_processed
      : 0;
    current.total_audio_seconds_processed = Number.isFinite(current.total_audio_seconds_processed)
      ? current.total_audio_seconds_processed
      : 0;
    if (current.last_window_latency_ms === undefined) current.last_window_latency_ms = null;
    if (current.avg_window_latency_ms === undefined) current.avg_window_latency_ms = null;
    if (current.avg_rtf === undefined) current.avg_rtf = null;
    return current;
  }

  private defaultAsrByStream(): Record<StreamRole, AsrState> {
    return {
      mixed: this.buildDefaultAsrState(),
      teacher: this.buildDefaultAsrState(),
      students: this.buildDefaultAsrState()
    };
  }

  private async loadIngestByStream(sessionId: string): Promise<Record<StreamRole, IngestState>> {
    const current = await this.ctx.storage.get<Record<StreamRole, IngestState>>(STORAGE_KEY_INGEST_BY_STREAM);
    if (current?.mixed && current?.teacher && current?.students) {
      return current;
    }

    const migrated = emptyIngestByStream(sessionId);
    const legacy = await this.ctx.storage.get<IngestState>(STORAGE_KEY_INGEST_STATE);
    if (legacy) {
      migrated.mixed = legacy;
    }

    await this.storeIngestByStream(migrated);
    return migrated;
  }

  private async storeIngestByStream(state: Record<StreamRole, IngestState>): Promise<void> {
    for (const role of STREAM_ROLES) {
      state[role].updated_at = new Date().toISOString();
    }
    await this.ctx.storage.put(STORAGE_KEY_INGEST_BY_STREAM, state);
    await this.ctx.storage.put(STORAGE_KEY_INGEST_STATE, state.mixed);
  }

  private async loadAsrByStream(): Promise<Record<StreamRole, AsrState>> {
    const current = await this.ctx.storage.get<Record<StreamRole, AsrState>>(STORAGE_KEY_ASR_BY_STREAM);
    if (current?.mixed && current?.teacher && current?.students) {
      current.mixed = this.sanitizeAsrState(current.mixed);
      current.teacher = this.sanitizeAsrState(current.teacher);
      current.students = this.sanitizeAsrState(current.students);
      return current;
    }

    const migrated = this.defaultAsrByStream();
    const legacy = await this.ctx.storage.get<AsrState>(STORAGE_KEY_ASR_STATE);
    if (legacy) {
      migrated.mixed = this.sanitizeAsrState(legacy);
    }

    await this.storeAsrByStream(migrated);
    return migrated;
  }

  private async storeAsrByStream(state: Record<StreamRole, AsrState>): Promise<void> {
    for (const role of STREAM_ROLES) {
      state[role].updated_at = new Date().toISOString();
    }
    await this.ctx.storage.put(STORAGE_KEY_ASR_BY_STREAM, state);
    await this.ctx.storage.put(STORAGE_KEY_ASR_STATE, state.mixed);
  }

  private async loadUtterancesRawByStream(): Promise<Record<StreamRole, UtteranceRaw[]>> {
    const current = await this.ctx.storage.get<Record<StreamRole, UtteranceRaw[]>>(STORAGE_KEY_UTTERANCES_RAW_BY_STREAM);
    if (current?.mixed && current?.teacher && current?.students) {
      return current;
    }

    const migrated = emptyUtterancesRawByStream();
    const legacy = await this.ctx.storage.get<UtteranceRaw[]>(STORAGE_KEY_UTTERANCES_RAW);
    if (legacy && Array.isArray(legacy)) {
      migrated.mixed = legacy.map((item) => ({ ...item, stream_role: item.stream_role ?? "mixed" }));
    }

    await this.storeUtterancesRawByStream(migrated);
    return migrated;
  }

  private async storeUtterancesRawByStream(state: Record<StreamRole, UtteranceRaw[]>): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_UTTERANCES_RAW_BY_STREAM, state);
    await this.ctx.storage.put(STORAGE_KEY_UTTERANCES_RAW, state.mixed);
  }

  private async loadUtterancesMergedByStream(): Promise<Record<StreamRole, UtteranceMerged[]>> {
    const current = await this.ctx.storage.get<Record<StreamRole, UtteranceMerged[]>>(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM);
    if (current?.mixed && current?.teacher && current?.students) {
      return current;
    }

    const raw = await this.loadUtterancesRawByStream();
    const rebuilt: Record<StreamRole, UtteranceMerged[]> = {
      mixed: mergeUtterances(raw.mixed),
      teacher: mergeUtterances(raw.teacher),
      students: mergeUtterances(raw.students)
    };
    await this.ctx.storage.put(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM, rebuilt);
    return rebuilt;
  }

  private async storeUtterancesMergedByStream(state: Record<StreamRole, UtteranceMerged[]>): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM, state);
  }

  private async loadSpeakerEvents(): Promise<SpeakerEvent[]> {
    return (await this.ctx.storage.get<SpeakerEvent[]>(STORAGE_KEY_EVENTS)) ?? [];
  }

  private async storeDependencyHealth(health: DependencyHealthSnapshot): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_DEPENDENCY_HEALTH, health);
  }

  private async loadDependencyHealth(): Promise<DependencyHealthSnapshot> {
    const stored = await this.ctx.storage.get<DependencyHealthSnapshot>(STORAGE_KEY_DEPENDENCY_HEALTH);
    if (stored) return stored;
    const snapshot = this.inferenceClient.snapshot();
    await this.storeDependencyHealth(snapshot);
    return snapshot;
  }

  private confidenceBucketFromEvidence(evidence: ResolveEvidence | null | undefined): "high" | "medium" | "low" | "unknown" {
    const topScore = typeof evidence?.profile_top_score === "number" ? evidence.profile_top_score : null;
    const svScore = typeof evidence?.sv_score === "number" ? evidence.sv_score : null;
    const score = topScore ?? svScore;
    if (score === null || !Number.isFinite(score)) return "unknown";
    if (score >= 0.8) return "high";
    if (score >= 0.6) return "medium";
    return "low";
  }

  private echoLeakRate(transcript: TranscriptItem[]): number {
    const teacher = transcript
      .filter((item) => item.stream_role === "teacher")
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    const students = transcript
      .filter((item) => item.stream_role === "students")
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
    if (teacher.length === 0 || students.length === 0) return 0;

    let overlapLeak = 0;
    let totalStudents = 0;
    for (const item of students) {
      totalStudents += 1;
      const normalized = item.text.trim().toLowerCase();
      if (!normalized) continue;
      const hit = teacher.find((t) => {
        const overlap = Math.min(t.end_ms, item.end_ms) - Math.max(t.start_ms, item.start_ms);
        if (overlap <= 0) return false;
        const left = t.text.trim().toLowerCase();
        if (!left) return false;
        const short = normalized.length < left.length ? normalized : left;
        const long = normalized.length < left.length ? left : normalized;
        if (short.length < 12) return false;
        return long.includes(short);
      });
      if (hit) overlapLeak += 1;
    }
    if (totalStudents === 0) return 0;
    return overlapLeak / totalStudents;
  }

  private suppressionFalsePositiveRate(
    transcript: TranscriptItem[],
    captureByStream: Record<StreamRole, CaptureState>
  ): number {
    const suppressed = Number(captureByStream.teacher.echo_suppressed_chunks ?? 0);
    if (!Number.isFinite(suppressed) || suppressed <= 0) return 0;
    const teacherTurns = transcript.filter((item) => item.stream_role === "teacher").length;
    if (teacherTurns <= 0) return 0;
    const ratio = suppressed / Math.max(teacherTurns, 1);
    return Math.max(0, Math.min(1, ratio * 0.1));
  }

  private buildQualityMetrics(
    transcript: TranscriptItem[],
    captureByStream: Record<StreamRole, CaptureState>
  ): QualityMetrics {
    const students = transcript.filter((item) => item.stream_role === "students");
    const unknown = students.filter((item) => !item.speaker_name || item.decision === "unknown").length;
    const unknownRatio = students.length > 0 ? unknown / students.length : 0;
    const echoSuppressed = Number(captureByStream.teacher.echo_suppressed_chunks ?? 0);
    const echoRecent = Number(captureByStream.teacher.echo_suppression_recent_rate ?? 0);
    return {
      unknown_ratio: unknownRatio,
      students_utterance_count: students.length,
      students_unknown_count: unknown,
      echo_suppressed_chunks: Number.isFinite(echoSuppressed) ? Math.max(0, Math.floor(echoSuppressed)) : 0,
      echo_suppression_recent_rate: Number.isFinite(echoRecent) ? Math.max(0, Math.min(1, echoRecent)) : 0,
      echo_leak_rate: this.echoLeakRate(transcript),
      suppression_false_positive_rate: this.suppressionFalsePositiveRate(transcript, captureByStream)
    };
  }

  private speechBackendMode(
    state: SessionState,
    dependencyHealth: DependencyHealthSnapshot
  ): "cloud-primary" | "cloud-secondary" | "edge-sidecar" | "hybrid" {
    const diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";
    const activeInference = dependencyHealth.active_backend === "secondary" ? "cloud-secondary" : "cloud-primary";
    if (diarizationBackend === "edge" && activeInference === "cloud-secondary") return "hybrid";
    if (diarizationBackend === "edge") return "edge-sidecar";
    return activeInference;
  }

  private async appendSpeakerEvent(event: SpeakerEvent): Promise<void> {
    const events = await this.loadSpeakerEvents();
    events.push(event);
    await this.ctx.storage.put(STORAGE_KEY_EVENTS, events);
  }

  private async storeSpeakerEvents(events: SpeakerEvent[]): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_EVENTS, events);
  }

  private emptyAsrCursorByStream(): Record<StreamRole, AsrReplayCursor> {
    const now = this.currentIsoTs();
    return {
      mixed: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: now },
      teacher: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: now },
      students: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: now }
    };
  }

  private async loadAsrCursorByStream(): Promise<Record<StreamRole, AsrReplayCursor>> {
    const current = await this.ctx.storage.get<Record<StreamRole, AsrReplayCursor>>(STORAGE_KEY_ASR_CURSOR_BY_STREAM);
    if (current?.mixed && current?.teacher && current?.students) {
      return current;
    }
    const created = this.emptyAsrCursorByStream();
    await this.ctx.storage.put(STORAGE_KEY_ASR_CURSOR_BY_STREAM, created);
    return created;
  }

  private async patchAsrCursor(streamRole: StreamRole, patch: Partial<AsrReplayCursor>): Promise<void> {
    const current = await this.loadAsrCursorByStream();
    const next = {
      ...current[streamRole],
      ...patch,
      updated_at: this.currentIsoTs()
    };
    current[streamRole] = next;
    await this.ctx.storage.put(STORAGE_KEY_ASR_CURSOR_BY_STREAM, current);
  }

  private async loadMemos(): Promise<MemoItem[]> {
    return (await this.ctx.storage.get<MemoItem[]>(STORAGE_KEY_MEMOS)) ?? [];
  }

  private async storeMemos(memos: MemoItem[]): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_MEMOS, memos);
  }

  private async loadSpeakerLogs(): Promise<SpeakerLogs> {
    const stored = await this.ctx.storage.get<SpeakerLogs>(STORAGE_KEY_SPEAKER_LOGS);
    if (stored) return stored;
    const created = emptySpeakerLogs(this.currentIsoTs());
    await this.ctx.storage.put(STORAGE_KEY_SPEAKER_LOGS, created);
    return created;
  }

  private async storeSpeakerLogs(logs: SpeakerLogs): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_SPEAKER_LOGS, logs);
  }

  private async loadFeedbackCache(sessionId: string): Promise<FeedbackCache> {
    const existing = await this.ctx.storage.get<FeedbackCache>(STORAGE_KEY_FEEDBACK_CACHE);
    if (existing && existing.session_id === sessionId) {
      const normalized: FeedbackCache = {
        ...existing,
        timings: {
          assemble_ms: Number(existing.timings?.assemble_ms ?? 0),
          events_ms: Number(existing.timings?.events_ms ?? 0),
          report_ms: Number(existing.timings?.report_ms ?? 0),
          validation_ms: Number(existing.timings?.validation_ms ?? 0),
          persist_ms: Number(existing.timings?.persist_ms ?? 0),
          total_ms: Number(existing.timings?.total_ms ?? 0)
        },
        report_source: (existing.report_source ?? existing.quality?.report_source ?? "memo_first") as
          | "memo_first"
          | "llm_enhanced"
          | "llm_failed",
        blocking_reason: existing.blocking_reason ?? null,
        quality_gate_passed: Boolean(existing.quality_gate_passed ?? false)
      };
      return normalized;
    }
    const created = emptyFeedbackCache(sessionId, this.currentIsoTs());
    await this.ctx.storage.put(STORAGE_KEY_FEEDBACK_CACHE, created);
    return created;
  }

  private async storeFeedbackCache(cache: FeedbackCache): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_FEEDBACK_CACHE, cache);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, cache.updated_at);
  }

  private resolveStudentBindingForFeedback(
    state: SessionState,
    clusterId: string | null,
    eventSpeakerName: string | null,
    eventDecision: "auto" | "confirm" | "unknown" | null,
    speakerMapByCluster: Map<string, SpeakerMapItem> = new Map()
  ): { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null } {
    return resolveStudentBinding(state, clusterId, eventSpeakerName, eventDecision, speakerMapByCluster);
  }

  private buildTranscriptForFeedback(
    state: SessionState,
    rawByStream: Record<StreamRole, UtteranceRaw[]>,
    events: SpeakerEvent[],
    speakerLogsStored: SpeakerLogs,
    diarizationBackend: "cloud" | "edge"
  ): TranscriptItem[] {
    return buildReconciledTranscript({
      utterances: [...rawByStream.teacher, ...rawByStream.students],
      events,
      speakerLogs: speakerLogsStored,
      state,
      diarizationBackend,
      roster: (state.roster ?? []).flatMap((r) => [r.name, ...(r.aliases ?? [])])
    });
  }

  private buildEvidenceIndex(perPerson: PersonFeedbackItem[]): Record<string, string[]> {
    const index: Record<string, string[]> = {};
    for (const person of perPerson) {
      for (const dimension of person.dimensions) {
        const refs = new Set<string>();
        const claims = [...dimension.strengths, ...dimension.risks, ...dimension.actions];
        for (const claim of claims) {
          for (const ref of claim.evidence_refs) {
            if (ref) refs.add(ref);
          }
        }
        index[`${person.person_key}:${dimension.dimension}`] = [...refs].slice(0, 12);
      }
    }
    return index;
  }

  private findClaimInReport(
    report: ResultV2,
    params: {
      personKey: string;
      dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
      claimType: "strengths" | "risks" | "actions";
      claimId?: string;
    }
  ): { person: PersonFeedbackItem; claim: PersonFeedbackItem["dimensions"][number]["strengths"][number] } | null {
    const person = report.per_person.find((item) => item.person_key === params.personKey);
    if (!person) return null;
    const dimension = person.dimensions.find((item) => item.dimension === params.dimension);
    if (!dimension) return null;
    const claims = dimension[params.claimType];
    const claim = params.claimId ? claims.find((item) => item.claim_id === params.claimId) : claims[0];
    if (!claim) return null;
    return { person, claim };
  }

  private downWeightClaimConfidenceByEvidence(
    claim: PersonFeedbackItem["dimensions"][number]["strengths"][number],
    evidenceById: Map<string, ResultV2["evidence"][number]>
  ): void {
    const hasWeakEvidence = claim.evidence_refs.some((ref) => Boolean(evidenceById.get(ref)?.weak));
    const base = Number(claim.confidence || 0.72);
    claim.confidence = hasWeakEvidence ? Math.max(0.35, Math.min(0.95, base - 0.18)) : Math.max(0.35, Math.min(0.95, base));
  }

  /** Strip claims with empty or invalid evidence_refs so one bad claim doesn't kill the whole LLM report. */
  private sanitizeClaimEvidenceRefs(
    perPerson: PersonFeedbackItem[],
    evidence: ResultV2["evidence"]
  ): { sanitized: PersonFeedbackItem[]; strippedCount: number } {
    const evidenceById = new Set(evidence.map((e) => e.evidence_id));
    let strippedCount = 0;
    const sanitized = perPerson.map((person) => ({
      ...person,
      dimensions: person.dimensions.map((dim) => {
        const filterClaims = (claims: typeof dim.strengths) =>
          claims.filter((claim) => {
            const refs = Array.isArray(claim.evidence_refs)
              ? claim.evidence_refs.map((r) => String(r || "").trim()).filter(Boolean)
              : [];
            // Remove refs that don't exist in evidence
            const validRefs = refs.filter((r) => evidenceById.has(r));
            if (validRefs.length === 0) {
              strippedCount++;
              return false;
            }
            claim.evidence_refs = validRefs;
            return true;
          });
        return {
          ...dim,
          strengths: filterClaims(dim.strengths),
          risks: filterClaims(dim.risks),
          actions: filterClaims(dim.actions)
        };
      })
    }));
    return { sanitized, strippedCount };
  }

  private validateClaimEvidenceRefs(
    report: ResultV2
  ): { valid: boolean; claimCount: number; invalidCount: number; needsEvidenceCount: number; failures: string[] } {
    const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
    let claimCount = 0;
    let invalidCount = 0;
    let needsEvidenceCount = 0;
    const failures: string[] = [];
    for (const person of report.per_person) {
      for (const dimension of person.dimensions) {
        const claims = [...dimension.strengths, ...dimension.risks, ...dimension.actions];
        for (const claim of claims) {
          claimCount += 1;
          const refs = Array.isArray(claim.evidence_refs)
            ? claim.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
            : [];
          if (refs.length === 0) {
            invalidCount += 1;
            needsEvidenceCount += 1;
            failures.push(`claim ${claim.claim_id} has empty evidence_refs`);
            continue;
          }
          const missing = refs.filter((ref) => !evidenceById.has(ref));
          if (missing.length > 0) {
            invalidCount += 1;
            failures.push(`claim ${claim.claim_id} references unknown evidence ids: ${missing.slice(0, 3).join(",")}`);
            continue;
          }
          this.downWeightClaimConfidenceByEvidence(claim, evidenceById);
        }
      }
    }
    return {
      valid: invalidCount === 0 && claimCount > 0,
      claimCount,
      invalidCount,
      needsEvidenceCount,
      failures
    };
  }

  private evaluateFeedbackQualityGates(params: {
    unknownRatio: number;
    ingestP95Ms: number | null;
    claimValidationFailures: string[];
  }): { passed: boolean; failures: string[] } {
    const failures = [...params.claimValidationFailures];
    if (!Number.isFinite(params.unknownRatio) || params.unknownRatio > 0.25) {
      failures.push(`students_unknown_ratio gate failed: observed=${params.unknownRatio.toFixed(4)} target<=0.25`);
    }
    if (params.ingestP95Ms === null || !Number.isFinite(params.ingestP95Ms) || params.ingestP95Ms > 3000) {
      failures.push(`students_ingest_to_utterance_p95_ms gate failed: observed=${params.ingestP95Ms ?? "null"} target<=3000`);
    }
    return { passed: failures.length === 0, failures };
  }

  private mergeStatsWithRoster(stats: SpeakerStatItem[], state: SessionState): SpeakerStatItem[] {
    const out: SpeakerStatItem[] = [...stats];
    const seen = new Set<string>();
    for (const stat of out) {
      const key = String(stat.speaker_key || "").trim().toLowerCase();
      const name = String(stat.speaker_name || "").trim().toLowerCase();
      if (key) seen.add(key);
      if (name) seen.add(name);
    }
    const roster = Array.isArray(state.roster) ? state.roster : [];
    for (const entry of roster) {
      const name = String(entry?.name || "").trim();
      if (!name) continue;
      const lower = name.toLowerCase();
      if (seen.has(lower)) continue;
      out.push({
        speaker_key: name,
        speaker_name: name,
        talk_time_ms: 0,
        talk_time_pct: 0,
        turns: 0,
        silence_ms: 0,
        interruptions: 0,
        interrupted_by_others: 0
      });
      seen.add(lower);
    }
    return out;
  }

  private async maybeRefreshFeedbackCache(sessionId: string, force = false): Promise<FeedbackCache> {
    const current = await this.loadFeedbackCache(sessionId);
    const nowMs = Date.now();
    const updatedMs = Date.parse(current.updated_at);
    if (!force && Number.isFinite(updatedMs) && nowMs - updatedMs < FEEDBACK_REFRESH_INTERVAL_MS) {
      return current;
    }

    const totalStart = Date.now();
    const assembleStart = Date.now();
    const [stateRaw, events, rawByStream, memos, speakerLogsStored, asrByStream] = await Promise.all([
      this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
      this.loadSpeakerEvents(),
      this.loadUtterancesRawByStream(),
      this.loadMemos(),
      this.loadSpeakerLogs(),
      this.loadAsrByStream()
    ]);
    const state = normalizeSessionState(stateRaw);
    const diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";
    const transcript = this.buildTranscriptForFeedback(state, rawByStream, events, speakerLogsStored, diarizationBackend);
    const stats = this.mergeStatsWithRoster(computeSpeakerStats(transcript), state);
    const evidence = buildEvidence({ memos, transcript });
    const memosWithEvidence = attachEvidenceToMemos(memos, evidence);
    const memoFirst = buildMemoFirstReport({
      transcript,
      memos: memosWithEvidence,
      evidence,
      stats
    });
    const assembleMs = Date.now() - assembleStart;

    const locale = getSessionLocale(state, this.env);
    const eventsStart = Date.now();
    const eventsPayload = {
      session_id: sessionId,
      transcript,
      memos: memosWithEvidence,
      stats,
      locale
    };
    const eventsResult = await this.invokeInferenceAnalysisEvents(eventsPayload);
    const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    const eventsMs = Date.now() - eventsStart;

    let reportSource: "memo_first" | "llm_enhanced" | "llm_failed" = "memo_first";
    let reportModel: string | null = null;
    let reportError: string | null = null;
    let reportBlockingReason: string | null = null;
    let finalOverall = memoFirst.overall;
    let finalPerPerson = memoFirst.per_person;
    let reportTimeline: InferenceBackendTimelineItem[] = [];
    const reportStart = Date.now();
    try {
      const reportResult = await this.invokeInferenceAnalysisReport({
        session_id: sessionId,
        transcript,
        memos: memosWithEvidence,
        stats,
        evidence,
        events: analysisEvents,
        locale
      });
      reportTimeline = reportResult.timeline;
      const payload = reportResult.data;
      const candidatePerPerson = Array.isArray(payload?.per_person) ? (payload.per_person as PersonFeedbackItem[]) : [];
      const candidateOverall = (payload?.overall ?? memoFirst.overall) as unknown;
      const candidateQuality =
        payload?.quality && typeof payload.quality === "object" ? (payload.quality as Partial<ReportQualityMeta>) : null;
      if (candidatePerPerson.length > 0) {
        const candidateValidation = this.validateClaimEvidenceRefs({
          evidence,
          per_person: candidatePerPerson
        } as ResultV2);
        if (candidateValidation.valid) {
          finalPerPerson = candidatePerPerson;
          finalOverall = candidateOverall;
          reportSource = "llm_enhanced";
          const source = String(candidateQuality?.report_source || "").trim();
          if (source === "llm_failed") {
            reportSource = "llm_failed";
          }
          if (source === "memo_first") {
            reportSource = "memo_first";
          }
          reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
          reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
        } else {
          reportSource = "llm_failed";
          reportBlockingReason = `analysis/report invalid evidence refs: ${candidateValidation.failures[0] || "unknown"}`;
        }
      } else {
        reportSource = "llm_failed";
        reportBlockingReason = "analysis/report returned empty per_person";
      }
    } catch (error) {
      reportSource = "llm_failed";
      reportError = (error as Error).message;
      reportBlockingReason = `analysis/report failed: ${(error as Error).message}`;
    }
    const reportMs = Date.now() - reportStart;

    const validateStart = Date.now();
    const finalValidation = this.validateClaimEvidenceRefs({
      evidence,
      per_person: finalPerPerson
    } as ResultV2);
    const validation = validatePersonFeedbackEvidence(finalPerPerson);
    const validationMs = Date.now() - validateStart;

    const unresolvedClusterCount = state.clusters.filter((cluster) => {
      const bound = state.bindings[cluster.cluster_id];
      const meta = state.cluster_binding_meta[cluster.cluster_id];
      return !bound || !meta || !meta.locked;
    }).length;
    const totalClusters = state.clusters.length;
    const unresolvedRatio = totalClusters > 0 ? unresolvedClusterCount / totalClusters : 0;
    const confidenceLevel: "high" | "medium" | "low" =
      unresolvedRatio === 0 ? "high" :
      unresolvedRatio <= 0.25 ? "medium" : "low";
    const qualityMetrics = this.buildQualityMetrics(transcript, state.capture_by_stream ?? defaultCaptureByStream());
    const ingestP95Ms =
      typeof asrByStream.students.ingest_to_utterance_p95_ms === "number"
        ? asrByStream.students.ingest_to_utterance_p95_ms
        : null;
    const gateSeedFailures = [...finalValidation.failures];
    if (reportSource !== "llm_enhanced") {
      gateSeedFailures.push(reportBlockingReason || "llm enhanced report unavailable");
    }
    const gateEvaluation = this.evaluateFeedbackQualityGates({
      unknownRatio: qualityMetrics.unknown_ratio,
      ingestP95Ms,
      claimValidationFailures: gateSeedFailures
    });
    const tentative = confidenceLevel === "low" || !gateEvaluation.passed;
    const finalizedAt = this.currentIsoTs();
    const quality: ReportQualityMeta = {
      ...validation.quality,
      generated_at: finalizedAt,
      build_ms: assembleMs + eventsMs + reportMs,
      validation_ms: validationMs,
      claim_count: finalValidation.claimCount,
      invalid_claim_count: finalValidation.invalidCount,
      needs_evidence_count: finalValidation.needsEvidenceCount,
      report_source: reportSource,
      report_model: reportModel,
      report_degraded: reportSource !== "llm_enhanced",
      report_error: reportError
    };

    const backendTimeline: InferenceBackendTimelineItem[] = [
      ...eventsResult.timeline,
      ...reportTimeline
    ];
    const qualityGateSnapshot = {
      finalize_success_target: 0.995,
      students_unknown_ratio_target: 0.25,
      sv_top1_target: 0.90,
      echo_reduction_target: 0.8,
      observed_unknown_ratio: qualityMetrics.unknown_ratio,
      observed_students_turns: qualityMetrics.students_utterance_count,
      observed_students_unknown: qualityMetrics.students_unknown_count,
      observed_echo_suppressed_chunks: qualityMetrics.echo_suppressed_chunks,
      observed_echo_recent_rate: qualityMetrics.echo_suppression_recent_rate,
      observed_echo_leak_rate: qualityMetrics.echo_leak_rate,
      observed_suppression_false_positive_rate: qualityMetrics.suppression_false_positive_rate
    };

    const result = buildResultV2({
      sessionId,
      finalizedAt,
      tentative,
      confidenceLevel,
      unresolvedClusterCount,
      diarizationBackend,
      transcript,
      speakerLogs:
        diarizationBackend === "edge"
          ? this.buildEdgeSpeakerLogsForFinalize(finalizedAt, speakerLogsStored, state)
          : this.deriveSpeakerLogsFromTranscript(finalizedAt, transcript, state, speakerLogsStored, "cloud"),
      stats,
      memos,
      evidence,
      overall: finalOverall,
      perPerson: finalPerPerson,
      quality,
      finalizeJobId: `feedback-open-${crypto.randomUUID()}`,
      modelVersions: {
        asr: DASHSCOPE_DEFAULT_MODEL,
        analysis_events_path: this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
        analysis_report_path: this.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
        summary_mode: "memo_first_with_llm_polish"
      },
      thresholds: {
        feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
        feedback_events_budget_ms: FEEDBACK_EVENTS_BUDGET_MS,
        feedback_report_budget_ms: FEEDBACK_REPORT_BUDGET_MS,
        feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
        feedback_persist_fetch_budget_ms: FEEDBACK_PERSIST_FETCH_BUDGET_MS
      },
      backendTimeline,
      qualityGateSnapshot,
      reportPipeline: {
        mode: "memo_first_with_llm_polish",
        source: reportSource,
        llm_attempted: true,
        llm_success: reportSource === "llm_enhanced",
        llm_elapsed_ms: reportMs,
        blocking_reason: reportBlockingReason
      },
      qualityGateFailures: gateEvaluation.failures
    });

    const nextCache: FeedbackCache = {
      session_id: sessionId,
      updated_at: finalizedAt,
      ready: false,
      person_summary_cache: finalPerPerson,
      overall_summary_cache: finalOverall,
      evidence_index_cache: this.buildEvidenceIndex(finalPerPerson),
      report: result,
      quality,
      timings: {
        assemble_ms: assembleMs,
        events_ms: eventsMs,
        report_ms: reportMs,
        validation_ms: validationMs,
        persist_ms: 0,
        total_ms: 0
      },
      report_source: reportSource,
      blocking_reason: reportBlockingReason,
      quality_gate_passed: false
    };
    const persistStart = Date.now();
    await this.storeFeedbackCache(nextCache);
    const persistMs = Date.now() - persistStart;
    const totalMs = Date.now() - totalStart;
    const meetsBudget =
      totalMs <= FEEDBACK_TOTAL_BUDGET_MS &&
      assembleMs <= FEEDBACK_ASSEMBLE_BUDGET_MS &&
      eventsMs <= FEEDBACK_EVENTS_BUDGET_MS &&
      reportMs <= FEEDBACK_REPORT_BUDGET_MS &&
      validationMs <= FEEDBACK_VALIDATE_BUDGET_MS &&
      persistMs <= FEEDBACK_PERSIST_FETCH_BUDGET_MS;
    const gatePassed = gateEvaluation.passed && meetsBudget;
    const budgetReason = meetsBudget
      ? null
      : `feedback budgets exceeded (total=${totalMs} assemble=${assembleMs} events=${eventsMs} report=${reportMs} validate=${validationMs} persist=${persistMs})`;
    nextCache.timings.persist_ms = persistMs;
    nextCache.timings.total_ms = totalMs;
    nextCache.ready = gatePassed;
    nextCache.quality_gate_passed = gatePassed;
    if (!meetsBudget && nextCache.report) {
      const failures = Array.isArray(nextCache.report.trace.quality_gate_failures)
        ? [...nextCache.report.trace.quality_gate_failures]
        : [];
      failures.push(
        `feedback_budget gate failed: total=${totalMs} assemble=${assembleMs} events=${eventsMs} report=${reportMs} validate=${validationMs} persist=${persistMs}`
      );
      nextCache.report.trace.quality_gate_failures = failures;
    }
    if (!nextCache.ready && !nextCache.blocking_reason) {
      nextCache.blocking_reason = gateEvaluation.failures[0] || budgetReason || "feedback quality gate failed";
    } else if (budgetReason) {
      nextCache.blocking_reason = budgetReason;
    }
    await this.storeFeedbackCache(nextCache);
    return nextCache;
  }

  private async loadFinalizeV2Status(): Promise<FinalizeV2Status | null> {
    const stored = (await this.ctx.storage.get<FinalizeV2Status>(STORAGE_KEY_FINALIZE_V2_STATUS)) ?? null;
    if (!stored) return null;
    const heartbeat = typeof stored.heartbeat_at === "string" ? stored.heartbeat_at : stored.started_at;
    const normalized: FinalizeV2Status = {
      ...stored,
      heartbeat_at: heartbeat ?? this.currentIsoTs(),
      warnings: Array.isArray(stored.warnings) ? stored.warnings : [],
      degraded: Boolean(stored.degraded),
      backend_used: stored.backend_used ?? "primary"
    };
    if (
      stored.heartbeat_at === normalized.heartbeat_at &&
      Array.isArray(stored.warnings) &&
      stored.degraded === normalized.degraded &&
      stored.backend_used === normalized.backend_used
    ) {
      return normalized;
    }
    await this.ctx.storage.put(STORAGE_KEY_FINALIZE_V2_STATUS, normalized);
    return normalized;
  }

  private async storeFinalizeV2Status(status: FinalizeV2Status): Promise<void> {
    const normalized: FinalizeV2Status = {
      ...status,
      heartbeat_at: status.heartbeat_at ?? status.started_at ?? this.currentIsoTs(),
      warnings: Array.isArray(status.warnings) ? status.warnings : [],
      degraded: Boolean(status.degraded),
      backend_used: status.backend_used ?? "primary"
    };
    await this.ctx.storage.put(STORAGE_KEY_FINALIZE_V2_STATUS, normalized);
    await this.scheduleFinalizeWatchdog(normalized);
  }

  private async setFinalizeLock(locked: boolean): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_FINALIZE_LOCK, locked);
  }

  private async isFinalizeLocked(): Promise<boolean> {
    return Boolean(await this.ctx.storage.get<boolean>(STORAGE_KEY_FINALIZE_LOCK));
  }

  private isFinalizeTerminal(status: FinalizeV2Status["status"]): boolean {
    return status === "failed" || status === "succeeded";
  }

  private finalizeStatusHeartbeatMs(status: FinalizeV2Status): number {
    const heartbeat = Date.parse(status.heartbeat_at ?? status.started_at);
    if (Number.isFinite(heartbeat)) return heartbeat;
    const started = Date.parse(status.started_at);
    return Number.isFinite(started) ? started : Date.now();
  }

  private async clearFinalizeWatchdogAlarm(): Promise<void> {
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // Best-effort cleanup; some runtimes may throw if no alarm exists.
    }
  }

  private async scheduleFinalizeWatchdog(status: FinalizeV2Status): Promise<void> {
    if (status.status === "queued" || status.status === "running") {
      const heartbeatMs = this.finalizeStatusHeartbeatMs(status);
      await this.ctx.storage.setAlarm(heartbeatMs + this.finalizeWatchdogMs());
      return;
    }
    await this.clearFinalizeWatchdogAlarm();
  }

  private async failStuckFinalizeIfNeeded(reason: string): Promise<FinalizeV2Status | null> {
    const current = await this.loadFinalizeV2Status();
    if (!current || this.isFinalizeTerminal(current.status)) {
      if (current && this.isFinalizeTerminal(current.status)) {
        await this.clearFinalizeWatchdogAlarm();
      }
      return current;
    }
    const heartbeatMs = this.finalizeStatusHeartbeatMs(current);
    const elapsedMs = Date.now() - heartbeatMs;
    const thresholdMs = this.finalizeWatchdogMs();
    if (elapsedMs <= thresholdMs) {
      await this.scheduleFinalizeWatchdog(current);
      return current;
    }

    const nowIso = this.currentIsoTs();
    const next: FinalizeV2Status = {
      ...current,
      status: "failed",
      heartbeat_at: nowIso,
      finished_at: nowIso,
      errors: [...current.errors, `watchdog timeout: stage=${current.stage} elapsed_ms=${elapsedMs} reason=${reason}`]
    };
    await this.storeFinalizeV2Status(next);
    await this.setFinalizeLock(false);
    await Promise.all([
      this.closeRealtimeAsrSession("teacher", "finalize-watchdog", false, true),
      this.closeRealtimeAsrSession("students", "finalize-watchdog", false, true)
    ]);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, nowIso);
    return next;
  }

  private async ensureFinalizeJobActive(jobId: string): Promise<void> {
    const current = await this.loadFinalizeV2Status();
    if (!current || current.job_id !== jobId) {
      throw new Error(`finalize job ${jobId} is no longer current`);
    }
    if (this.isFinalizeTerminal(current.status)) {
      throw new Error(`finalize job ${jobId} already ${current.status}`);
    }
  }

  private currentRealtimeWsState(runtime: AsrRealtimeRuntime): "disconnected" | "connecting" | "running" | "error" {
    if (runtime.connecting) return "connecting";
    if (runtime.connected && runtime.running) return "running";
    if (runtime.connected) return "connecting";
    return "disconnected";
  }

  private async refreshAsrStreamMetrics(
    sessionId: string,
    streamRole: StreamRole,
    patch: Partial<AsrState> = {}
  ): Promise<void> {
    const [asrByStream, ingestByStream] = await Promise.all([this.loadAsrByStream(), this.loadIngestByStream(sessionId)]);
    const runtime = this.asrRealtimeByStream[streamRole];
    const asr = asrByStream[streamRole];

    asr.mode = this.asrRealtimeEnabled() ? "realtime" : "windowed";
    asr.asr_ws_state = this.currentRealtimeWsState(runtime);
    asr.backlog_chunks = runtime.sendQueue.length;
    asr.ingest_lag_seconds = Math.max(0, ingestByStream[streamRole].last_seq - runtime.lastSentSeq);
    asr.last_emit_at = runtime.lastEmitAt;

    Object.assign(asr, patch);
    asrByStream[streamRole] = asr;
    await this.storeAsrByStream(asrByStream);
  }

  private async closeRealtimeAsrSession(
    streamRole: StreamRole,
    reason: string,
    clearQueue = false,
    gracefulFinish = true
  ): Promise<void> {
    const runtime = this.asrRealtimeByStream[streamRole];
    const ws = runtime.ws;

    if (clearQueue) {
      runtime.sendQueue = [];
      runtime.currentStartSeq = null;
      runtime.currentStartTsMs = null;
      runtime.lastSentSeq = 0;
      runtime.sentChunkTsBySeq.clear();
      runtime.lastEmitAt = null;
      runtime.lastFinalTextNorm = "";
    }

    if (ws) {
      try {
        if (runtime.taskId && gracefulFinish) {
          ws.send(
            JSON.stringify({
              header: {
                action: "finish-task",
                task_id: runtime.taskId,
                streaming: "duplex"
              },
              payload: {
                input: {}
              }
            })
          );
          await sleep(1000);
        }
      } catch {
        // ignore finish-task errors during close
      }
      try {
        ws.close(1000, reason.slice(0, 120));
      } catch {
        // ignore close errors
      }
    }

    runtime.connected = false;
    runtime.connecting = false;
    runtime.running = false;
    runtime.readyResolve = null;
    runtime.readyReject = null;
    runtime.readyPromise = null;
    runtime.connectPromise = null;
    runtime.flushPromise = null;
    runtime.ws = null;
    runtime.taskId = null;
    runtime.drainGeneration += 1;
  }

  private async hydrateRuntimeFromCursor(streamRole: StreamRole): Promise<void> {
    const cursors = await this.loadAsrCursorByStream();
    const cursor = cursors[streamRole];
    const runtime = this.asrRealtimeByStream[streamRole];
    runtime.lastSentSeq = Math.max(runtime.lastSentSeq, cursor.last_sent_seq);
    if (runtime.currentStartSeq === null && cursor.last_emitted_seq > 0) {
      runtime.currentStartSeq = cursor.last_emitted_seq + 1;
    }
  }

  private async replayGapFromR2(sessionId: string, streamRole: StreamRole): Promise<void> {
    const [cursors, ingestByStream] = await Promise.all([this.loadAsrCursorByStream(), this.loadIngestByStream(sessionId)]);
    const cursor = cursors[streamRole];
    const ingest = ingestByStream[streamRole];
    const replayStart = cursor.last_sent_seq + 1;
    if (replayStart > ingest.last_seq) return;

    for (let seq = replayStart; seq <= ingest.last_seq; seq += 1) {
      const key = chunkObjectKey(sessionId, streamRole, seq);
      const object = await this.env.RESULT_BUCKET.get(key);
      if (!object) continue;
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== ONE_SECOND_PCM_BYTES) continue;
      const tsRaw = object.customMetadata?.timestamp_ms ?? "";
      const parsedTs = Number(tsRaw);
      const timestampMs = Number.isFinite(parsedTs) ? parsedTs : seq * 1000;
      await this.enqueueRealtimeChunk(sessionId, streamRole, seq, timestampMs, bytes);
    }
  }

  private async ensureRealtimeAsrConnected(sessionId: string, streamRole: StreamRole): Promise<void> {
    const runtime = this.asrRealtimeByStream[streamRole];
    await this.hydrateRuntimeFromCursor(streamRole);
    if (runtime.connected && runtime.running && runtime.ws) {
      return;
    }
    if (runtime.connectPromise) {
      return runtime.connectPromise;
    }

    runtime.connectPromise = (async () => {
      runtime.connecting = true;
      await this.refreshAsrStreamMetrics(sessionId, streamRole);

      const apiKey = (this.env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim();
      if (!apiKey) {
        throw new Error("ALIYUN_DASHSCOPE_API_KEY is missing");
      }

      const asrByStream = await this.loadAsrByStream();
      const asrState = asrByStream[streamRole];
      const wsUrl = this.env.ASR_WS_URL ?? DASHSCOPE_DEFAULT_WS_URL;
      const handshakeUrl = toWebSocketHandshakeUrl(wsUrl);
      const timeoutMs = parseTimeoutMs(this.env.ASR_TIMEOUT_MS ?? "45000");

      const fetchAbort = new AbortController();
      const fetchTimer = setTimeout(() => fetchAbort.abort(), Math.min(timeoutMs, 15_000));
      const response = await fetch(handshakeUrl, {
        method: "GET",
        headers: {
          Authorization: `bearer ${apiKey}`,
          Upgrade: "websocket"
        },
        signal: fetchAbort.signal
      });
      clearTimeout(fetchTimer);

      if (response.status !== 101 || !response.webSocket) {
        throw new Error(`dashscope websocket handshake failed: HTTP ${response.status}`);
      }

      const ws = response.webSocket;
      ws.accept();

      runtime.ws = ws;
      runtime.connected = true;
      runtime.running = false;
      runtime.startedAt = Date.now();
      runtime.taskId = `asr-realtime-${streamRole}-${crypto.randomUUID()}`;
      runtime.readyPromise = new Promise<void>((resolve, reject) => {
        runtime.readyResolve = resolve;
        runtime.readyReject = reject;
      });

      ws.addEventListener("message", (event) => {
        this.ctx.waitUntil(
          this.handleRealtimeAsrMessage(sessionId, streamRole, event.data).catch(async (error) => {
            console.error(`asr realtime message handler failed stream=${streamRole}:`, error);
            await this.refreshAsrStreamMetrics(sessionId, streamRole, {
              asr_ws_state: "error",
              last_error: (error as Error).message
            });
          })
        );
      });

      ws.addEventListener("error", () => {
        this.ctx.waitUntil(
          this.refreshAsrStreamMetrics(sessionId, streamRole, {
            asr_ws_state: "error",
            last_error: "dashscope websocket error"
          })
        );
      });

      ws.addEventListener("close", () => {
        runtime.connected = false;
        runtime.running = false;
        runtime.ws = null;
        runtime.taskId = null;
        runtime.readyPromise = null;
        runtime.readyResolve = null;
        runtime.readyReject = null;
        this.ctx.waitUntil(this.refreshAsrStreamMetrics(sessionId, streamRole));
      });

      ws.send(
        JSON.stringify({
          header: {
            action: "run-task",
            task_id: runtime.taskId,
            streaming: "duplex"
          },
          payload: {
            task_group: "audio",
            task: "asr",
            function: "recognition",
            model: asrState.model,
            input: {},
            parameters: {
              format: "pcm",
              sample_rate: TARGET_SAMPLE_RATE
            }
          }
        })
      );

      const startedTimeout = setTimeout(() => {
        runtime.readyReject?.(new Error("dashscope task-started timeout"));
      }, Math.min(timeoutMs, 15000));

      await runtime.readyPromise;
      clearTimeout(startedTimeout);
      runtime.reconnectBackoffMs = 500;
      await this.replayGapFromR2(sessionId, streamRole);

      await this.refreshAsrStreamMetrics(sessionId, streamRole, {
        asr_ws_state: "running",
        last_error: null
      });
    })()
      .catch(async (error) => {
        runtime.connected = false;
        runtime.running = false;
        runtime.ws = null;
        runtime.readyPromise = null;
        runtime.readyResolve = null;
        runtime.readyReject = null;
        await this.refreshAsrStreamMetrics(sessionId, streamRole, {
          asr_ws_state: "error",
          last_error: (error as Error).message
        });
        throw error;
      })
      .finally(() => {
        runtime.connecting = false;
        runtime.connectPromise = null;
      });

    return runtime.connectPromise;
  }

  private async emitRealtimeUtterance(
    sessionId: string,
    streamRole: StreamRole,
    text: string
  ): Promise<void> {
    const runtime = this.asrRealtimeByStream[streamRole];
    const endSeq = Math.max(runtime.lastSentSeq, runtime.currentStartSeq ?? runtime.lastSentSeq);
    if (endSeq <= 0) {
      return;
    }

    const startSeq = runtime.currentStartSeq ?? endSeq;
    const createdAt = new Date().toISOString();
    const endIngestAtMs = runtime.sentChunkTsBySeq.get(endSeq) ?? Date.now();
    const latencyMs = Math.max(0, Date.now() - endIngestAtMs);
    const startMs = (startSeq - 1) * 1000;
    const endMs = endSeq * 1000;

    const [asrByStream, utterancesByStream, ingestByStream] = await Promise.all([
      this.loadAsrByStream(),
      this.loadUtterancesRawByStream(),
      this.loadIngestByStream(sessionId)
    ]);

    const asrState = asrByStream[streamRole];
    const utterances = utterancesByStream[streamRole];
    const utterance: UtteranceRaw = {
      utterance_id: `${sessionId}-${streamRole}-${String(endSeq).padStart(8, "0")}-${Date.now().toString(36)}`,
      session_id: sessionId,
      stream_role: streamRole,
      text: text.trim(),
      start_seq: startSeq,
      end_seq: endSeq,
      start_ms: startMs,
      end_ms: endMs,
      duration_ms: endMs - startMs,
      asr_model: asrState.model,
      asr_provider: "dashscope",
      confidence: null,
      created_at: createdAt,
      latency_ms: latencyMs
    };
    utterances.push(utterance);
    utterancesByStream[streamRole] = utterances;
    await this.storeUtterancesRawByStream(utterancesByStream);

    const mergedByStream = await this.loadUtterancesMergedByStream();
    mergedByStream[streamRole] = mergeUtterances(utterances);
    await this.storeUtterancesMergedByStream(mergedByStream);

    asrState.mode = this.asrRealtimeEnabled() ? "realtime" : "windowed";
    asrState.asr_ws_state = "running";
    asrState.last_window_end_seq = endSeq;
    asrState.utterance_count = utterances.length;
    asrState.total_windows_processed += 1;
    asrState.total_audio_seconds_processed += Math.max(1, endSeq - startSeq + 1);
    asrState.last_window_latency_ms = latencyMs;
    if (!asrState.avg_window_latency_ms || asrState.avg_window_latency_ms <= 0) {
      asrState.avg_window_latency_ms = latencyMs;
    } else {
      const processed = asrState.total_windows_processed;
      asrState.avg_window_latency_ms =
        (asrState.avg_window_latency_ms * (processed - 1) + latencyMs) / processed;
    }
    const windowDurationMs = Math.max(1000, (endSeq - startSeq + 1) * 1000);
    const currentRtf = latencyMs / windowDurationMs;
    if (!asrState.avg_rtf || asrState.avg_rtf <= 0) {
      asrState.avg_rtf = currentRtf;
    } else {
      const processed = asrState.total_windows_processed;
      asrState.avg_rtf = (asrState.avg_rtf * (processed - 1) + currentRtf) / processed;
    }
    asrState.last_error = null;
    asrState.last_success_at = createdAt;
    asrState.consecutive_failures = 0;
    asrState.next_retry_after_ms = 0;
    asrState.last_emit_at = createdAt;

    const recent = [...(asrState.recent_ingest_to_utterance_ms ?? []), latencyMs].slice(-200);
    asrState.recent_ingest_to_utterance_ms = recent;
    asrState.ingest_to_utterance_p50_ms = quantile(recent, 0.5);
    asrState.ingest_to_utterance_p95_ms = quantile(recent, 0.95);
    asrState.backlog_chunks = runtime.sendQueue.length;
    asrState.ingest_lag_seconds = Math.max(0, ingestByStream[streamRole].last_seq - runtime.lastSentSeq);

    asrByStream[streamRole] = asrState;
    await this.storeAsrByStream(asrByStream);

    runtime.lastEmitAt = createdAt;
    runtime.currentStartSeq = endSeq + 1;
    runtime.currentStartTsMs = null;
    for (const seq of runtime.sentChunkTsBySeq.keys()) {
      if (seq <= endSeq) {
        runtime.sentChunkTsBySeq.delete(seq);
      }
    }
    await this.patchAsrCursor(streamRole, {
      last_sent_seq: Math.max(runtime.lastSentSeq, endSeq),
      last_emitted_seq: endSeq
    });

    if (streamRole === "students") {
      let resolvedInfo:
        | {
            cluster_id: string;
            speaker_name: string | null;
            decision: "auto" | "confirm" | "unknown";
            evidence: ResolveEvidence | null;
          }
        | null = null;
      try {
        const chunkRange = await this.loadChunkRange(sessionId, streamRole, startSeq, endSeq);
        const mergedPcm = concatUint8Arrays(chunkRange);
        const resolveWav = tailPcm16BytesToWavForSeconds(mergedPcm, this.resolveAudioWindowSeconds());
        resolvedInfo = await this.autoResolveStudentsUtterance(sessionId, utterance, resolveWav);
        const enrollWav = pcm16ToWavBytes(mergedPcm);
        await this.maybeAutoEnrollStudentsUtterance(sessionId, utterance, enrollWav, resolvedInfo);
      } catch (error) {
        const inferenceError = error instanceof InferenceRequestError ? error : null;
        await this.appendSpeakerEvent({
          ts: new Date().toISOString(),
          stream_role: "students",
          source: "inference_resolve",
          identity_source: "inference_resolve",
          utterance_id: utterance.utterance_id,
          cluster_id: null,
          speaker_name: null,
          decision: "unknown",
          evidence: null,
          note: `students auto-resolve failed: ${(error as Error).message}`,
          backend: inferenceError ? inferenceError.health.active_backend : "primary",
          fallback_reason: inferenceError ? "resolve_all_backends_failed" : null,
          confidence_bucket: "unknown",
          metadata: {
            profile_score: resolvedInfo?.evidence?.profile_top_score ?? null,
            profile_margin: resolvedInfo?.evidence?.profile_margin ?? null,
            binding_locked: false,
            timeline: inferenceError?.timeline ?? null
          }
        });
      }
    } else if (streamRole === "teacher") {
      await this.appendTeacherSpeakerEvent(sessionId, utterance);
    }

    // Schedule incremental checkpoint if interval has elapsed (non-blocking)
    this.ctx.waitUntil(
      this.maybeScheduleCheckpoint(sessionId, utterance.end_ms, streamRole)
    );
  }

  private async handleRealtimeAsrMessage(
    sessionId: string,
    streamRole: StreamRole,
    data: string | ArrayBuffer | ArrayBufferView
  ): Promise<void> {
    if (typeof data !== "string") return;

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object") return;
    const messageObject = payload as Record<string, unknown>;
    const headerObject = (messageObject.header ?? null) as Record<string, unknown> | null;
    const payloadObject = messageObject.payload ?? null;
    const eventName = String(headerObject?.event ?? "");

    if (this.asrDebugEnabled() && ["task-started", "result-generated", "task-finished", "task-failed"].includes(eventName)) {
      console.log(
        `[asr-debug] session=${sessionId} stream=${streamRole} event=${eventName} payload=${JSON.stringify(payloadObject).slice(0, 400)}`
      );
    }

    const runtime = this.asrRealtimeByStream[streamRole];
    if (eventName === "task-started") {
      runtime.running = true;
      runtime.readyResolve?.();
      runtime.readyResolve = null;
      runtime.readyReject = null;
      await this.refreshAsrStreamMetrics(sessionId, streamRole, { asr_ws_state: "running", last_error: null });
      return;
    }

    if (eventName === "task-failed") {
      const detail = `dashscope task failed: ${JSON.stringify(payload).slice(0, 400)}`;
      runtime.readyReject?.(new Error(detail));
      runtime.readyResolve = null;
      runtime.readyReject = null;
      await this.refreshAsrStreamMetrics(sessionId, streamRole, { asr_ws_state: "error", last_error: detail });
      return;
    }

    const text = extractFirstString(payloadObject);
    if (!text || !text.trim()) return;

    const finalFlag = extractBooleanByKeys(payloadObject, [
      "is_final",
      "final",
      "sentence_end",
      "sentenceEnd",
      "end_of_sentence"
    ]);
    const isFinal = eventName === "task-finished" || finalFlag !== false;
    if (!isFinal) return;

    const normalized = normalizeTextForMerge(text);
    if (normalized && normalized === runtime.lastFinalTextNorm) {
      return;
    }
    runtime.lastFinalTextNorm = normalized;

    const beginMs = extractNumberByKeys(payloadObject, ["begin_time", "beginTime", "start_ms", "startMs"]);
    const endMs = extractNumberByKeys(payloadObject, ["end_time", "endTime", "end_ms", "endMs"]);
    if (beginMs !== null && endMs !== null && endMs >= beginMs) {
      const startSeq = Math.max(1, Math.floor(beginMs / 1000) + 1);
      const inferredEndSeq = Math.max(startSeq, Math.ceil(endMs / 1000));
      runtime.currentStartSeq = startSeq;
      runtime.lastSentSeq = Math.max(runtime.lastSentSeq, inferredEndSeq);
    }

    await this.emitRealtimeUtterance(sessionId, streamRole, text);
  }

  private async enqueueRealtimeChunk(
    sessionId: string,
    streamRole: StreamRole,
    seq: number,
    timestampMs: number,
    bytes: Uint8Array
  ): Promise<void> {
    const runtime = this.asrRealtimeByStream[streamRole];
    if (seq <= runtime.lastSentSeq) {
      return;
    }
    if (runtime.sendQueue.some((item) => item.seq === seq)) {
      return;
    }
    runtime.sendQueue.push({
      seq,
      timestampMs,
      receivedAtMs: Date.now(),
      bytes
    });
    const cursors = await this.loadAsrCursorByStream();
    const current = cursors[streamRole];
    await this.patchAsrCursor(streamRole, {
      last_ingested_seq: Math.max(current.last_ingested_seq, seq)
    });
    await this.refreshAsrStreamMetrics(sessionId, streamRole);
  }

  private async drainRealtimeQueue(sessionId: string, streamRole: StreamRole): Promise<void> {
    const runtime = this.asrRealtimeByStream[streamRole];
    if (runtime.flushPromise) {
      return runtime.flushPromise;
    }

    const startGen = runtime.drainGeneration;
    runtime.flushPromise = (async () => {
      while (runtime.sendQueue.length > 0 && runtime.drainGeneration === startGen) {
        try {
          let lastSentSeq = runtime.lastSentSeq;
          await this.ensureRealtimeAsrConnected(sessionId, streamRole);
          if (runtime.drainGeneration !== startGen) break;
          if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
            throw new Error("dashscope websocket is not open");
          }

          while (runtime.sendQueue.length > 0 && runtime.drainGeneration === startGen) {
            const head = runtime.sendQueue[0];
            if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
              throw new Error("dashscope websocket closed while draining");
            }
            if (runtime.currentStartSeq === null) {
              runtime.currentStartSeq = head.seq;
              runtime.currentStartTsMs = head.timestampMs;
            }
            runtime.ws.send(head.bytes);
            runtime.lastSentSeq = Math.max(runtime.lastSentSeq, head.seq);
            lastSentSeq = Math.max(lastSentSeq, head.seq);
            runtime.sentChunkTsBySeq.set(head.seq, head.receivedAtMs);
            runtime.sendQueue.shift();
          }

          await this.patchAsrCursor(streamRole, {
            last_sent_seq: lastSentSeq
          });
          await this.refreshAsrStreamMetrics(sessionId, streamRole);
        } catch (error) {
          if (runtime.drainGeneration !== startGen) break;
          await this.refreshAsrStreamMetrics(sessionId, streamRole, {
            asr_ws_state: "error",
            last_error: (error as Error).message
          });
          await this.closeRealtimeAsrSession(streamRole, "reconnect", false, false);
          if (runtime.drainGeneration !== startGen) break;
          const backoff = runtime.reconnectBackoffMs;
          runtime.reconnectBackoffMs = Math.min(10_000, runtime.reconnectBackoffMs * 2);
          await sleep(backoff);
        }
      }
    })().finally(() => {
      runtime.flushPromise = null;
    });

    return runtime.flushPromise;
  }

  private async loadChunkRange(
    sessionId: string,
    streamRole: StreamRole,
    startSeq: number,
    endSeq: number
  ): Promise<Uint8Array[]> {
    const chunks: Uint8Array[] = [];
    for (let seq = startSeq; seq <= endSeq; seq += 1) {
      const key = chunkObjectKey(sessionId, streamRole, seq);
      const object = await this.env.RESULT_BUCKET.get(key);
      if (!object) {
        throw new Error(`missing chunk in R2: ${key}`);
      }
      const payload = new Uint8Array(await object.arrayBuffer());
      if (payload.byteLength !== ONE_SECOND_PCM_BYTES) {
        throw new Error(`invalid chunk size for ${key}: ${payload.byteLength}`);
      }
      chunks.push(payload);
    }
    return chunks;
  }

  private getAsrProvider(): "funASR" | "local-whisper" {
    const provider = (this.env.ASR_PROVIDER ?? "funASR").toLowerCase();
    if (provider === "local-whisper") {
      if (!this.localWhisperProvider) {
        const endpoint = this.env.ASR_ENDPOINT ?? this.env.INFERENCE_BASE_URL_PRIMARY ?? "http://127.0.0.1:8000";
        this.localWhisperProvider = new LocalWhisperASRProvider({
          endpoint,
          language: this.env.ASR_LANGUAGE ?? "auto",
          timeout_ms: parseInt(this.env.ASR_TIMEOUT_MS ?? "30000", 10),
          apiKey: (this.env.INFERENCE_API_KEY ?? "").trim(),
        });
      }
      return "local-whisper";
    }
    return "funASR";
  }

  private async runFunAsrDashScope(wavBytes: Uint8Array, model: string): Promise<{ text: string; latencyMs: number }> {
    const apiKey = (this.env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error("ALIYUN_DASHSCOPE_API_KEY is missing");
    }

    const wsUrl = this.env.ASR_WS_URL ?? DASHSCOPE_DEFAULT_WS_URL;
    const handshakeUrl = toWebSocketHandshakeUrl(wsUrl);
    const timeoutMs = parseTimeoutMs(this.env.ASR_TIMEOUT_MS ?? "45000");
    const taskId = `asr-${crypto.randomUUID()}`;
    const startedAt = Date.now();

    const response = await fetch(handshakeUrl, {
      method: "GET",
      headers: {
        Authorization: `bearer ${apiKey}`,
        Upgrade: "websocket"
      }
    });

    if (response.status !== 101 || !response.webSocket) {
      throw new Error(`dashscope websocket handshake failed: HTTP ${response.status}`);
    }

    const ws = response.webSocket;
    ws.accept();

    let readyResolve: (() => void) | null = null;
    let readyReject: ((error: Error) => void) | null = null;
    let finishedResolve: (() => void) | null = null;
    let finishedReject: ((error: Error) => void) | null = null;
    let readyDone = false;
    let finishedDone = false;
    let latestText = "";

    const readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const finishedPromise = new Promise<void>((resolve, reject) => {
      finishedResolve = resolve;
      finishedReject = reject;
    });

    const rejectAll = (error: Error): void => {
      if (!readyDone) {
        readyDone = true;
        readyReject?.(error);
      }
      if (!finishedDone) {
        finishedDone = true;
        finishedReject?.(error);
      }
    };

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;

      let payload: unknown;
      try {
        payload = JSON.parse(event.data);
      } catch {
        return;
      }

      const messageObject = payload as Record<string, unknown>;
      const headerObject = (messageObject.header ?? null) as Record<string, unknown> | null;
      const payloadObject = messageObject.payload ?? null;
      const eventName = String(headerObject?.event ?? "");
      if (eventName === "task-started") {
        if (!readyDone) {
          readyDone = true;
          readyResolve?.();
        }
        return;
      }

      if (eventName === "result-generated") {
        const text = extractFirstString(payloadObject);
        if (text) {
          latestText = text;
        }
        return;
      }

      if (eventName === "task-finished") {
        const text = extractFirstString(payloadObject);
        if (text) {
          latestText = text;
        }
        if (!finishedDone) {
          finishedDone = true;
          finishedResolve?.();
        }
        return;
      }

      if (eventName === "task-failed") {
        rejectAll(new Error(`dashscope task failed: ${JSON.stringify(payload)}`));
      }
    });

    ws.addEventListener("error", () => {
      rejectAll(new Error("dashscope websocket error"));
    });

    ws.addEventListener("close", (event) => {
      if (!finishedDone) {
        rejectAll(new Error(`dashscope websocket closed early: code=${event.code} reason=${event.reason || "none"}`));
      }
    });

    ws.send(
      JSON.stringify({
        header: {
          action: "run-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model,
          input: {},
          parameters: {
            format: "wav",
            sample_rate: TARGET_SAMPLE_RATE
          }
        }
      })
    );

    const readyTimer = setTimeout(() => {
      rejectAll(new Error("dashscope task-started timeout"));
    }, Math.min(timeoutMs, 15000));
    await readyPromise;
    clearTimeout(readyTimer);

    const streamChunkBytes = parsePositiveInt(this.env.ASR_STREAM_CHUNK_BYTES, 12800);
    const pacingMs = Number.isFinite(Number(this.env.ASR_SEND_PACING_MS))
      ? Math.max(0, Number(this.env.ASR_SEND_PACING_MS))
      : 0;
    for (let offset = 0; offset < wavBytes.byteLength; offset += streamChunkBytes) {
      const end = Math.min(offset + streamChunkBytes, wavBytes.byteLength);
      ws.send(wavBytes.slice(offset, end));
      if (pacingMs > 0) {
        await sleep(pacingMs);
      }
    }

    ws.send(
      JSON.stringify({
        header: {
          action: "finish-task",
          task_id: taskId,
          streaming: "duplex"
        },
        payload: {
          input: {}
        }
      })
    );

    const finishedTimer = setTimeout(() => {
      rejectAll(new Error("dashscope task-finished timeout"));
    }, timeoutMs);
    await finishedPromise;
    clearTimeout(finishedTimer);

    try {
      ws.close(1000, "done");
    } catch {
      // ignore
    }

    return {
      text: latestText.trim(),
      latencyMs: Date.now() - startedAt
    };
  }

  private async invokeInferenceResolve(
    sessionId: string,
    audio: AudioPayload,
    asrText: string | null,
    currentState: SessionState
  ): Promise<{
    resolved: ResolveResponse;
    backend: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const resolvePath = this.env.INFERENCE_RESOLVE_PATH ?? "/speaker/resolve";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS);
    const response = await this.callInferenceWithFailover<ResolveResponse>({
      endpoint: "resolve",
      path: resolvePath,
      timeoutMs,
      body: {
        session_id: sessionId,
        audio,
        asr_text: asrText,
        state: currentState
      }
    });
    return {
      resolved: response.data,
      backend: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private async autoResolveStudentsUtterance(
    sessionId: string,
    utterance: UtteranceRaw,
    wavBytes: Uint8Array
  ): Promise<{
    cluster_id: string;
    speaker_name: string | null;
    decision: "auto" | "confirm" | "unknown";
    evidence: ResolveEvidence | null;
  } | null> {
    if (!utterance.text.trim()) {
      return null;
    }

    const currentState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const safeWavBytes = truncatePcm16WavToSeconds(wavBytes, this.resolveAudioWindowSeconds());
    const audioPayload: AudioPayload = {
      content_b64: bytesToBase64(safeWavBytes),
      format: "wav",
      sample_rate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS
    };

    const resolveCall = await this.invokeInferenceResolve(sessionId, audioPayload, utterance.text, currentState);
    const resolved = resolveCall.resolved;
    const mergedState = normalizeSessionState({
      ...resolved.updated_state,
      capture_by_stream: currentState.capture_by_stream
    });
    await this.ctx.storage.put(STORAGE_KEY_STATE, mergedState);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
    const boundSpeakerName =
      resolved.speaker_name ??
      mergedState.bindings[resolved.cluster_id] ??
      mergedState.clusters.find((item) => item.cluster_id === resolved.cluster_id)?.bound_name ??
      null;

    await this.appendSpeakerEvent({
      ts: new Date().toISOString(),
      stream_role: "students",
      source: "inference_resolve",
      identity_source: identitySourceFromBindingSource(resolved.evidence.binding_source),
      utterance_id: utterance.utterance_id,
      cluster_id: resolved.cluster_id,
      speaker_name: boundSpeakerName,
      decision: resolved.decision,
      evidence: resolved.evidence,
      backend: resolveCall.backend,
      fallback_reason: resolveCall.degraded ? "inference_failover" : null,
      confidence_bucket: this.confidenceBucketFromEvidence(resolved.evidence),
      metadata: {
        profile_score: resolved.evidence.profile_top_score ?? null,
        profile_margin: resolved.evidence.profile_margin ?? null,
        binding_locked: mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false,
        warnings: resolveCall.warnings,
        timeline: resolveCall.timeline
      }
    });
    return {
      cluster_id: resolved.cluster_id,
      speaker_name: boundSpeakerName,
      decision: resolved.decision,
      evidence: resolved.evidence ?? null
    };
  }

  private async maybeAutoEnrollStudentsUtterance(
    sessionId: string,
    utterance: UtteranceRaw,
    wavBytes: Uint8Array,
    resolved:
      | {
          cluster_id: string;
          speaker_name: string | null;
          decision: "auto" | "confirm" | "unknown";
          evidence: ResolveEvidence | null;
        }
      | null
  ): Promise<void> {
    const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
    if (enrollment.mode !== "collecting" && enrollment.mode !== "ready") {
      return;
    }
    const durationSeconds = Math.max(1, utterance.duration_ms / 1000);
    let participantName =
      this.inferParticipantFromText(state, utterance.text) ??
      (resolved?.speaker_name ? this.rosterNameByCandidate(state, resolved.speaker_name) : null);

    if (!participantName) {
      this.updateUnassignedEnrollmentByCluster(state, resolved?.cluster_id, durationSeconds);
      await this.ctx.storage.put(STORAGE_KEY_STATE, state);
      await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
      return;
    }

    const enrollAudio: AudioPayload = {
      content_b64: bytesToBase64(truncatePcm16WavToSeconds(wavBytes, INFERENCE_MAX_AUDIO_SECONDS)),
      format: "wav",
      sample_rate: TARGET_SAMPLE_RATE,
      channels: TARGET_CHANNELS
    };
    const enrollCall = await this.callInferenceEnroll(sessionId, participantName, enrollAudio, state);
    const enrollResult = enrollCall.payload;
    const nextState = normalizeSessionState({
      ...enrollResult.updated_state,
      capture_by_stream: state.capture_by_stream
    });
    const progress = this.participantProgressFromProfiles(nextState);
    nextState.enrollment_state = {
      ...(nextState.enrollment_state ?? buildDefaultEnrollmentState()),
      mode: "collecting",
      started_at: nextState.enrollment_state?.started_at ?? this.currentIsoTs(),
      stopped_at: null,
      participants: progress,
      updated_at: this.currentIsoTs()
    };
    this.refreshEnrollmentMode(nextState);
    await this.ctx.storage.put(STORAGE_KEY_STATE, nextState);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
    if (enrollCall.degraded) {
      await this.appendSpeakerEvent({
        ts: this.currentIsoTs(),
        stream_role: "students",
        source: "inference_resolve",
        identity_source: "enrollment_match",
        utterance_id: utterance.utterance_id,
        cluster_id: resolved?.cluster_id ?? null,
        speaker_name: participantName,
        decision: "confirm",
        note: "enrollment call used secondary inference backend",
        backend: enrollCall.backend,
        fallback_reason: "inference_failover",
        confidence_bucket: "medium",
        metadata: {
          warnings: enrollCall.warnings,
          timeline: enrollCall.timeline
        }
      });
    }
  }

  private resolveTeacherIdentity(state: SessionState, asrText: string): { speakerName: string; identitySource: NonNullable<SpeakerEvent["identity_source"]> } {
    const roster = state.roster ?? [];
    const config = state.config ?? {};
    const configTeamsName = valueAsString(config.teams_interviewer_name);
    const configInterviewerName = valueAsString(config.interviewer_name);

    if (roster.length > 0) {
      if (configTeamsName) {
        const matched = roster.find((item) => item.name.trim().toLowerCase() === configTeamsName.trim().toLowerCase());
        if (matched) {
          return { speakerName: matched.name, identitySource: "teams_participants" };
        }
      }
      if (configInterviewerName) {
        const matched = roster.find((item) => item.name.trim().toLowerCase() === configInterviewerName.trim().toLowerCase());
        if (matched) {
          return { speakerName: matched.name, identitySource: "teams_participants" };
        }
      }
      if (roster.length === 1) {
        return { speakerName: roster[0].name, identitySource: "teams_participants" };
      }
    }

    if (configTeamsName) {
      return { speakerName: configTeamsName, identitySource: "preconfig" };
    }
    if (configInterviewerName) {
      return { speakerName: configInterviewerName, identitySource: "preconfig" };
    }

    const extracted = extractNameFromText(asrText);
    if (extracted) {
      return { speakerName: extracted, identitySource: "name_extract" };
    }
    return { speakerName: "teacher", identitySource: "teacher" };
  }

  private async appendTeacherSpeakerEvent(sessionId: string, utterance: UtteranceRaw): Promise<void> {
    if (!utterance.text.trim()) {
      return;
    }

    const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const identity = this.resolveTeacherIdentity(state, utterance.text);

    await this.appendSpeakerEvent({
      ts: new Date().toISOString(),
      stream_role: "teacher",
      source: "teacher_direct",
      identity_source: identity.identitySource,
      utterance_id: utterance.utterance_id,
      cluster_id: "teacher",
      speaker_name: identity.speakerName,
      decision: "auto",
      evidence: null,
      note: `teacher direct bind for session ${sessionId}`,
      backend: "worker",
      fallback_reason: null,
      confidence_bucket: "high"
    });
  }

  private async maybeRunAsrWindows(
    sessionId: string,
    streamRole: StreamRole,
    force = false,
    maxWindows = 0
  ): Promise<AsrRunResult> {
    const asrByStream = await this.loadAsrByStream();
    const asrState = asrByStream[streamRole];
    asrState.mode = "windowed";
    asrState.asr_ws_state = "disconnected";
    const utterancesByStream = await this.loadUtterancesRawByStream();
    const utterances = utterancesByStream[streamRole];

    if (!asrState.enabled) {
      asrState.last_error = "ASR disabled or API key missing";
      asrByStream[streamRole] = asrState;
      await this.storeAsrByStream(asrByStream);
      return {
        generated: 0,
        last_window_end_seq: asrState.last_window_end_seq,
        utterance_count: utterances.length,
        total_windows_processed: asrState.total_windows_processed,
        total_audio_seconds_processed: asrState.total_audio_seconds_processed,
        last_window_latency_ms: asrState.last_window_latency_ms ?? null,
        avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
        avg_rtf: asrState.avg_rtf ?? null,
        last_error: asrState.last_error
      };
    }

    if (this.asrProcessingByStream[streamRole] && !force) {
      return {
        generated: 0,
        last_window_end_seq: asrState.last_window_end_seq,
        utterance_count: utterances.length,
        total_windows_processed: asrState.total_windows_processed,
        total_audio_seconds_processed: asrState.total_audio_seconds_processed,
        last_window_latency_ms: asrState.last_window_latency_ms ?? null,
        avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
        avg_rtf: asrState.avg_rtf ?? null,
        last_error: asrState.last_error ?? null
      };
    }

    const nowMs = Date.now();
    if (!force && asrState.next_retry_after_ms > nowMs) {
      return {
        generated: 0,
        last_window_end_seq: asrState.last_window_end_seq,
        utterance_count: utterances.length,
        total_windows_processed: asrState.total_windows_processed,
        total_audio_seconds_processed: asrState.total_audio_seconds_processed,
        last_window_latency_ms: asrState.last_window_latency_ms ?? null,
        avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
        avg_rtf: asrState.avg_rtf ?? null,
        last_error: asrState.last_error ?? null
      };
    }

    this.asrProcessingByStream[streamRole] = true;
    let generated = 0;

    try {
      const ingestByStream = await this.loadIngestByStream(sessionId);
      const ingest = ingestByStream[streamRole];
      let nextEndSeq = Math.max(asrState.last_window_end_seq + asrState.hop_seconds, asrState.window_seconds);

      while (nextEndSeq <= ingest.last_seq && (maxWindows <= 0 || generated < maxWindows)) {
        const startSeq = nextEndSeq - asrState.window_seconds + 1;
        const chunkRange = await this.loadChunkRange(sessionId, streamRole, startSeq, nextEndSeq);
        const pcm = concatUint8Arrays(chunkRange);
        const wavBytes = pcm16ToWavBytes(pcm);
        let result: { text: string; latencyMs: number };
        const asrProviderType = this.getAsrProvider();
        if (asrProviderType === "local-whisper" && this.localWhisperProvider) {
          result = await this.localWhisperProvider.transcribeWindow(wavBytes);
        } else {
          result = await this.runFunAsrDashScope(wavBytes, asrState.model);
        }

        const createdAt = new Date().toISOString();
        const startMs = (startSeq - 1) * 1000;
        const endMs = nextEndSeq * 1000;

        const utterance: UtteranceRaw = {
          utterance_id: `${sessionId}-${streamRole}-${String(nextEndSeq).padStart(8, "0")}`,
          session_id: sessionId,
          stream_role: streamRole,
          text: result.text,
          start_seq: startSeq,
          end_seq: nextEndSeq,
          start_ms: startMs,
          end_ms: endMs,
          duration_ms: endMs - startMs,
          asr_model: asrState.model,
          asr_provider: asrProviderType === "local-whisper" ? "local-whisper" : "dashscope",
          confidence: null,
          created_at: createdAt,
          latency_ms: result.latencyMs
        };
        utterances.push(utterance);

        generated += 1;
        asrState.total_windows_processed += 1;
        asrState.total_audio_seconds_processed += asrState.window_seconds;
        asrState.last_window_latency_ms = result.latencyMs;

        const processed = asrState.total_windows_processed;
        if (!asrState.avg_window_latency_ms || asrState.avg_window_latency_ms <= 0) {
          asrState.avg_window_latency_ms = result.latencyMs;
        } else {
          asrState.avg_window_latency_ms =
            (asrState.avg_window_latency_ms * (processed - 1) + result.latencyMs) / processed;
        }

        const windowDurationMs = asrState.window_seconds * 1000;
        const currentRtf = windowDurationMs > 0 ? result.latencyMs / windowDurationMs : 0;
        if (!asrState.avg_rtf || asrState.avg_rtf <= 0) {
          asrState.avg_rtf = currentRtf;
        } else {
          asrState.avg_rtf = (asrState.avg_rtf * (processed - 1) + currentRtf) / processed;
        }

        asrState.last_window_end_seq = nextEndSeq;
        asrState.utterance_count = utterances.length;
        asrState.last_error = null;
        asrState.last_success_at = createdAt;
        asrState.consecutive_failures = 0;
        asrState.next_retry_after_ms = 0;

        if (streamRole === "students") {
          try {
            await this.autoResolveStudentsUtterance(sessionId, utterance, wavBytes);
          } catch (error) {
            const inferenceError = error instanceof InferenceRequestError ? error : null;
            await this.appendSpeakerEvent({
              ts: new Date().toISOString(),
              stream_role: "students",
              source: "inference_resolve",
              utterance_id: utterance.utterance_id,
              cluster_id: null,
              speaker_name: null,
              decision: "unknown",
              evidence: null,
              note: `students auto-resolve failed: ${(error as Error).message}`,
              backend: inferenceError ? inferenceError.health.active_backend : "primary",
              fallback_reason: inferenceError ? "resolve_all_backends_failed" : null,
              confidence_bucket: "unknown",
              metadata: {
                timeline: inferenceError?.timeline ?? null
              }
            });
          }
        } else if (streamRole === "teacher") {
          await this.appendTeacherSpeakerEvent(sessionId, utterance);
        }

        // Persist state after every window to keep the DO I/O gate alive
        // and prevent "Promise will never complete" in workerd runtime
        asrByStream[streamRole] = asrState;
        await this.storeAsrByStream(asrByStream);
        utterancesByStream[streamRole] = utterances;
        await this.storeUtterancesRawByStream(utterancesByStream);

        if (generated % 5 === 0) {
          console.log(`[asr] ${streamRole} progress: ${generated} windows, last_seq=${nextEndSeq}/${ingest.last_seq}`);
        }

        nextEndSeq += asrState.hop_seconds;
      }

      // Final merge after all windows
      const mergedByStream = await this.loadUtterancesMergedByStream();
      mergedByStream[streamRole] = mergeUtterances(utterances);
      await this.storeUtterancesMergedByStream(mergedByStream);

      return {
        generated,
        last_window_end_seq: asrState.last_window_end_seq,
        utterance_count: utterances.length,
        total_windows_processed: asrState.total_windows_processed,
        total_audio_seconds_processed: asrState.total_audio_seconds_processed,
        last_window_latency_ms: asrState.last_window_latency_ms ?? null,
        avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
        avg_rtf: asrState.avg_rtf ?? null,
        last_error: asrState.last_error ?? null
      };
    } catch (error) {
      asrState.consecutive_failures += 1;
      asrState.last_error = (error as Error).message;
      const backoffMs = Math.min(60_000, 1000 * 2 ** Math.min(asrState.consecutive_failures, 6));
      asrState.next_retry_after_ms = Date.now() + backoffMs;
      asrByStream[streamRole] = asrState;
      await this.storeAsrByStream(asrByStream);

      // Persist any utterances successfully transcribed before the error
      if (generated > 0) {
        utterancesByStream[streamRole] = utterances;
        await this.storeUtterancesRawByStream(utterancesByStream);
        const mergedByStream = await this.loadUtterancesMergedByStream();
        mergedByStream[streamRole] = mergeUtterances(utterances);
        await this.storeUtterancesMergedByStream(mergedByStream);
        console.log(`[asr] persisted ${generated} partial utterances for ${streamRole} despite error: ${(error as Error).message}`);
      }

      return {
        generated,
        last_window_end_seq: asrState.last_window_end_seq,
        utterance_count: utterances.length,
        total_windows_processed: asrState.total_windows_processed,
        total_audio_seconds_processed: asrState.total_audio_seconds_processed,
        last_window_latency_ms: asrState.last_window_latency_ms ?? null,
        avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
        avg_rtf: asrState.avg_rtf ?? null,
        last_error: asrState.last_error
      };
    } finally {
      this.asrProcessingByStream[streamRole] = false;
    }
  }

  private async updateFinalizeV2Status(jobId: string, patch: Partial<FinalizeV2Status>): Promise<FinalizeV2Status | null> {
    const current = await this.loadFinalizeV2Status();
    if (!current || current.job_id !== jobId) return null;
    if (this.isFinalizeTerminal(current.status) && patch.status !== current.status) {
      return null;
    }
    const nowIso = this.currentIsoTs();
    const next: FinalizeV2Status = {
      ...current,
      ...patch,
      errors: patch.errors ?? current.errors,
      warnings: patch.warnings ?? current.warnings,
      degraded: patch.degraded ?? current.degraded,
      backend_used: patch.backend_used ?? current.backend_used,
      started_at: current.started_at ?? nowIso,
      heartbeat_at: patch.heartbeat_at ?? nowIso
    };
    await this.storeFinalizeV2Status(next);
    return next;
  }

  private async invokeInferenceAnalysisEvents(payload: Record<string, unknown>): Promise<{
    events: Record<string, unknown>[];
    backend_used: "primary" | "secondary" | "local";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
    fallback_reason: string | null;
  }> {
    const path = this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "15000");
    try {
      const response = await this.callInferenceWithFailover<{ events?: Record<string, unknown>[] }>({
        endpoint: "analysis_events",
        path,
        timeoutMs,
        body: payload
      });
      const events = Array.isArray(response.data?.events) ? response.data.events : [];
      return {
        events,
        backend_used: response.backend,
        degraded: response.degraded,
        warnings: response.warnings,
        timeline: response.timeline,
        fallback_reason: null
      };
    } catch (error) {
      if (!(error instanceof InferenceRequestError)) {
        throw error;
      }
      const sessionId = String(payload.session_id ?? "unknown-session");
      const transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
      const memos = Array.isArray(payload.memos) ? payload.memos : [];
      const stats = Array.isArray(payload.stats) ? payload.stats : [];
      const localEvents = analyzeEventsLocally({
        sessionId,
        transcript: transcript as Array<{
          utterance_id: string;
          stream_role: "mixed" | "teacher" | "students";
          cluster_id?: string | null;
          speaker_name?: string | null;
          text: string;
          start_ms: number;
          end_ms: number;
          duration_ms: number;
        }>,
        memos: memos as Array<{
          memo_id: string;
          created_at_ms: number;
          type: "observation" | "evidence" | "question" | "decision" | "score";
          text: string;
          anchors?: { mode: "time" | "utterance"; time_range_ms?: [number, number]; utterance_ids?: string[] };
        }>,
        stats: stats as Array<{ speaker_key: string; talk_time_ms: number; turns: number }>
      });
      const warning = `analysis/events fallback local analyzer: ${error.message}`;
      return {
        events: localEvents as unknown as Record<string, unknown>[],
        backend_used: "local",
        degraded: true,
        warnings: [warning],
        timeline: error.timeline,
        fallback_reason: "analysis_events_all_backends_failed"
      };
    }
  }

  private async invokeInferenceAnalysisReport(payload: Record<string, unknown>): Promise<{
    data: Record<string, unknown>;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const path = this.env.INFERENCE_REPORT_PATH ?? "/analysis/report";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "15000");
    const response = await this.callInferenceWithFailover<Record<string, unknown>>({
      endpoint: "analysis_report",
      path,
      timeoutMs,
      body: payload
    });
    return {
      data: response.data,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private async invokeInferenceSynthesizeReport(payload: SynthesizeRequestPayload): Promise<{
    data: Record<string, unknown>;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const path = this.env.INFERENCE_SYNTHESIZE_PATH ?? "/analysis/synthesize";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "45000");
    const response = await this.callInferenceWithFailover<Record<string, unknown>>({
      endpoint: "analysis_synthesize",
      path,
      timeoutMs,
      body: payload
    });
    return {
      data: response.data,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private async invokeInferenceCheckpoint(payload: CheckpointRequestPayload): Promise<{
    data: CheckpointResult;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const path = this.env.INFERENCE_CHECKPOINT_PATH ?? "/analysis/checkpoint";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "30000");
    const response = await this.callInferenceWithFailover<CheckpointResult>({
      endpoint: "analysis_checkpoint",
      path,
      timeoutMs,
      body: payload
    });
    return {
      data: response.data,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private async invokeInferenceMergeCheckpoints(payload: MergeCheckpointsRequestPayload): Promise<{
    data: Record<string, unknown>;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const path = this.env.INFERENCE_MERGE_CHECKPOINTS_PATH ?? "/analysis/merge-checkpoints";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "45000");
    const response = await this.callInferenceWithFailover<Record<string, unknown>>({
      endpoint: "analysis_merge_checkpoints",
      path,
      timeoutMs,
      body: payload
    });
    return {
      data: response.data,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private async loadCheckpoints(): Promise<CheckpointResult[]> {
    return (await this.ctx.storage.get<CheckpointResult[]>(STORAGE_KEY_CHECKPOINTS)) ?? [];
  }

  private async storeCheckpoints(checkpoints: CheckpointResult[]): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_CHECKPOINTS, checkpoints);
  }

  private async loadLastCheckpointAt(): Promise<number> {
    return (await this.ctx.storage.get<number>(STORAGE_KEY_LAST_CHECKPOINT_AT)) ?? 0;
  }

  private async storeLastCheckpointAt(ms: number): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_LAST_CHECKPOINT_AT, ms);
  }

  private checkpointIntervalMs(): number {
    return parseInt(this.env.CHECKPOINT_INTERVAL_MS ?? "300000", 10);
  }

  /**
   * Schedule a checkpoint if enough time has elapsed since the last one.
   * Runs asynchronously after each utterance — failures are logged but do not
   * block the ASR pipeline.
   */
  private async maybeScheduleCheckpoint(
    sessionId: string,
    latestUtteranceEndMs: number,
    streamRole: StreamRole
  ): Promise<void> {
    // Only schedule checkpoints for student utterances (the interview content)
    if (streamRole !== "students") return;

    const intervalMs = this.checkpointIntervalMs();
    if (intervalMs <= 0) return; // disabled

    const lastCheckpointAt = await this.loadLastCheckpointAt();
    if (latestUtteranceEndMs - lastCheckpointAt < intervalMs) return;

    try {
      const checkpoints = await this.loadCheckpoints();
      const checkpointIndex = checkpoints.length;

      // Gather recent utterances (since last checkpoint)
      const utterancesByStream = await this.loadUtterancesRawByStream();
      const allUtterances = [
        ...utterancesByStream.teacher,
        ...utterancesByStream.students,
      ].sort((a, b) => a.start_ms - b.start_ms);

      const recentUtterances = allUtterances.filter(
        (u) => u.end_ms > lastCheckpointAt
      );

      if (recentUtterances.length === 0) return;

      // Gather recent memos
      const memos = (await this.ctx.storage.get<MemoItem[]>(STORAGE_KEY_MEMOS)) ?? [];
      const recentMemos = memos.filter(
        (m) => m.created_at_ms > lastCheckpointAt
      );

      // Build stats from recent utterances
      const transcript: TranscriptItem[] = recentUtterances.map((u) => ({
        utterance_id: u.utterance_id,
        stream_role: u.stream_role as TranscriptItem["stream_role"],
        cluster_id: null,
        speaker_name: null,
        decision: null,
        text: u.text,
        start_ms: u.start_ms,
        end_ms: u.end_ms,
        duration_ms: u.duration_ms,
      }));
      const stats = computeSpeakerStats(transcript);

      const locale = (this.env.DEFAULT_LOCALE ?? "zh-CN");

      const payload: CheckpointRequestPayload = {
        session_id: sessionId,
        checkpoint_index: checkpointIndex,
        utterances: transcript.map((t) => ({
          utterance_id: t.utterance_id,
          stream_role: t.stream_role,
          speaker_name: t.speaker_name ?? null,
          cluster_id: t.cluster_id ?? null,
          decision: t.decision ?? null,
          text: t.text,
          start_ms: t.start_ms,
          end_ms: t.end_ms,
          duration_ms: t.duration_ms,
        })),
        memos: recentMemos,
        stats,
        locale,
      };

      const result = await this.invokeInferenceCheckpoint(payload);
      checkpoints.push(result.data);
      await this.storeCheckpoints(checkpoints);
      await this.storeLastCheckpointAt(latestUtteranceEndMs);

      console.log(
        `[checkpoint] session=${sessionId} index=${checkpointIndex} utterances=${recentUtterances.length} stored OK`
      );
    } catch (error) {
      // Checkpoint failures are non-fatal — log and continue
      console.error(
        `[checkpoint] session=${sessionId} failed:`,
        (error as Error).message
      );
    }
  }

  private async invokeInferenceRegenerateClaim(payload: InferenceRegenerateClaimRequest): Promise<{
    data: InferenceRegenerateClaimResponse;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }> {
    const path = this.env.INFERENCE_REGENERATE_CLAIM_PATH ?? "/analysis/regenerate-claim";
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "15000");
    const response = await this.callInferenceWithFailover<InferenceRegenerateClaimResponse>({
      endpoint: "analysis_regenerate_claim",
      path,
      timeoutMs,
      body: payload
    });
    return {
      data: response.data,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline
    };
  }

  private deriveSpeakerLogsFromTranscript(
    nowIso: string,
    transcript: Array<{
      utterance_id: string;
      stream_role: StreamRole;
      cluster_id?: string | null;
      speaker_name?: string | null;
      text: string;
      start_ms: number;
      end_ms: number;
      duration_ms: number;
      decision?: "auto" | "confirm" | "unknown" | null;
    }>,
    state: SessionState,
    existing: SpeakerLogs,
    source: "cloud" | "edge" = "cloud"
  ): SpeakerLogs {
    const turns = transcript
      .filter((item) => item.stream_role === "students" && item.cluster_id)
      .map((item) => ({
        turn_id: `turn_${item.utterance_id}`,
        start_ms: item.start_ms,
        end_ms: item.end_ms,
        stream_role: "students" as StreamRole,
        cluster_id: item.cluster_id as string,
        utterance_id: item.utterance_id
      }));

    const clusterMap = new Map<string, Set<string>>();
    for (const turn of turns) {
      const bucket = clusterMap.get(turn.cluster_id) ?? new Set<string>();
      bucket.add(turn.turn_id);
      clusterMap.set(turn.cluster_id, bucket);
    }
    const clusters = [...clusterMap.entries()].map(([clusterId, turnIds]) => ({
      cluster_id: clusterId,
      turn_ids: [...turnIds],
      confidence: null
    }));
    const speaker_map = [...clusterMap.keys()].map((clusterId) => {
      const meta = state.cluster_binding_meta[clusterId];
      const metaName = valueAsString(meta?.participant_name);
      const bound = state.bindings[clusterId] ?? (metaName || null);
      const source: "manual" | "enroll" | "name_extract" | "unknown" =
        meta?.source === "manual_map"
          ? "manual"
          : meta?.source === "enrollment_match"
            ? "enroll"
            : meta?.source === "name_extract"
              ? "name_extract"
              : "unknown";
      return {
        cluster_id: clusterId,
        person_id: bound,
        display_name: bound,
        source
      };
    });

    return mergeSpeakerLogs(
      existing,
      {
        source,
        turns,
        clusters,
        speaker_map,
        updated_at: nowIso
      }
    );
  }

  private buildEdgeSpeakerLogsForFinalize(nowIso: string, existing: SpeakerLogs, state: SessionState): SpeakerLogs {
    const base = existing.source === "edge" ? existing : emptySpeakerLogs(nowIso);
    const clusterIds = new Set<string>();
    for (const item of base.clusters) {
      clusterIds.add(item.cluster_id);
    }
    for (const item of base.turns) {
      clusterIds.add(item.cluster_id);
    }

    const mapByCluster = new Map(
      (Array.isArray(base.speaker_map) ? base.speaker_map : []).map((item) => [item.cluster_id, item])
    );
    for (const clusterId of clusterIds) {
      const meta = state.cluster_binding_meta[clusterId];
      const metaName = valueAsString(meta?.participant_name);
      const mapName = valueAsString(mapByCluster.get(clusterId)?.display_name ?? mapByCluster.get(clusterId)?.person_id);
      const bound = state.bindings[clusterId] ?? (metaName || mapName || null);
      const source: "manual" | "enroll" | "name_extract" | "unknown" =
        meta?.source === "manual_map"
          ? "manual"
          : meta?.source === "enrollment_match"
            ? "enroll"
            : meta?.source === "name_extract"
              ? "name_extract"
              : (mapByCluster.get(clusterId)?.source ?? "unknown");
      mapByCluster.set(clusterId, {
        cluster_id: clusterId,
        person_id: bound,
        display_name: bound,
        source
      });
    }

    return {
      ...base,
      source: "edge",
      speaker_map: [...mapByCluster.values()],
      updated_at: nowIso
    };
  }

  private async runFinalizeV2Job(
    sessionId: string,
    jobId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const finalizeWarnings: string[] = [];
    const backendTimeline: InferenceBackendTimelineItem[] = [];
    let finalizeBackendUsed: FinalizeV2Status["backend_used"] = "primary";
    let finalizeDegraded = false;

    const startedAt = this.currentIsoTs();
    await this.updateFinalizeV2Status(jobId, {
      status: "running",
      stage: "freeze",
      progress: 5,
      started_at: startedAt,
      warnings: [],
      degraded: false,
      backend_used: "primary"
    });
    await this.setFinalizeLock(true);

    try {
      await this.ensureFinalizeJobActive(jobId);
      const timeoutMs = this.finalizeTimeoutMs();
      const ingestByStream = await this.loadIngestByStream(sessionId);
      const cutoff = {
        mixed: ingestByStream.mixed.last_seq,
        teacher: ingestByStream.teacher.last_seq,
        students: ingestByStream.students.last_seq
      };

      // ── Caption mode: skip audio-dependent stages ──
      const useCaptions = this.captionSource === 'acs-teams' && this.captionBuffer.length > 0;

      if (!useCaptions) {
      // ── Drain ASR queues (non-fatal) ──
      // Drain is best-effort: if DashScope ASR is unreachable, we continue with
      // whatever transcript data we already have. This prevents external service
      // outages from blocking the entire finalization pipeline.
      await this.updateFinalizeV2Status(jobId, { stage: "drain", progress: 18 });
      await this.ensureFinalizeJobActive(jobId);
      const drainTimeoutMs = Math.min(timeoutMs, 30_000); // cap drain at 30s
      const drainWithTimeout = async (streamRole: StreamRole): Promise<void> => {
        await Promise.race([
          this.drainRealtimeQueue(sessionId, streamRole),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`drain timeout stream=${streamRole}`)), drainTimeoutMs);
          })
        ]);
      };
      try {
        await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);
      } catch (drainErr) {
        console.warn(`[finalize-v2] drain failed (non-fatal), continuing: ${(drainErr as Error).message}`);
        finalizeWarnings.push(`drain degraded: ${(drainErr as Error).message}`);
        finalizeDegraded = true;
      }

      await this.updateFinalizeV2Status(jobId, { stage: "replay_gap", progress: 30 });
      await this.ensureFinalizeJobActive(jobId);
      try {
        await Promise.all([this.replayGapFromR2(sessionId, "teacher"), this.replayGapFromR2(sessionId, "students")]);
        await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);
      } catch (replayErr) {
        console.warn(`[finalize-v2] replay/drain failed (non-fatal), continuing: ${(replayErr as Error).message}`);
        finalizeWarnings.push(`replay degraded: ${(replayErr as Error).message}`);
        finalizeDegraded = true;
      }

      // Force-close ASR sessions and clear queues to prevent orphaned drain loops
      await this.closeRealtimeAsrSession("teacher", "finalize-v2", true, false);
      await this.closeRealtimeAsrSession("students", "finalize-v2", true, false);
      await this.refreshAsrStreamMetrics(sessionId, "teacher");
      await this.refreshAsrStreamMetrics(sessionId, "students");
      } // end if (!useCaptions) — drain/replay/close

      // ── Windowed ASR for local-whisper (drain/replay only applies to FunASR realtime) ──
      // When using local-whisper, audio is NOT streamed to a realtime ASR WebSocket during
      // recording. Instead, we must run windowed transcription on all stored audio now.
      if (!useCaptions && this.getAsrProvider() === "local-whisper") {
        await this.updateFinalizeV2Status(jobId, { stage: "local_asr", progress: 25 });
        await this.ensureFinalizeJobActive(jobId);
        try {
          // Log diagnostic info before running windowed ASR
          const diagIngest = await this.loadIngestByStream(sessionId);
          const diagAsr = await this.loadAsrByStream();
          console.log(`[finalize-v2] local-whisper pre-check: teacher.last_seq=${diagIngest.teacher.last_seq} students.last_seq=${diagIngest.students.last_seq} asr_enabled=${diagAsr.students.enabled} window_seconds=${diagAsr.students.window_seconds}`);

          // Process each stream sequentially, in small batches (BATCH_SIZE windows)
          // with heartbeat updates between batches. This prevents the DO from being
          // evicted during long ASR processing (each window takes ~10s).
          const BATCH_SIZE = 5;
          const MAX_CONSECUTIVE_FAILURES = 5;
          let totalGenerated = 0;

          for (const role of ["teacher", "students"] as const) {
            const ingest = role === "teacher" ? diagIngest.teacher : diagIngest.students;
            if (ingest.last_seq <= 0) {
              console.log(`[finalize-v2] local-whisper skip ${role}: no audio (last_seq=${ingest.last_seq})`);
              continue;
            }

            const estimatedWindows = Math.floor(ingest.last_seq / (diagAsr[role].hop_seconds || 10));
            console.log(`[finalize-v2] local-whisper starting ${role}: ~${estimatedWindows} windows`);
            let roleGenerated = 0;
            let roleFailures = 0;

            while (true) {
              // Update heartbeat and progress before each batch
              const progressPct = estimatedWindows > 0
                ? Math.min(45, 25 + Math.round((roleGenerated / estimatedWindows) * 20))
                : 25;
              await this.updateFinalizeV2Status(jobId, { stage: "local_asr", progress: progressPct });
              await this.ensureFinalizeJobActive(jobId);

              // Reset failures before each batch so backoff guard doesn't block
              const asrByStream = await this.loadAsrByStream();
              asrByStream[role].consecutive_failures = 0;
              asrByStream[role].next_retry_after_ms = 0;
              await this.storeAsrByStream(asrByStream);

              const result = await this.maybeRunAsrWindows(sessionId, role, true, BATCH_SIZE);

              if (result.generated > 0) {
                roleGenerated += result.generated;
                totalGenerated += result.generated;
                roleFailures = 0;
                console.log(`[finalize-v2] local-whisper ${role} batch: +${result.generated} (total=${roleGenerated}/${estimatedWindows}, last_seq=${result.last_window_end_seq})`);
              } else if (result.last_error) {
                roleFailures += 1;
                console.warn(`[finalize-v2] local-whisper ${role} error (${roleFailures}/${MAX_CONSECUTIVE_FAILURES}): ${result.last_error}`);
                if (roleFailures >= MAX_CONSECUTIVE_FAILURES) {
                  console.warn(`[finalize-v2] local-whisper ${role}: too many failures, stopping`);
                  finalizeWarnings.push(`local-whisper ${role}: stopped after ${roleFailures} consecutive failures`);
                  break;
                }
                await new Promise((r) => setTimeout(r, 3000));
              } else {
                // No error and no generated = all windows done for this stream
                console.log(`[finalize-v2] local-whisper ${role} complete: ${roleGenerated} windows`);
                break;
              }
            }
          }

          console.log(`[finalize-v2] local-whisper completed: ${totalGenerated} total windows transcribed`);
          if (totalGenerated === 0) {
            finalizeWarnings.push("local-whisper produced 0 utterances");
          }
        } catch (localAsrErr) {
          console.warn(`[finalize-v2] local-whisper ASR failed (non-fatal): ${(localAsrErr as Error).message}`);
          finalizeWarnings.push(`local-whisper degraded: ${(localAsrErr as Error).message}`);
          finalizeDegraded = true;
        }
      }

      // ── Merge finalize metadata into storage (memos, free_form_notes) ──
      // Desktop may send memos/notes in finalize metadata as a convenience.
      // Merge them into DO storage so the pipeline can read them uniformly.
      if (Array.isArray((metadata as Record<string, unknown>)?.memos)) {
        const incomingMemos = (metadata as Record<string, unknown>).memos as Array<Record<string, unknown>>;
        const existingMemos = await this.loadMemos();
        const existingIds = new Set(existingMemos.map((m) => m.memo_id));
        for (const raw of incomingMemos) {
          const memoId = typeof raw.memo_id === "string" ? raw.memo_id : `m_meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          if (existingIds.has(memoId)) continue;
          existingMemos.push({
            memo_id: memoId,
            created_at_ms: typeof raw.created_at_ms === "number" ? raw.created_at_ms : Date.now(),
            author_role: "teacher",
            type: (["observation", "evidence", "question", "decision", "score"].includes(raw.type as string) ? raw.type : "observation") as MemoItem["type"],
            tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
            text: typeof raw.text === "string" ? raw.text : "",
            stage: typeof raw.stage === "string" ? raw.stage : undefined,
            stage_index: typeof raw.stage_index === "number" ? raw.stage_index : undefined,
          });
          existingIds.add(memoId);
        }
        await this.storeMemos(existingMemos);
      }
      if (typeof (metadata as Record<string, unknown>)?.free_form_notes === "string") {
        const preState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const cfg = { ...(preState.config ?? {}) } as Record<string, unknown>;
        cfg.free_form_notes = (metadata as Record<string, unknown>).free_form_notes;
        preState.config = cfg;
        await this.ctx.storage.put(STORAGE_KEY_STATE, preState);
      }

      // ── Global clustering stage ──
      // If edge diarization is active, extract any missing embeddings from R2
      // audio and run global agglomerative clustering to produce consistent
      // speaker IDs across the entire session.
      // Caption mode skips clustering: Teams provides speaker identity directly.
      let globalClusterResult: GlobalClusterResult | null = null;
      let clusterRosterMapping: Map<string, string> | null = null;
      if (!useCaptions) {
      await this.updateFinalizeV2Status(jobId, { stage: "cluster", progress: 36 });
      await this.ensureFinalizeJobActive(jobId);
      {
        const preState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const preDiarizationBackend = preState.config?.diarization_backend === "edge" ? "edge" : "cloud";
        if (preDiarizationBackend === "edge") {
          try {
            // Extract missing embeddings for any turns not yet in the cache
            const preSpeakerLogs = await this.loadSpeakerLogs();
            if (this.embeddingCache.size === 0 && preSpeakerLogs.turns.length > 0) {
              await this.extractEmbeddingsForTurns(sessionId, preSpeakerLogs, "students");
            }

            const embeddings = this.embeddingCache.getAllEmbeddings();
            if (embeddings.length >= 2) {
              globalClusterResult = globalCluster(embeddings, {
                distance_threshold: 0.3,
                linkage: "average",
                min_cluster_size: 1
              });

              // Build roster participants with enrollment embeddings for mapping
              const rosterParticipants: RosterParticipant[] = (preState.roster ?? []).map((r) => {
                const profile = (preState.participant_profiles ?? []).find(
                  (p) => p.name === r.name
                );
                return {
                  name: r.name,
                  enrollment_embedding: profile?.centroid?.length
                    ? new Float32Array(profile.centroid)
                    : undefined
                };
              });

              clusterRosterMapping = mapClustersToRoster(globalClusterResult, rosterParticipants, 0.65);
              console.log(
                `[finalize-v2] global clustering: ${embeddings.length} embeddings → ${globalClusterResult.clusters.size} clusters, confidence=${globalClusterResult.confidence.toFixed(2)}`
              );
            } else if (embeddings.length > 0) {
              console.log(`[finalize-v2] only ${embeddings.length} embedding(s), skipping clustering`);
            }
          } catch (clusterErr) {
            console.warn(`[finalize-v2] clustering failed (non-fatal): ${(clusterErr as Error).message}`);
            finalizeWarnings.push(`clustering degraded: ${(clusterErr as Error).message}`);
            finalizeDegraded = true;
          }
        }
      }
      } // end if (!useCaptions) — clustering

      await this.updateFinalizeV2Status(jobId, { stage: "reconcile", progress: 42 });
      await this.ensureFinalizeJobActive(jobId);

      let transcript: TranscriptItem[];
      let state: SessionState;
      let memos: MemoItem[];
      let locale: string;
      let diarizationBackend: "cloud" | "edge";
      let speakerLogsStored: SpeakerLogs;
      let confidenceLevel: "high" | "medium" | "low";
      let tentative: boolean;
      let speakerLogs: SpeakerLogs;
      let unresolvedClusterCount: number;
      let asrByStream: Record<StreamRole, AsrState>;

      if (useCaptions) {
        // ── Caption mode: build transcript from captionBuffer ──
        const captionAsr = new ACSCaptionASRProvider();
        const captionDia = new ACSCaptionDiarizationProvider();
        const utterances = captionAsr.convertToUtterances(this.captionBuffer);
        const resolved = captionDia.resolveCaptions(this.captionBuffer);
        const speakerMap = captionDia.getSpeakerMap();

        state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        memos = await this.loadMemos();
        speakerLogsStored = await this.loadSpeakerLogs();
        locale = getSessionLocale(state, this.env);
        diarizationBackend = "cloud"; // caption mode doesn't use edge diarization

        // Build transcript from caption utterances
        transcript = utterances.map((u, i) => ({
          utterance_id: u.id,
          stream_role: "students" as const, // captions are from remote participants
          cluster_id: resolved[i]?.speaker_id ?? null,
          speaker_name: resolved[i]?.speaker_name ?? null,
          decision: "auto" as const,
          text: u.text,
          start_ms: u.start_ms,
          end_ms: u.end_ms,
          duration_ms: u.end_ms - u.start_ms,
        }));

        // Update state with caption speaker bindings
        for (const [displayName, speakerId] of Object.entries(speakerMap)) {
          state.bindings[speakerId] = displayName;
          state.cluster_binding_meta[speakerId] = {
            participant_name: displayName,
            source: "name_extract",
            confidence: 0.95,
            locked: true,
            updated_at: new Date().toISOString(),
          };
        }

        // Caption mode: all speakers are identified by Teams, so confidence is always high
        confidenceLevel = "high";
        tentative = false;
        unresolvedClusterCount = 0;
        asrByStream = await this.loadAsrByStream();

        // Build speaker logs from caption transcript
        const cloudBase = speakerLogsStored.source === "cloud" ? speakerLogsStored : emptySpeakerLogs(this.currentIsoTs());
        speakerLogs = this.deriveSpeakerLogsFromTranscript(
          this.currentIsoTs(),
          transcript,
          state,
          cloudBase,
          "cloud"
        );
        await this.storeSpeakerLogs(speakerLogs);

        console.log(`[finalize-v2] caption mode: ${utterances.length} utterances from ${Object.keys(speakerMap).length} speakers`);
      } else {
        // ── Original audio-based reconciliation path ──
        const [stateRaw, events, rawByStream, mergedByStream, memosLoaded, speakerLogsLoaded, asrByStreamLoaded] = await Promise.all([
          this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
          this.loadSpeakerEvents(),
          this.loadUtterancesRawByStream(),
          this.loadUtterancesMergedByStream(),
          this.loadMemos(),
          this.loadSpeakerLogs(),
          this.loadAsrByStream()
        ]);
        state = normalizeSessionState(stateRaw);
        memos = memosLoaded;
        speakerLogsStored = speakerLogsLoaded;
        asrByStream = asrByStreamLoaded;
        locale = getSessionLocale(state, this.env);
        diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";

        const cutoffUtterances = [...rawByStream.teacher, ...rawByStream.students]
          .filter((item) => item.end_seq <= cutoff[item.stream_role]);
        transcript = buildReconciledTranscript({
          utterances: cutoffUtterances,
          events,
          speakerLogs: speakerLogsStored,
          state,
          diarizationBackend,
          roster: (state.roster ?? []).flatMap((r) => [r.name, ...(r.aliases ?? [])]),
          globalClusterResult,
          clusterRosterMapping,
          cachedEmbeddings: this.embeddingCache.getAllEmbeddings()
        });

        mergedByStream.teacher = mergeUtterances(rawByStream.teacher);
        mergedByStream.students = mergeUtterances(rawByStream.students);
        await this.storeUtterancesMergedByStream(mergedByStream);

        // ── Memo-assisted binding: resolve unidentified clusters using teacher notes ──
        const rosterNames = (state.roster ?? []).map(r => r.name).filter(Boolean);
        const memoBindResult = memoAssistedBinding({
          clusters: state.clusters.map(c => ({ cluster_id: c.cluster_id, turn_ids: [] })),
          bindings: state.bindings,
          bindingMeta: state.cluster_binding_meta,
          transcript,
          memos,
          roster: rosterNames,
        });
        for (const [clusterId, name] of Object.entries(memoBindResult.newBindings)) {
          state.bindings[clusterId] = name;
          state.cluster_binding_meta[clusterId] = {
            participant_name: name,
            source: "name_extract",
            confidence: 0.7,
            locked: false,
            updated_at: new Date().toISOString(),
          };
        }

        unresolvedClusterCount = state.clusters.filter((cluster) => {
          const bound = state.bindings[cluster.cluster_id];
          const meta = state.cluster_binding_meta[cluster.cluster_id];
          return !bound || !meta || !meta.locked;
        }).length;
        const totalClusters = state.clusters.length;
        const unresolvedRatio = totalClusters > 0 ? unresolvedClusterCount / totalClusters : 0;
        confidenceLevel =
          unresolvedRatio === 0 ? "high" :
          unresolvedRatio <= 0.25 ? "medium" : "low";
        tentative = confidenceLevel === "low";

        const hasStudentTranscript = transcript.some((item) => item.stream_role === "students");
        if (diarizationBackend === "edge") {
          if (hasStudentTranscript && speakerLogsStored.source !== "edge") {
            throw new Error("diarization_backend=edge requires edge speaker-logs source");
          }
          if (hasStudentTranscript && speakerLogsStored.turns.length === 0) {
            throw new Error("diarization_backend=edge requires non-empty edge speaker-logs turns");
          }
          speakerLogs = this.buildEdgeSpeakerLogsForFinalize(this.currentIsoTs(), speakerLogsStored, state);
        } else {
          const cloudBase = speakerLogsStored.source === "cloud" ? speakerLogsStored : emptySpeakerLogs(this.currentIsoTs());
          speakerLogs = this.deriveSpeakerLogsFromTranscript(
            this.currentIsoTs(),
            transcript,
            state,
            cloudBase,
            "cloud"
          );
        }
        await this.storeSpeakerLogs(speakerLogs);
      } // end if/else useCaptions reconcile

      await this.updateFinalizeV2Status(jobId, { stage: "stats", progress: 56 });
      const stats = this.mergeStatsWithRoster(computeSpeakerStats(transcript), state);

      // ── NEW PIPELINE: Extract names, build multi-evidence, stage metadata ──
      const knownSpeakers = stats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
      const memoBindings = extractMemoNames(memos, knownSpeakers);
      const configStages: string[] = (state.config as Record<string, unknown>)?.stages as string[] ?? [];
      const enrichedMemos = addStageMetadata(memos, configStages);
      let evidence = buildMultiEvidence({ memos: enrichedMemos, transcript, bindings: memoBindings });

      // ── Enrich evidence pack with transcript quotes, stats summaries, interaction patterns ──
      const enrichedEvidence = enrichEvidencePack(transcript, stats);
      evidence = [...evidence, ...enrichedEvidence];

      // ── Generate stats observations for LLM context ──
      const audioDurationMs = transcript.length > 0 ? Math.max(...transcript.map(u => u.end_ms)) : 0;
      const statsObservations = generateStatsObservations(stats, audioDurationMs);

      // Keep legacy evidence + memo-first as fallback baseline
      const legacyEvidence = buildEvidence({ memos, transcript });
      const memosWithEvidence = attachEvidenceToMemos(memos, legacyEvidence);
      const memoFirstStart = Date.now();
      const memoFirstReport = buildMemoFirstReport({
        transcript,
        memos: memosWithEvidence,
        evidence: legacyEvidence,
        stats
      });
      const memoFirstBuildMs = Date.now() - memoFirstStart;
      const validationStart = Date.now();
      const memoFirstStrictValidation = this.validateClaimEvidenceRefs({
        evidence: legacyEvidence,
        per_person: memoFirstReport.per_person
      } as ResultV2);
      const memoFirstValidation = validatePersonFeedbackEvidence(memoFirstReport.per_person);
      const validationMs = Date.now() - validationStart;
      if (!memoFirstValidation.valid || !memoFirstStrictValidation.valid) {
        // Non-fatal: memo-first baseline has invalid evidence refs (common when drain
        // was degraded). Continue to LLM synthesis which may produce valid refs.
        console.warn(
          `[finalize-v2] memo-first evidence validation failed (non-fatal): claims=${memoFirstStrictValidation.claimCount} invalid=${memoFirstStrictValidation.invalidCount}`
        );
        finalizeWarnings.push(`memo-first evidence invalid: ${memoFirstStrictValidation.invalidCount}/${memoFirstStrictValidation.claimCount} claims`);
        finalizeDegraded = true;
      }

      await this.updateFinalizeV2Status(jobId, { stage: "events", progress: 70 });
      await this.ensureFinalizeJobActive(jobId);
      const eventsPayload = {
        session_id: sessionId,
        transcript,
        memos: memosWithEvidence,
        stats,
        locale
      };
      const eventsResult = await this.invokeInferenceAnalysisEvents(eventsPayload);
      const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
      backendTimeline.push(...eventsResult.timeline);
      if (eventsResult.warnings.length > 0) {
        finalizeWarnings.push(...eventsResult.warnings);
      }
      if (eventsResult.degraded) {
        finalizeDegraded = true;
      }
      finalizeBackendUsed = eventsResult.backend_used === "local" ? "local" : eventsResult.backend_used;
      if (eventsResult.fallback_reason) {
        finalizeWarnings.push(`events fallback: ${eventsResult.fallback_reason}`);
      }
      await this.updateFinalizeV2Status(jobId, {
        warnings: finalizeWarnings,
        degraded: finalizeDegraded,
        backend_used: finalizeBackendUsed
      });

      await this.updateFinalizeV2Status(jobId, { stage: "report", progress: 84 });
      await this.ensureFinalizeJobActive(jobId);
      const reportStart = Date.now();
      let finalOverall = memoFirstReport.overall;
      let finalPerPerson = memoFirstReport.per_person;
      let reportSource: "memo_first" | "llm_enhanced" | "llm_failed"
        | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback" = "memo_first";
      let reportModel: string | null = null;
      let reportError: string | null = null;
      let reportBlockingReason: string | null = null;
      let reportTimeline: InferenceBackendTimelineItem[] = [];
      let llmAttempted = false;
      let llmSuccess = false;
      let llmElapsedMs: number | null = null;
      let pipelineMode: "memo_first_with_llm_polish" | "llm_core_synthesis" = "memo_first_with_llm_polish";

      // ── LLM-Core Synthesis Pipeline (with checkpoint merge support) ──
      const storedCheckpoints = await this.loadCheckpoints();
      const useCheckpointMerge = storedCheckpoints.length > 0;
      try {
        llmAttempted = true;
        const fullConfig = (state.config ?? {}) as Record<string, unknown>;
        const { rubric, sessionContext, freeFormNotes, stages: contextStages } = collectEnrichedContext({
          sessionConfig: {
            mode: fullConfig.mode as "1v1" | "group" | undefined,
            interviewer_name: fullConfig.interviewer_name as string | undefined,
            position_title: fullConfig.position_title as string | undefined,
            company_name: fullConfig.company_name as string | undefined,
            stages: configStages,
            free_form_notes: fullConfig.free_form_notes as string | undefined,
            rubric: fullConfig.rubric as Parameters<typeof collectEnrichedContext>[0]["sessionConfig"]["rubric"],
          },
        });

        let synthData: Record<string, unknown>;
        const synthStart = Date.now();

        if (useCheckpointMerge) {
          // ── Checkpoint merge path: merge pre-computed checkpoint summaries ──
          console.log(
            `[finalize] session=${sessionId} using checkpoint merge: ${storedCheckpoints.length} checkpoints`
          );
          const mergePayload: MergeCheckpointsRequestPayload = {
            session_id: sessionId,
            checkpoints: storedCheckpoints,
            final_stats: stats,
            final_memos: enrichedMemos,
            evidence: evidence.map((e) => {
              let sk = e.speaker?.person_id ?? e.speaker?.display_name ?? e.speaker?.cluster_id ?? null;
              if ((!sk || /^c\d+$/.test(sk) || sk === "unknown") && e.quote) {
                const quoteLower = e.quote.toLowerCase();
                for (const stat of stats) {
                  const name = stat.speaker_name?.trim();
                  if (name && name !== "unknown" && name !== "teacher" && quoteLower.includes(name.toLowerCase())) {
                    sk = name;
                    break;
                  }
                }
              }
              return { ...e, speaker_key: sk };
            }),
            locale,
          };
          const mergeResult = await this.invokeInferenceMergeCheckpoints(mergePayload);
          llmElapsedMs = Date.now() - synthStart;
          reportTimeline = mergeResult.timeline;
          synthData = mergeResult.data;
          if (mergeResult.warnings.length > 0) {
            finalizeWarnings.push(...mergeResult.warnings);
          }
          if (mergeResult.degraded) {
            finalizeDegraded = true;
          }
        } else {
          // ── Direct synthesis path: short interviews without checkpoints ──
          const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
          const synthPayload = buildSynthesizePayload({
            sessionId,
            transcript,
            memos: enrichedMemos,
            evidence,
            stats,
            events: analysisEvents.map((evt: Record<string, unknown>) => ({
              event_id: String(evt.event_id ?? ""),
              event_type: String(evt.event_type ?? ""),
              actor: evt.actor != null ? String(evt.actor) : null,
              target: evt.target != null ? String(evt.target) : null,
              time_range_ms: Array.isArray(evt.time_range_ms) ? (evt.time_range_ms as number[]) : [],
              utterance_ids: Array.isArray(evt.utterance_ids) ? (evt.utterance_ids as string[]) : [],
              quote: evt.quote != null ? String(evt.quote) : null,
              confidence: typeof evt.confidence === "number" ? evt.confidence : 0.5,
              rationale: evt.rationale != null ? String(evt.rationale) : null,
            })),
            bindings: memoBindings,
            rubric,
            sessionContext,
            freeFormNotes,
            historical: [],
            stages: contextStages.length > 0 ? contextStages : configStages,
            locale,
            nameAliases: configNameAliases,
            statsObservations,
          });

          const synthResult = await this.invokeInferenceSynthesizeReport(synthPayload);
          llmElapsedMs = Date.now() - synthStart;
          reportTimeline = synthResult.timeline;
          synthData = synthResult.data;
          if (synthResult.warnings.length > 0) {
            finalizeWarnings.push(...synthResult.warnings);
          }
          if (synthResult.degraded) {
            finalizeDegraded = true;
          }
        }

        const candidatePerPerson = Array.isArray(synthData?.per_person) ? (synthData.per_person as PersonFeedbackItem[]) : [];
        const candidateOverall = (synthData?.overall ?? memoFirstReport.overall) as unknown;
        const candidateQuality =
          synthData?.quality && typeof synthData.quality === "object" ? (synthData.quality as Partial<ReportQualityMeta>) : null;

        if (candidatePerPerson.length > 0) {
          // Strip claims with empty/invalid evidence_refs before validation
          const { sanitized: sanitizedPerPerson, strippedCount } = this.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
          if (strippedCount > 0) {
            finalizeWarnings.push(`sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
          }
          const candidateValidation = this.validateClaimEvidenceRefs({
            evidence,
            per_person: sanitizedPerPerson
          } as ResultV2);
          if (candidateValidation.valid) {
            finalPerPerson = sanitizedPerPerson;
            finalOverall = candidateOverall;
            llmSuccess = true;
            pipelineMode = "llm_core_synthesis";
            reportSource = (candidateQuality?.report_source as typeof reportSource) ?? "llm_synthesized";
            reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
            reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
            // Stage 2 LLM fine-matching: backfill supporting_utterances into evidence
            evidence = backfillSupportingUtterances(evidence, finalPerPerson);
          } else {
            reportSource = "memo_first_fallback";
            reportBlockingReason = candidateValidation.failures[0] || "analysis/synthesize invalid evidence refs";
          }
        } else {
          reportSource = "memo_first_fallback";
          reportBlockingReason = "analysis/synthesize returned empty per_person";
        }
      } catch (synthError) {
        // Synthesis failed — try legacy analysis/report as secondary fallback
        try {
          const reportResult = await this.invokeInferenceAnalysisReport({
            session_id: sessionId,
            transcript,
            memos: memosWithEvidence,
            stats,
            evidence: legacyEvidence,
            events: analysisEvents,
            locale
          });
          reportTimeline = reportResult.timeline;
          if (reportResult.warnings.length > 0) {
            finalizeWarnings.push(...reportResult.warnings);
          }
          if (reportResult.degraded) {
            finalizeDegraded = true;
          }
          const payload = reportResult.data;
          const candidatePerPerson = Array.isArray(payload?.per_person) ? (payload.per_person as PersonFeedbackItem[]) : [];
          const candidateOverall = (payload?.overall ?? memoFirstReport.overall) as unknown;
          const candidateQuality =
            payload?.quality && typeof payload.quality === "object" ? (payload.quality as Partial<ReportQualityMeta>) : null;
          if (candidatePerPerson.length > 0) {
            const candidateValidation = this.validateClaimEvidenceRefs({
              evidence: legacyEvidence,
              per_person: candidatePerPerson
            } as ResultV2);
            if (candidateValidation.valid) {
              finalPerPerson = candidatePerPerson;
              finalOverall = candidateOverall;
              reportSource = "llm_enhanced";
              if (candidateQuality?.report_source === "memo_first") {
                reportSource = "memo_first";
              }
              if (candidateQuality?.report_source === "llm_failed") {
                reportSource = "llm_failed";
              }
              reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
              reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
            } else {
              reportSource = "memo_first_fallback";
              reportBlockingReason = candidateValidation.failures[0] || "analysis/report invalid evidence refs";
            }
          } else {
            reportSource = "memo_first_fallback";
            reportBlockingReason = "analysis/report returned empty per_person";
          }
        } catch (reportError2) {
          reportSource = "memo_first_fallback";
          reportError = (synthError as Error).message;
          reportBlockingReason = `analysis/synthesize failed: ${(synthError as Error).message}, analysis/report fallback also failed: ${(reportError2 as Error).message}`;
          finalizeWarnings.push(reportBlockingReason);
        }
      }
      const reportMs = Date.now() - reportStart;
      backendTimeline.push(...reportTimeline);

      // ── Evidence namespace alignment ──
      // When report comes from legacy or memo_first fallback, the claim evidence_refs
      // reference legacy evidence IDs. Switch the evidence pack to match.
      if (reportSource === 'memo_first_fallback' || reportSource === 'memo_first' || reportSource === 'llm_enhanced' || reportSource === 'llm_failed') {
        evidence = legacyEvidence;
      }

      // ── Quality gate enforcement (new) ──
      const synthQualityGate = enforceQualityGates({
        perPerson: finalPerPerson,
        unknownRatio: computeUnknownRatio(transcript),
      });

      await this.updateFinalizeV2Status(jobId, { stage: "persist", progress: 95 });
      await this.ensureFinalizeJobActive(jobId);
      const finalizedAt = this.currentIsoTs();
      const thresholdMeta: Record<string, number | string | boolean> = {};
      for (const [key, value] of Object.entries(metadata ?? {})) {
        if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
          thresholdMeta[key] = value;
        }
      }
      const captureByStream = state.capture_by_stream ?? defaultCaptureByStream();
      const qualityMetrics = this.buildQualityMetrics(transcript, captureByStream);
      const ingestP95Ms =
        typeof asrByStream.students.ingest_to_utterance_p95_ms === "number"
          ? asrByStream.students.ingest_to_utterance_p95_ms
          : null;
      const finalStrictValidation = this.validateClaimEvidenceRefs({
        evidence,
        per_person: finalPerPerson
      } as ResultV2);
      const qualityGateEvaluation = this.evaluateFeedbackQualityGates({
        unknownRatio: qualityMetrics.unknown_ratio,
        ingestP95Ms,
        claimValidationFailures: [
          ...(finalStrictValidation.failures ?? []),
          ...synthQualityGate.failures,
          ...(ACCEPTED_REPORT_SOURCES.has(reportSource) ? [] : [reportBlockingReason || "llm report unavailable"])
        ]
      });
      const finalTentative = confidenceLevel === "low" || !qualityGateEvaluation.passed;
      const quality: ReportQualityMeta = {
        ...memoFirstValidation.quality,
        generated_at: finalizedAt,
        build_ms: memoFirstBuildMs + reportMs,
        validation_ms: validationMs,
        claim_count: finalStrictValidation.claimCount,
        invalid_claim_count: finalStrictValidation.invalidCount,
        needs_evidence_count: finalStrictValidation.needsEvidenceCount,
        report_source: reportSource,
        report_model: reportModel,
        report_degraded: !ACCEPTED_REPORT_SOURCES.has(reportSource),
        report_error: reportError
      };
      const qualityGateSnapshot = {
        finalize_success_target: 0.995,
        students_unknown_ratio_target: 0.25,
        sv_top1_target: 0.9,
        echo_reduction_target: 0.8,
        observed_unknown_ratio: qualityMetrics.unknown_ratio,
        observed_students_turns: qualityMetrics.students_utterance_count,
        observed_students_unknown: qualityMetrics.students_unknown_count,
        observed_echo_suppressed_chunks: qualityMetrics.echo_suppressed_chunks,
        observed_echo_recent_rate: qualityMetrics.echo_suppression_recent_rate,
        observed_echo_leak_rate: qualityMetrics.echo_leak_rate,
        observed_suppression_false_positive_rate: qualityMetrics.suppression_false_positive_rate
      };
      const resultV2 = buildResultV2({
        sessionId,
        finalizedAt,
        tentative: finalTentative,
        confidenceLevel,
        unresolvedClusterCount,
        diarizationBackend,
        transcript,
        speakerLogs,
        stats,
        memos,
        evidence,
        overall: finalOverall,
        perPerson: finalPerPerson,
        quality,
        finalizeJobId: jobId,
        modelVersions: {
          asr: asrByStream.students.model,
          analysis_events_path: this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
          analysis_report_path: this.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
          analysis_synthesize_path: this.env.INFERENCE_SYNTHESIZE_PATH ?? "/analysis/synthesize",
          summary_mode: pipelineMode
        },
        thresholds: {
          sv_t_low: 0.45,
          sv_t_high: 0.70,
          tentative: finalTentative,
          unresolved_cluster_count: unresolvedClusterCount,
          diarization_backend: diarizationBackend,
          finalize_timeout_ms: timeoutMs,
          feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
          feedback_events_budget_ms: FEEDBACK_EVENTS_BUDGET_MS,
          feedback_report_budget_ms: FEEDBACK_REPORT_BUDGET_MS,
          feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
          feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
          ...thresholdMeta
        },
        backendTimeline,
        qualityGateSnapshot,
        reportPipeline: {
          mode: pipelineMode,
          source: reportSource,
          llm_attempted: llmAttempted,
          llm_success: llmSuccess,
          llm_elapsed_ms: llmElapsedMs ?? reportMs,
          blocking_reason: reportBlockingReason
        },
        qualityGateFailures: qualityGateEvaluation.failures
      });

      const resultV2Key = resultObjectKeyV2(sessionId);
      await this.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
        httpMetadata: { contentType: "application/json" }
      });
      const historyItem: HistoryIndexItem = {
        session_id: sessionId,
        finalized_at: finalizedAt,
        tentative: Boolean(resultV2.session.tentative),
        unresolved_cluster_count: Number(resultV2.session.unresolved_cluster_count || 0),
        ready: Boolean(
          ACCEPTED_REPORT_SOURCES.has(resultV2.quality.report_source ?? "")
          && resultV2.quality.needs_evidence_count === 0
        ),
        needs_evidence_count: Number(resultV2.quality.needs_evidence_count || 0),
        report_source: resultV2.quality.report_source ?? "memo_first"
      };
      const historyKey = historyObjectKey(sessionId, Date.parse(finalizedAt));
      await this.env.RESULT_BUCKET.put(historyKey, JSON.stringify(historyItem), {
        httpMetadata: { contentType: "application/json" }
      });
      await this.ctx.storage.put(STORAGE_KEY_RESULT_KEY_V2, resultV2Key);
      await this.ctx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
      await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, finalizedAt);
      const cache = await this.loadFeedbackCache(sessionId);
      cache.updated_at = finalizedAt;
      cache.report = resultV2;
      cache.person_summary_cache = resultV2.per_person;
      cache.overall_summary_cache = resultV2.overall;
      cache.evidence_index_cache = this.buildEvidenceIndex(resultV2.per_person);
      cache.quality = resultV2.quality;
      cache.timings = {
        assemble_ms: memoFirstBuildMs,
        events_ms: 0,
        report_ms: reportMs,
        validation_ms: validationMs,
        persist_ms: 0,
        total_ms: 0
      };
      cache.report_source = resultV2.quality.report_source ?? "memo_first";
      cache.quality_gate_passed =
        ACCEPTED_REPORT_SOURCES.has(cache.report_source)
        && resultV2.quality.needs_evidence_count === 0;
      cache.blocking_reason = cache.quality_gate_passed
        ? null
        : (resultV2.trace.quality_gate_failures?.[0] ?? "feedback quality gate failed");
      cache.ready = cache.quality_gate_passed;
      await this.storeFeedbackCache(cache);

      await this.updateFinalizeV2Status(jobId, {
        status: "succeeded",
        stage: "persist",
        progress: 100,
        finished_at: finalizedAt,
        errors: [],
        warnings: finalizeWarnings,
        degraded: finalizeDegraded,
        backend_used: finalizeBackendUsed
      });

      // ── Tier 2 background trigger ──
      // After Tier 1 succeeds, check if Tier 2 batch re-processing is enabled.
      // If so, schedule a DO alarm to run the Tier 2 job asynchronously.
      if (this.tier2Enabled() && this.tier2AutoTrigger()) {
        try {
          const tier2: Tier2Status = {
            enabled: true,
            status: "pending",
            started_at: null,
            completed_at: null,
            error: null,
            report_version: "tier1_instant",
            progress: 0,
            warnings: []
          };
          await this.storeTier2Status(tier2);
          // Schedule alarm for 2 seconds from now to start Tier 2
          const tag = `tier2_${sessionId}_${Date.now()}`;
          await this.ctx.storage.put(STORAGE_KEY_TIER2_ALARM_TAG, tag);
          await this.ctx.storage.setAlarm(Date.now() + 2_000);
          console.log(`[finalize-v2] tier2 scheduled for session=${sessionId}`);
        } catch (tier2ScheduleErr) {
          console.warn(
            `[finalize-v2] failed to schedule tier2 (non-fatal): ${(tier2ScheduleErr as Error).message}`
          );
        }
      }
    } catch (error) {
      const message = (error as Error).message;
      const current = await this.loadFinalizeV2Status();
      if (current && current.job_id === jobId && !this.isFinalizeTerminal(current.status)) {
        await this.updateFinalizeV2Status(jobId, {
          status: "failed",
          stage: "persist",
          progress: 100,
          finished_at: this.currentIsoTs(),
          errors: [...current.errors, message],
          warnings: [...current.warnings, ...finalizeWarnings],
          degraded: true,
          backend_used: current.backend_used
        });
      }
    } finally {
      await this.setFinalizeLock(false);
    }
  }

  // ── Tier 2 Status Management ───────────────────────────────────────────

  private tier2Enabled(): boolean {
    return parseBool(this.env.TIER2_ENABLED, false);
  }

  private tier2AutoTrigger(): boolean {
    return parseBool(this.env.TIER2_AUTO_TRIGGER, false);
  }

  private tier2BatchEndpoint(): string {
    return (this.env.TIER2_BATCH_ENDPOINT ?? "").trim() || `${this.env.INFERENCE_BASE_URL}/batch/process`;
  }

  private defaultTier2Status(): Tier2Status {
    return {
      enabled: this.tier2Enabled(),
      status: "idle",
      started_at: null,
      completed_at: null,
      error: null,
      report_version: "tier1_instant",
      progress: 0,
      warnings: []
    };
  }

  private async loadTier2Status(): Promise<Tier2Status> {
    const stored = await this.ctx.storage.get<Tier2Status>(STORAGE_KEY_TIER2_STATUS);
    if (!stored) return this.defaultTier2Status();
    return {
      ...stored,
      enabled: stored.enabled ?? this.tier2Enabled(),
      warnings: Array.isArray(stored.warnings) ? stored.warnings : []
    };
  }

  private async storeTier2Status(status: Tier2Status): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY_TIER2_STATUS, status);
  }

  private async updateTier2Status(patch: Partial<Tier2Status>): Promise<Tier2Status> {
    const current = await this.loadTier2Status();
    const next: Tier2Status = { ...current, ...patch };
    await this.storeTier2Status(next);
    return next;
  }

  private isTier2Terminal(status: Tier2Status["status"]): boolean {
    return status === "succeeded" || status === "failed" || status === "idle";
  }

  // ── Tier 2 Background Job ────────────────────────────────────────────

  private async runTier2Job(sessionId: string): Promise<void> {
    const tier2 = await this.loadTier2Status();
    if (this.isTier2Terminal(tier2.status)) {
      return; // Already completed or not pending
    }

    await this.updateTier2Status({
      status: "downloading",
      started_at: this.currentIsoTs(),
      progress: 5
    });

    try {
      // 1. Gather the audio chunks from R2 into a single PCM blob
      const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
      if (!resultKey) {
        throw new Error("no result key found — tier1 may not have completed");
      }
      const sessionPrefix = resultKey.replace(/\/result_v2\.json$/, "");
      const chunksPrefix = `${sessionPrefix}/chunks/`;

      // Collect all PCM chunk keys sorted by name (sequential order)
      const chunkKeys: string[] = [];
      let cursor: string | undefined;
      do {
        const listing = await this.env.RESULT_BUCKET.list({
          prefix: chunksPrefix,
          cursor,
          limit: 500
        });
        for (const obj of listing.objects) {
          chunkKeys.push(obj.key);
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);

      if (chunkKeys.length === 0) {
        throw new Error("no audio chunks found in R2 for tier2 processing");
      }

      chunkKeys.sort();

      await this.updateTier2Status({ progress: 15 });

      // Concatenate PCM chunks
      const pcmParts: Uint8Array[] = [];
      for (const key of chunkKeys) {
        const obj = await this.env.RESULT_BUCKET.get(key);
        if (obj) {
          pcmParts.push(new Uint8Array(await obj.arrayBuffer()));
        }
      }
      const fullPcm = concatUint8Arrays(pcmParts);
      const wavBytes = pcm16ToWavBytes(fullPcm, TARGET_SAMPLE_RATE, TARGET_CHANNELS);

      await this.updateTier2Status({
        status: "transcribing",
        progress: 25
      });

      // 2. Send to batch processor endpoint (/batch/process)
      const endpoint = this.tier2BatchEndpoint();
      const state = normalizeSessionState(
        await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE)
      );
      const numSpeakers = (state.roster ?? []).length || undefined;

      // Upload as WAV via R2 presigned URL or direct POST
      // For simplicity, we POST the audio directly as a base64 payload
      const audioB64 = bytesToBase64(wavBytes);

      const batchResponse = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.env.INFERENCE_API_KEY
            ? { "x-api-key": this.env.INFERENCE_API_KEY }
            : {})
        },
        body: JSON.stringify({
          audio_url: `data:audio/wav;base64,${audioB64}`,
          num_speakers: numSpeakers,
          language: getSessionLocale(state, this.env)
        }),
        signal: AbortSignal.timeout(180_000) // 3 min timeout
      });

      await this.updateTier2Status({
        status: "diarizing",
        progress: 50
      });

      if (!batchResponse.ok) {
        const errText = await batchResponse.text().catch(() => "unknown");
        throw new Error(`batch/process returned ${batchResponse.status}: ${errText}`);
      }

      const batchResult = (await batchResponse.json()) as {
        transcript?: Array<{
          utterance_id?: string;
          speaker?: string;
          text?: string;
          start_ms?: number;
          end_ms?: number;
        }>;
        speaker_stats?: Record<string, unknown>;
        diarization?: Record<string, unknown>;
      };

      await this.updateTier2Status({
        status: "reconciling",
        progress: 65
      });

      // 3. Re-reconcile: merge batch transcript with manual bindings
      const existingResult = await this.env.RESULT_BUCKET.get(resultKey);
      if (!existingResult) {
        throw new Error("could not load tier1 result for re-reconciliation");
      }
      const tier1Result = (await existingResult.json()) as ResultV2;

      // Build enhanced transcript from batch result
      const batchTranscript = (batchResult.transcript ?? []).map((item, idx) => ({
        utterance_id: item.utterance_id ?? `tier2_utt_${idx}`,
        stream_role: "students" as const,
        cluster_id: null,
        speaker_name: item.speaker ?? null,
        decision: "auto" as const,
        text: item.text ?? "",
        start_ms: item.start_ms ?? 0,
        end_ms: item.end_ms ?? 0,
        duration_ms: (item.end_ms ?? 0) - (item.start_ms ?? 0)
      }));

      // Use batch transcript if it has data, otherwise keep tier1 transcript
      const finalTranscript = batchTranscript.length > 0
        ? batchTranscript
        : tier1Result.transcript;

      await this.updateTier2Status({
        status: "reporting",
        progress: 75
      });

      // 4. Re-generate stats
      const tier2Stats = computeSpeakerStats(finalTranscript as TranscriptItem[]);
      const mergedStats = this.mergeStatsWithRoster(tier2Stats, state);

      // 5. Re-run LLM report synthesis with improved transcript
      const tier2Warnings: string[] = [];
      const memos = await this.loadMemos();
      const enrichedMemos = addStageMetadata(memos, (state.config as Record<string, unknown>)?.stages as string[] ?? []);
      const knownSpeakers = mergedStats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
      const memoBindings = extractMemoNames(enrichedMemos, knownSpeakers);
      let evidence = buildMultiEvidence({
        memos: enrichedMemos,
        transcript: finalTranscript as TranscriptItem[],
        bindings: memoBindings
      });

      // ── Enrich evidence pack with transcript quotes, stats summaries, interaction patterns ──
      const tier2EnrichedEvidence = enrichEvidencePack(finalTranscript as TranscriptItem[], mergedStats);
      evidence = [...evidence, ...tier2EnrichedEvidence];

      // ── Generate stats observations for LLM context ──
      const tier2AudioDurationMs = finalTranscript.length > 0 ? Math.max(...finalTranscript.map(u => u.end_ms)) : 0;
      const tier2StatsObservations = generateStatsObservations(mergedStats, tier2AudioDurationMs);

      const locale = getSessionLocale(state, this.env);
      const fullConfig = (state.config ?? {}) as Record<string, unknown>;
      const configStages: string[] = fullConfig.stages as string[] ?? [];
      const { rubric, sessionContext, freeFormNotes, stages: contextStages } = collectEnrichedContext({
        sessionConfig: {
          mode: fullConfig.mode as "1v1" | "group" | undefined,
          interviewer_name: fullConfig.interviewer_name as string | undefined,
          position_title: fullConfig.position_title as string | undefined,
          company_name: fullConfig.company_name as string | undefined,
          stages: configStages,
          free_form_notes: fullConfig.free_form_notes as string | undefined,
          rubric: fullConfig.rubric as Parameters<typeof collectEnrichedContext>[0]["sessionConfig"]["rubric"],
        },
      });
      const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
      const synthPayload = buildSynthesizePayload({
        sessionId,
        transcript: finalTranscript as TranscriptItem[],
        memos: enrichedMemos,
        evidence,
        stats: mergedStats,
        events: [],
        bindings: memoBindings,
        rubric,
        sessionContext,
        freeFormNotes,
        historical: [],
        stages: contextStages.length > 0 ? contextStages : configStages,
        locale,
        nameAliases: configNameAliases,
        statsObservations: tier2StatsObservations,
      });
      const synthResult = await this.invokeInferenceSynthesizeReport(synthPayload);
      if (synthResult.warnings.length > 0) {
        tier2Warnings.push(...synthResult.warnings);
      }

      let finalPerPerson = tier1Result.per_person;
      let finalOverall = tier1Result.overall;
      let reportSource: ReportQualityMeta["report_source"] = "llm_synthesized";
      let reportModel: string | null = null;

      const synthData = synthResult.data;
      const candidatePerPerson = Array.isArray(synthData?.per_person)
        ? (synthData.per_person as PersonFeedbackItem[])
        : [];
      if (candidatePerPerson.length > 0) {
        const { sanitized, strippedCount } = this.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
        if (strippedCount > 0) {
          tier2Warnings.push(`tier2 sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
        }
        const validation = this.validateClaimEvidenceRefs({
          evidence,
          per_person: sanitized
        } as ResultV2);
        if (validation.valid) {
          finalPerPerson = sanitized;
          finalOverall = (synthData?.overall ?? tier1Result.overall) as unknown;
          const candidateQuality = synthData?.quality && typeof synthData.quality === "object"
            ? (synthData.quality as Partial<ReportQualityMeta>)
            : null;
          reportSource = (candidateQuality?.report_source as typeof reportSource) ?? "llm_synthesized";
          reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
          // Stage 2 LLM fine-matching: backfill supporting_utterances into evidence
          evidence = backfillSupportingUtterances(evidence, finalPerPerson);
        } else {
          tier2Warnings.push("tier2 LLM report had invalid evidence refs, keeping tier1 report content");
          reportSource = tier1Result.quality.report_source ?? "memo_first";
        }
      } else {
        tier2Warnings.push("tier2 LLM returned empty per_person, keeping tier1 report");
        reportSource = tier1Result.quality.report_source ?? "memo_first";
      }

      await this.updateTier2Status({
        status: "persisting",
        progress: 90
      });

      // 6. Build and persist the tier2-refined result
      const tier2FinalizedAt = this.currentIsoTs();
      const tier2Quality: ReportQualityMeta = {
        ...tier1Result.quality,
        generated_at: tier2FinalizedAt,
        report_source: reportSource,
        report_model: reportModel,
        report_degraded: false
      };
      const tier2ResultV2: ResultV2 = {
        ...tier1Result,
        transcript: finalTranscript,
        stats: mergedStats,
        evidence,
        overall: finalOverall,
        per_person: finalPerPerson,
        quality: tier2Quality,
        session: {
          ...tier1Result.session,
          finalized_at: tier2FinalizedAt
        },
        trace: {
          ...tier1Result.trace,
          generated_at: tier2FinalizedAt,
          report_pipeline: {
            mode: "llm_core_synthesis",
            source: reportSource as "llm_synthesized",
            llm_attempted: true,
            llm_success: candidatePerPerson.length > 0,
            llm_elapsed_ms: null,
            blocking_reason: null
          }
        }
      };

      // Overwrite the result in R2
      await this.env.RESULT_BUCKET.put(resultKey, JSON.stringify(tier2ResultV2), {
        httpMetadata: { contentType: "application/json" }
      });

      // Update feedback cache
      const cache = await this.loadFeedbackCache(sessionId);
      cache.updated_at = tier2FinalizedAt;
      cache.report = tier2ResultV2;
      cache.person_summary_cache = tier2ResultV2.per_person;
      cache.overall_summary_cache = tier2ResultV2.overall;
      cache.evidence_index_cache = this.buildEvidenceIndex(tier2ResultV2.per_person);
      cache.quality = tier2ResultV2.quality;
      cache.report_source = reportSource ?? "llm_synthesized";
      cache.ready = true;
      await this.storeFeedbackCache(cache);

      await this.updateTier2Status({
        status: "succeeded",
        completed_at: tier2FinalizedAt,
        report_version: "tier2_refined",
        progress: 100,
        warnings: tier2Warnings
      });

      console.log(`[tier2] completed for session=${sessionId}`);
    } catch (err) {
      const message = (err as Error).message;
      console.error(`[tier2] failed for session=${sessionId}: ${message}`);
      await this.updateTier2Status({
        status: "failed",
        completed_at: this.currentIsoTs(),
        error: message,
        progress: 100
      });
    }
  }

  private async handleChunkFrame(
    sessionId: string,
    streamRole: StreamRole,
    socket: WebSocket,
    frame: AudioChunkFrame
  ): Promise<void> {
    if (await this.isFinalizeLocked()) {
      await this.failStuckFinalizeIfNeeded("ingest-locked");
    }
    if (await this.isFinalizeLocked()) {
      this.sendWsJson(socket, {
        type: "ack",
        stream_role: streamRole,
        seq: frame.seq,
        status: "frozen"
      });
      return;
    }
    const ingestByStream = await this.loadIngestByStream(sessionId);
    const ingest = ingestByStream[streamRole];

    if (ingest.meeting_id && ingest.meeting_id !== frame.meeting_id) {
      throw new Error(`meeting_id mismatch: expected ${ingest.meeting_id}`);
    }

    if (frame.seq <= ingest.last_seq) {
      ingest.duplicate_chunks += 1;
      ingestByStream[streamRole] = ingest;
      await this.storeIngestByStream(ingestByStream);
      this.sendWsJson(socket, {
        type: "ack",
        stream_role: streamRole,
        seq: frame.seq,
        status: "duplicate",
        last_seq: ingest.last_seq,
        missing_count: ingest.missing_chunks,
        duplicate_count: ingest.duplicate_chunks
      });
      return;
    }

    if (frame.seq > ingest.last_seq + 1) {
      ingest.missing_chunks += frame.seq - ingest.last_seq - 1;
    }

    const bytes = decodeBase64ToBytes(frame.content_b64);
    if (bytes.byteLength !== ONE_SECOND_PCM_BYTES) {
      throw new Error(`chunk byte length must be ${ONE_SECOND_PCM_BYTES}, got ${bytes.byteLength}`);
    }

    const key = chunkObjectKey(sessionId, streamRole, frame.seq);
    await this.env.RESULT_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: "application/octet-stream"
      },
      customMetadata: {
        session_id: sessionId,
        stream_role: streamRole,
        meeting_id: frame.meeting_id,
        seq: String(frame.seq),
        timestamp_ms: String(frame.timestamp_ms),
        sample_rate: String(frame.sample_rate),
        channels: String(frame.channels),
        format: frame.format
      }
    });

    ingest.last_seq = frame.seq;
    ingest.received_chunks += 1;
    ingest.bytes_stored += bytes.byteLength;
    ingestByStream[streamRole] = ingest;
    await this.storeIngestByStream(ingestByStream);
    await this.patchAsrCursor(streamRole, {
      last_ingested_seq: Math.max(frame.seq, ingest.last_seq)
    });

    this.sendWsJson(socket, {
      type: "ack",
      stream_role: streamRole,
      seq: frame.seq,
      status: "stored",
      key,
      last_seq: ingest.last_seq,
      missing_count: ingest.missing_chunks,
      duplicate_count: ingest.duplicate_chunks
    });

    if (this.asrEnabled()) {
      if (this.asrRealtimeEnabled()) {
        this.ctx.waitUntil(
          (async () => {
            await this.enqueueRealtimeChunk(sessionId, streamRole, frame.seq, frame.timestamp_ms, bytes);
            await this.drainRealtimeQueue(sessionId, streamRole);
          })().catch((error) => {
            console.error(`asr realtime enqueue failed session=${sessionId} stream=${streamRole}:`, error);
          })
        );
      } else {
        this.ctx.waitUntil(
          this.maybeRunAsrWindows(sessionId, streamRole, false, 1).catch((error) => {
            console.error(`asr window processing failed session=${sessionId} stream=${streamRole}:`, error);
          })
        );
      }
    }

    // NOTE: feedback cache refresh removed from audio chunk handler.
    // The cache is refreshed on-demand when feedback endpoints are called
    // (feedback-ready, feedback-open, etc.) — NOT on every audio chunk.
    // Previously, ctx.waitUntil races caused hundreds of concurrent
    // events+report LLM calls during recording, exhausting the thread pool
    // and preventing the synthesize call from succeeding at finalization.
  }

  private deriveMixedCaptureState(captureByStream: Record<StreamRole, CaptureState>): CaptureState["capture_state"] {
    const teacher = captureByStream.teacher.capture_state;
    const students = captureByStream.students.capture_state;
    if (teacher === "recovering" || students === "recovering") return "recovering";
    if (teacher === "running" || students === "running") return "running";
    if (teacher === "failed" || students === "failed") return "failed";
    return "idle";
  }

  private async applyCaptureStatus(
    sessionId: string,
    streamRole: StreamRole,
    patch: Partial<CaptureState>
  ): Promise<CaptureState> {
    const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const capture = state.capture_by_stream ?? defaultCaptureByStream();
    const current = sanitizeCaptureState(capture[streamRole]);
    const next = sanitizeCaptureState({
      ...current,
      ...patch,
      updated_at: new Date().toISOString()
    });
    capture[streamRole] = next;
    capture.mixed = sanitizeCaptureState({
      ...capture.mixed,
      capture_state: this.deriveMixedCaptureState(capture),
      echo_suppressed_chunks: capture.teacher.echo_suppressed_chunks ?? 0,
      echo_suppression_recent_rate: capture.teacher.echo_suppression_recent_rate ?? 0,
      updated_at: new Date().toISOString()
    });
    state.capture_by_stream = capture;
    await this.ctx.storage.put(STORAGE_KEY_STATE, state);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
    return next;
  }

  private async updateSessionConfigFromHello(message: Record<string, unknown>): Promise<void> {
    const currentState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const config = { ...(currentState.config ?? {}) };

    const interviewer = valueAsString(message.interviewer_name);
    if (interviewer) {
      config.interviewer_name = interviewer;
    }

    const teamsInterviewer = valueAsString(message.teams_interviewer_name);
    if (teamsInterviewer) {
      config.teams_interviewer_name = teamsInterviewer;
    } else if (interviewer) {
      config.teams_interviewer_name = interviewer;
    }
    if (config.diarization_backend !== "edge" && config.diarization_backend !== "cloud") {
      config.diarization_backend = this.diarizationBackendDefault();
    }

    const roster = parseRosterEntries(message.teams_participants);
    if (roster.length > 0) {
      currentState.roster = roster;
    }

    currentState.config = config;
    await this.ctx.storage.put(STORAGE_KEY_STATE, currentState);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
  }

  private ingestByStreamPayload(sessionId: string, ingestByStream: Record<StreamRole, IngestState>) {
    return {
      mixed: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
      teacher: ingestStatusPayload(sessionId, "teacher", ingestByStream.teacher),
      students: ingestStatusPayload(sessionId, "students", ingestByStream.students)
    };
  }

  private async handleWebSocketRequest(
    request: Request,
    sessionId: string,
    connectionRole: StreamRole
  ): Promise<Response> {
    if (!isWebSocketRequest(request)) {
      return jsonResponse({ detail: "websocket upgrade required" }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let messageQueue: Promise<void> = Promise.resolve();

    server.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(() => this.enqueueMutation(async () => {
          if (typeof event.data !== "string") {
            throw new Error("websocket frame must be text JSON");
          }

          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            throw new Error("websocket frame is not valid JSON");
          }

          if (!payload || typeof payload !== "object") {
            throw new Error("websocket frame must be an object");
          }

          const message = payload as Record<string, unknown>;
          const type = String(message.type ?? "");

          if (type === "hello") {
            const helloRole = message.stream_role ? parseStreamRole(String(message.stream_role), connectionRole) : connectionRole;
            if (helloRole !== connectionRole) {
              throw new Error(`hello.stream_role mismatch: expected ${connectionRole}, got ${helloRole}`);
            }
            // Record session start time on first hello for caption timestamp normalization
            if (this.sessionStartMs === 0) {
              this.sessionStartMs = Date.now();
            }
            await this.updateSessionConfigFromHello(message);

            const ingestByStream = await this.loadIngestByStream(sessionId);
            this.sendWsJson(server, {
              type: "ready",
              session_id: sessionId,
              stream_role: connectionRole,
              target_sample_rate: TARGET_SAMPLE_RATE,
              target_channels: TARGET_CHANNELS,
              target_format: TARGET_FORMAT,
              ingest: ingestStatusPayload(sessionId, connectionRole, ingestByStream[connectionRole]),
              ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream)
            });
            return;
          }

          if (type === "status") {
            const ingestByStream = await this.loadIngestByStream(sessionId);
            this.sendWsJson(server, {
              ...ingestStatusPayload(sessionId, connectionRole, ingestByStream[connectionRole]),
              ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream)
            });
            return;
          }

          if (type === "ping") {
            this.sendWsJson(server, { type: "pong", ts: Date.now(), stream_role: connectionRole });
            return;
          }

          if (type === "capture_status") {
            const parsed = parseCaptureStatusPayload(message);
            const frameRole = parsed.stream_role ?? connectionRole;
            if (frameRole !== connectionRole) {
              throw new Error(`capture_status.stream_role mismatch: expected ${connectionRole}, got ${frameRole}`);
            }
            const stored = await this.applyCaptureStatus(sessionId, frameRole, parsed.payload);
            this.sendWsJson(server, {
              type: "capture_status_ack",
              stream_role: frameRole,
              payload: stored
            });
            return;
          }

          if (type === "caption") {
            const resultType = String(message.resultType ?? "");
            if (resultType === "Final") {
              const rawTs = Number(message.timestamp ?? 0);
              const timestampMs = Number.isFinite(rawTs) ? rawTs - this.sessionStartMs : 0;
              this.captionBuffer.push({
                speaker: String(message.speaker ?? ""),
                text: String(message.text ?? ""),
                language: String(message.language ?? ""),
                timestamp_ms: timestampMs,
                teamsUserId: message.teamsUserId ? String(message.teamsUserId) : undefined,
              });
            }
            return;
          }

          if (type === "session_config") {
            const src = String(message.captionSource ?? "");
            if (src === "acs-teams" || src === "none") {
              this.captionSource = src;
            }
            return;
          }

          if (type === "close") {
            const reason = String(message.reason ?? "client-close").slice(0, 120);
            if (this.asrRealtimeEnabled()) {
              await this.closeRealtimeAsrSession(connectionRole, `client-close:${reason}`, false);
              await this.refreshAsrStreamMetrics(sessionId, connectionRole);
            }
            this.sendWsJson(server, { type: "closing", reason, stream_role: connectionRole });
            server.close(1000, reason);
            return;
          }

          if (type === "chunk") {
            const frame = parseChunkFrame(message);
            const frameRole = frame.stream_role ?? connectionRole;
            if (frameRole !== connectionRole) {
              throw new Error(`chunk.stream_role mismatch: expected ${connectionRole}, got ${frameRole}`);
            }
            await this.handleChunkFrame(sessionId, connectionRole, server, frame);
            return;
          }

          throw new Error(`unsupported message type: ${type}`);
        }))
        .catch((error: Error) => {
          this.sendWsError(server, error.message);
        });
    });

    server.addEventListener("close", () => {
      this.ctx.waitUntil(
        (async () => {
          if (this.asrRealtimeEnabled()) {
            await this.closeRealtimeAsrSession(connectionRole, "ingest-ws-closed", false);
            await this.refreshAsrStreamMetrics(sessionId, connectionRole);
          }
        })()
      );
      server.close();
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");
    const sessionId = request.headers.get("x-session-id") ?? "unknown-session";
    const headerRole = request.headers.get("x-stream-role");

    if (action === "ingest-ws" && request.method === "GET") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(headerRole, "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }
      return this.handleWebSocketRequest(request, sessionId, streamRole);
    }

    if (action === "state" && request.method === "GET") {
      const [state, events, updatedAt, ingestByStream, utterancesByStream, asrByStream, memos, finalizeV2Status, speakerLogs, asrCursorByStream, feedbackCache, dependencyHealth, tier2Status] =
        await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.loadSpeakerEvents(),
        this.ctx.storage.get<string>(STORAGE_KEY_UPDATED_AT),
        this.loadIngestByStream(sessionId),
        this.loadUtterancesRawByStream(),
        this.loadAsrByStream(),
        this.loadMemos(),
        this.loadFinalizeV2Status(),
        this.loadSpeakerLogs(),
        this.loadAsrCursorByStream(),
        this.loadFeedbackCache(sessionId),
        this.loadDependencyHealth(),
        this.loadTier2Status()
      ]);

      const utteranceCountByStream = {
        mixed: utterancesByStream.mixed.length,
        teacher: utterancesByStream.teacher.length,
        students: utterancesByStream.students.length
      };
      const normalizedState = normalizeSessionState(state);
      const diarizationBackend = normalizedState.config?.diarization_backend === "edge" ? "edge" : "cloud";
      const metricsTranscript = buildReconciledTranscript({
        utterances: [...utterancesByStream.teacher, ...utterancesByStream.students],
        events,
        speakerLogs,
        state: normalizedState,
        diarizationBackend,
        roster: (normalizedState.roster ?? []).flatMap((r: RosterEntry) => [r.name, ...(r.aliases ?? [])])
      });
      const qualityMetrics = this.buildQualityMetrics(metricsTranscript, normalizedState.capture_by_stream ?? defaultCaptureByStream());
      const speechBackendMode = this.speechBackendMode(normalizedState, dependencyHealth);

      return jsonResponse({
        session_id: sessionId,
        state: normalizedState,
        event_count: events.length,
        updated_at: updatedAt ?? null,
        ingest: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
        ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream),
        capture_by_stream: normalizedState.capture_by_stream,
        enrollment_state: normalizedState.enrollment_state,
        participant_profiles: normalizedState.participant_profiles,
        cluster_binding_meta: normalizedState.cluster_binding_meta,
        asr: asrByStream.mixed,
        asr_by_stream: asrByStream,
        utterance_count: utteranceCountByStream.mixed,
        utterance_count_by_stream: utteranceCountByStream,
        memo_count: memos.length,
        finalize_v2: finalizeV2Status,
        tier2: tier2Status,
        speaker_logs: speakerLogs,
        asr_cursor_by_stream: asrCursorByStream,
        dependency_health: dependencyHealth,
        speech_backend_mode: speechBackendMode,
        quality_metrics: qualityMetrics,
        feedback: {
          ready: feedbackCache.ready,
          updated_at: feedbackCache.updated_at,
          quality: feedbackCache.quality,
          timings: feedbackCache.timings,
          report_source: feedbackCache.report_source,
          blocking_reason: feedbackCache.blocking_reason,
          quality_gate_passed: feedbackCache.quality_gate_passed
        }
      });
    }

    if (action === "config" && request.method === "POST") {
      let payload: SessionConfigRequest;
      try {
        payload = await readJson<SessionConfigRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const config = { ...(state.config ?? {}) };

        const teamsInterviewerName = valueAsString(payload.teams_interviewer_name);
        if (teamsInterviewerName) {
          config.teams_interviewer_name = teamsInterviewerName;
        }
        const interviewerName = valueAsString(payload.interviewer_name);
        if (interviewerName) {
          config.interviewer_name = interviewerName;
          if (!teamsInterviewerName) {
            config.teams_interviewer_name = interviewerName;
          }
        }
        if (payload.diarization_backend) {
          const db = payload.diarization_backend;
          config.diarization_backend = db === "edge" || db === "local" ? "edge" : "cloud";
        } else if (config.diarization_backend !== "edge" && config.diarization_backend !== "cloud") {
          config.diarization_backend = this.diarizationBackendDefault();
        }
        const mode = valueAsString(payload.mode);
        if (mode === "1v1" || mode === "group") {
          config.mode = mode;
        }
        const templateId = valueAsString(payload.template_id);
        if (templateId) {
          config.template_id = templateId;
        }
        const bookingRef = valueAsString(payload.booking_ref);
        if (bookingRef) {
          config.booking_ref = bookingRef;
        }
        const teamsJoinUrl = valueAsString(payload.teams_join_url);
        if (teamsJoinUrl) {
          config.teams_join_url = teamsJoinUrl;
        }
        if (Array.isArray(payload.stages)) {
          config.stages = payload.stages.filter((s): s is string => typeof s === "string");
        }
        const freeFormNotes = valueAsString(payload.free_form_notes);
        if (freeFormNotes) {
          config.free_form_notes = freeFormNotes;
        }

        const roster = parseRosterEntries(payload.participants ?? payload.teams_participants);
        if (roster.length > 0) {
          state.roster = roster;
          // Extract name_aliases from roster entries that have aliases
          const nameAliases: Record<string, string[]> = {};
          for (const entry of roster) {
            if (entry.aliases && entry.aliases.length > 0) {
              nameAliases[entry.name] = entry.aliases;
            }
          }
          if (Object.keys(nameAliases).length > 0) {
            config.name_aliases = nameAliases;
          }
        }

        state.config = config;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
        this.ctx.waitUntil(
          this.maybeRefreshFeedbackCache(sessionId, true).catch((error) => {
            console.error(`feedback cache refresh after config failed session=${sessionId}:`, error);
          })
        );

        return jsonResponse({
          session_id: sessionId,
          roster_count: state.roster?.length ?? 0,
          config: state.config,
          roster: state.roster ?? []
        });
      });
    }

    if (action === "enrollment-start" && request.method === "POST") {
      let payload: EnrollmentStartRequest;
      try {
        payload = await readJson<EnrollmentStartRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const config = { ...(state.config ?? {}) };
        const teamsInterviewerName = valueAsString(payload.teams_interviewer_name);
        const interviewerName = valueAsString(payload.interviewer_name);
        if (teamsInterviewerName) {
          config.teams_interviewer_name = teamsInterviewerName;
        }
        if (interviewerName) {
          config.interviewer_name = interviewerName;
          if (!teamsInterviewerName) {
            config.teams_interviewer_name = interviewerName;
          }
        }
        state.config = config;

        const roster = parseRosterEntries(payload.participants ?? payload.teams_participants);
        if (roster.length > 0) {
          state.roster = roster;
        }

        const participants: Record<string, EnrollmentParticipantProgress> = {};
        for (const item of state.roster ?? []) {
          const key = item.name.trim().toLowerCase();
          if (!key) continue;
          participants[key] = {
            name: item.name,
            sample_seconds: 0,
            sample_count: 0,
            status: "collecting"
          };
        }

        state.enrollment_state = {
          mode: "collecting",
          started_at: this.currentIsoTs(),
          stopped_at: null,
          participants,
          unassigned_clusters: {},
          updated_at: this.currentIsoTs()
        };
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          enrollment_state: state.enrollment_state,
          roster_count: state.roster?.length ?? 0
        });
      });
    }

    if (action === "enrollment-stop" && request.method === "POST") {
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
        enrollment.mode = "closed";
        enrollment.stopped_at = this.currentIsoTs();
        enrollment.updated_at = this.currentIsoTs();
        state.enrollment_state = enrollment;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          enrollment_state: state.enrollment_state
        });
      });
    }

    if (action === "enrollment-state" && request.method === "GET") {
      const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
      return jsonResponse({
        session_id: sessionId,
        enrollment_state: enrollment,
        participant_profiles: state.participant_profiles
      });
    }

    if (action === "enrollment-profiles" && request.method === "POST") {
      let payload: { participant_profiles: Array<{ name: string; centroid: number[]; sample_count?: number; sample_seconds?: number; status?: string }> };
      try {
        payload = await readJson<typeof payload>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      if (!Array.isArray(payload.participant_profiles) || payload.participant_profiles.length === 0) {
        return badRequest("participant_profiles must be a non-empty array");
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const profiles: ParticipantProfile[] = [];
        for (const p of payload.participant_profiles) {
          if (!p.name || !Array.isArray(p.centroid) || p.centroid.length === 0) continue;
          profiles.push({
            name: p.name,
            email: null,
            centroid: p.centroid,
            sample_count: p.sample_count ?? 1,
            sample_seconds: p.sample_seconds ?? 5,
            status: "ready"
          });
        }
        state.participant_profiles = profiles;
        const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
        const participants: Record<string, EnrollmentParticipantProgress> = {};
        for (const profile of profiles) {
          const key = profile.name.trim().toLowerCase();
          if (!key) continue;
          participants[key] = {
            name: profile.name,
            sample_seconds: profile.sample_seconds,
            sample_count: profile.sample_count,
            status: "ready"
          };
        }
        enrollment.mode = "ready";
        enrollment.participants = participants;
        enrollment.updated_at = this.currentIsoTs();
        state.enrollment_state = enrollment;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          profiles_count: profiles.length,
          enrollment_state: state.enrollment_state
        });
      });
    }

    if (action === "memos" && request.method === "POST") {
      if (!this.memosEnabled()) {
        return jsonResponse({ detail: "memos is disabled" }, 503);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readJson<Record<string, unknown>>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      return this.enqueueMutation(async () => {
        const nowMs = Date.now();
        const memos = await this.loadMemos();
        const memoId = nextMemoId(memos, nowMs);
        let item: MemoItem;
        try {
          item = parseMemoPayload(payload, { memoId, createdAtMs: nowMs });
        } catch (error) {
          return badRequest((error as Error).message);
        }
        memos.push(item);
        await this.storeMemos(memos);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        // NOTE: Do NOT force-refresh feedback cache on every memo POST.
        // Memos are stored in DO and included during finalization.
        // Forcing refresh here wastes LLM tokens (12+ memos = 12+ LLM calls).
        return jsonResponse({
          session_id: sessionId,
          memo: item,
          count: memos.length
        });
      });
    }

    if (action === "memos" && request.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "100");
      const fromMsRaw = Number(url.searchParams.get("from_ms"));
      const toMsRaw = Number(url.searchParams.get("to_ms"));
      const memos = await this.loadMemos();
      const items = filterMemos(memos, {
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        fromMs: Number.isFinite(fromMsRaw) ? fromMsRaw : null,
        toMs: Number.isFinite(toMsRaw) ? toMsRaw : null
      });
      return jsonResponse({
        session_id: sessionId,
        count: memos.length,
        items
      });
    }

    if (action === "feedback-ready" && request.method === "GET") {
      const cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      const cacheAgeMs = Math.max(0, Date.now() - Date.parse(cache.updated_at || this.currentIsoTs()));
      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        updated_at: cache.updated_at,
        cache_age_ms: cacheAgeMs,
        budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        timings: cache.timings,
        quality: cache.quality,
        report_source: cache.report_source,
        blocking_reason: cache.blocking_reason,
        quality_gate_passed: cache.quality_gate_passed
      });
    }

    if (action === "feedback-open" && request.method === "POST") {
      const startedAt = Date.now();
      let cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      if (!cache.report) {
        cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      }
      const elapsedMs = Date.now() - startedAt;
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }
      const withinBudget = elapsedMs <= FEEDBACK_TOTAL_BUDGET_MS;
      const openBlockingReason =
        cache.blocking_reason ??
        (withinBudget ? null : `feedback-open exceeded budget: opened_in_ms=${elapsedMs} target<=${FEEDBACK_TOTAL_BUDGET_MS}`);
      const isReady = (cache.ready ?? false) && withinBudget && ACCEPTED_REPORT_SOURCES.has(cache.report_source ?? "");
      return jsonResponse({
        session_id: sessionId,
        ready: isReady,
        within_budget: withinBudget,
        opened_in_ms: elapsedMs,
        budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        timings: cache.timings,
        quality: cache.quality,
        report_source: cache.report_source,
        blocking_reason: isReady ? null : openBlockingReason,
        quality_gate_passed: cache.quality_gate_passed,
        report: isReady ? cache.report : null
      });
    }

    if (action === "feedback-regenerate-claim" && request.method === "POST") {
      let payload: FeedbackRegenerateClaimRequest;
      try {
        payload = await readJson<FeedbackRegenerateClaimRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      const personKey = String(payload.person_key || "").trim();
      const claimType = payload.claim_type;
      const dimension = payload.dimension;
      if (!personKey || !claimType || !dimension) {
        return badRequest("person_key, dimension and claim_type are required");
      }

      const cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }

      const report = JSON.parse(JSON.stringify(cache.report)) as ResultV2;
      const lookup = this.findClaimInReport(report, {
        personKey,
        dimension,
        claimType,
        claimId: payload.claim_id
      });
      if (!lookup) {
        return jsonResponse({ detail: `person_key not found: ${personKey}` }, 404);
      }
      const targetClaim = lookup.claim;
      const hint = String(payload.text_hint || "").trim();
      const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
      const indexRefs = cache.evidence_index_cache[`${personKey}:${dimension}`] ?? [];
      const allowedEvidenceIds: string[] = [];
      const seen = new Set<string>();
      for (const ref of [...targetClaim.evidence_refs, ...indexRefs]) {
        const id = String(ref || "").trim();
        if (!id || !evidenceById.has(id) || seen.has(id)) continue;
        seen.add(id);
        allowedEvidenceIds.push(id);
      }
      if (allowedEvidenceIds.length === 0) {
        return jsonResponse(
          {
            detail: "claim regeneration requires evidence_refs; add evidence before regenerate",
            person_key: personKey,
            dimension
          },
          422
        );
      }
      const inferenceReq: InferenceRegenerateClaimRequest = {
        session_id: sessionId,
        person_key: personKey,
        display_name: lookup.person.display_name,
        dimension,
        claim_type: claimType,
        claim_id: targetClaim.claim_id,
        claim_text: targetClaim.text,
        text_hint: hint || undefined,
        allowed_evidence_ids: allowedEvidenceIds,
        evidence: report.evidence.map((item) => ({
          evidence_id: item.evidence_id,
          time_range_ms: item.time_range_ms,
          utterance_ids: item.utterance_ids,
          speaker_key:
            (item.speaker?.display_name as string | undefined) ??
            (item.speaker?.person_id as string | undefined) ??
            (item.speaker?.cluster_id as string | undefined) ??
            null,
          quote: item.quote,
          confidence: item.confidence
        })),
        transcript: report.transcript,
        memos: report.memos,
        stats: report.stats,
        locale: getSessionLocale(
          normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE)),
          this.env
        )
      };
      const regenResult = await this.invokeInferenceRegenerateClaim(inferenceReq);
      const regeneratedClaim = regenResult.data?.claim;
      if (!regeneratedClaim) {
        return jsonResponse({ detail: "inference regenerate claim returned empty claim" }, 503);
      }
      const sanitizedRefs = Array.isArray(regeneratedClaim.evidence_refs)
        ? regeneratedClaim.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (sanitizedRefs.length === 0) {
        return jsonResponse({ detail: "regenerated claim has empty evidence refs" }, 422);
      }
      const invalidRefs = sanitizedRefs.filter((ref) => !evidenceById.has(ref));
      if (invalidRefs.length > 0) {
        return jsonResponse({ detail: `regenerated claim references unknown evidence ids: ${invalidRefs.join(",")}` }, 422);
      }
      targetClaim.text = String(regeneratedClaim.text || "").trim() || targetClaim.text;
      targetClaim.evidence_refs = sanitizedRefs.slice(0, 3);
      targetClaim.confidence = Math.min(0.95, Math.max(0.35, Number(regeneratedClaim.confidence || targetClaim.confidence || 0.72)));

      const oldNeedsEvidenceCount = Number(report.quality?.needs_evidence_count || 0);
      const strictValidation = this.validateClaimEvidenceRefs(report);
      const validation = validatePersonFeedbackEvidence(report.per_person);
      if (!strictValidation.valid) {
        return jsonResponse({ detail: strictValidation.failures[0] || "claim validation failed" }, 422);
      }
      if (strictValidation.needsEvidenceCount > oldNeedsEvidenceCount) {
        return jsonResponse(
          {
            detail: "regeneration cannot increase needs_evidence_count",
            before: oldNeedsEvidenceCount,
            after: strictValidation.needsEvidenceCount
          },
          422
        );
      }
      const nowIso = this.currentIsoTs();
      report.quality = {
        ...report.quality,
        ...validation.quality,
        generated_at: nowIso,
        claim_count: strictValidation.claimCount,
        invalid_claim_count: strictValidation.invalidCount,
        needs_evidence_count: strictValidation.needsEvidenceCount,
        validation_ms: validation.quality.validation_ms,
        report_source: "llm_enhanced"
      };
      report.trace = {
        ...report.trace,
        report_pipeline: {
          mode: "memo_first_with_llm_polish",
          source: "llm_enhanced",
          llm_attempted: true,
          llm_success: true,
          llm_elapsed_ms: null,
          blocking_reason: null
        }
      };
      cache.updated_at = nowIso;
      cache.report = report;
      cache.person_summary_cache = report.per_person;
      cache.overall_summary_cache = report.overall;
      cache.quality = report.quality;
      cache.report_source = "llm_enhanced";
      cache.blocking_reason = null;
      cache.quality_gate_passed = cache.quality_gate_passed && strictValidation.valid;
      cache.ready = cache.quality_gate_passed && strictValidation.valid;
      await this.storeFeedbackCache(cache);

      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        quality: cache.quality,
        person: lookup.person
      });
    }

    if (action === "feedback-claim-evidence" && request.method === "POST") {
      let payload: FeedbackClaimEvidenceRequest;
      try {
        payload = await readJson<FeedbackClaimEvidenceRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      const personKey = String(payload.person_key || "").trim();
      const claimType = payload.claim_type;
      const dimension = payload.dimension;
      const evidenceRefs = Array.isArray(payload.evidence_refs)
        ? payload.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (!personKey || !claimType || !dimension) {
        return badRequest("person_key, dimension and claim_type are required");
      }
      if (evidenceRefs.length === 0) {
        return jsonResponse({ detail: "evidence_refs cannot be empty" }, 422);
      }
      const cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }
      const report = JSON.parse(JSON.stringify(cache.report)) as ResultV2;
      const lookup = this.findClaimInReport(report, {
        personKey,
        dimension,
        claimType,
        claimId: payload.claim_id
      });
      if (!lookup) {
        return jsonResponse({ detail: "claim not found" }, 404);
      }
      const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
      const unknownRefs = evidenceRefs.filter((ref) => !evidenceById.has(ref));
      if (unknownRefs.length > 0) {
        return jsonResponse({ detail: `unknown evidence ids: ${unknownRefs.slice(0, 5).join(",")}` }, 422);
      }
      const dedupedRefs: string[] = [];
      const seen = new Set<string>();
      for (const ref of evidenceRefs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        dedupedRefs.push(ref);
      }
      lookup.claim.evidence_refs = dedupedRefs.slice(0, 5);
      this.downWeightClaimConfidenceByEvidence(lookup.claim, evidenceById);

      const strictValidation = this.validateClaimEvidenceRefs(report);
      if (!strictValidation.valid) {
        return jsonResponse({ detail: strictValidation.failures[0] || "claim validation failed" }, 422);
      }
      const validation = validatePersonFeedbackEvidence(report.per_person);
      const nowIso = this.currentIsoTs();
      report.quality = {
        ...report.quality,
        ...validation.quality,
        generated_at: nowIso,
        claim_count: strictValidation.claimCount,
        invalid_claim_count: strictValidation.invalidCount,
        needs_evidence_count: strictValidation.needsEvidenceCount
      };
      cache.updated_at = nowIso;
      cache.report = report;
      cache.person_summary_cache = report.per_person;
      cache.overall_summary_cache = report.overall;
      cache.evidence_index_cache = this.buildEvidenceIndex(report.per_person);
      cache.quality = report.quality;
      cache.blocking_reason = null;
      cache.ready = cache.quality_gate_passed && strictValidation.valid
        && ACCEPTED_REPORT_SOURCES.has(cache.report_source);
      await this.storeFeedbackCache(cache);
      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        quality: cache.quality,
        claim: lookup.claim
      });
    }

    if (action === "export" && request.method === "POST") {
      let payload: FeedbackExportRequest = {};
      try {
        payload = await readJson<FeedbackExportRequest>(request);
      } catch {
        // keep empty payload for default format
      }
      const format = (payload.format ?? "plain_text") as "plain_text" | "markdown" | "docx";
      const fileStem = String(payload.file_name || `${sessionId}-feedback`).trim() || `${sessionId}-feedback`;
      const cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }

      if (format === "plain_text") {
        const content = buildReportExportText(cache.report);
        return jsonResponse({
          session_id: sessionId,
          format,
          file_name: `${fileStem}.txt`,
          mime_type: "text/plain; charset=utf-8",
          encoding: "utf-8",
          content
        });
      }

      if (format === "markdown") {
        const content = buildReportExportMarkdown(cache.report);
        return jsonResponse({
          session_id: sessionId,
          format,
          file_name: `${fileStem}.md`,
          mime_type: "text/markdown; charset=utf-8",
          encoding: "utf-8",
          content
        });
      }

      const text = buildReportExportText(cache.report);
      const docxBytes = buildDocxBytesFromText(text);
      return jsonResponse({
        session_id: sessionId,
        format: "docx",
        file_name: `${fileStem}.docx`,
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        encoding: "base64",
        content: bytesToBase64(docxBytes)
      });
    }

    if (action === "speaker-logs" && request.method === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await readJson<Record<string, unknown>>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      return this.enqueueMutation(async () => {
        const now = this.currentIsoTs();
        const current = await this.loadSpeakerLogs();
        let parsed: SpeakerLogs;
        try {
          parsed = parseSpeakerLogsPayload(payload, now);
        } catch (error) {
          return badRequest((error as Error).message);
        }
        const merged = mergeSpeakerLogs(current, parsed);
        await this.storeSpeakerLogs(merged);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);

        // Async embedding extraction — non-blocking background work.
        // Populates the EmbeddingCache for global clustering at finalization.
        if (merged.source === "edge" && merged.turns.length > 0) {
          const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
          if (state.config?.diarization_backend === "edge") {
            this.ctx.waitUntil(
              this.extractEmbeddingsForTurns(sessionId, merged, "students")
                .catch(() => { /* non-critical: clustering works with partial embeddings */ })
            );
          }
        }

        return jsonResponse({
          session_id: sessionId,
          source: merged.source,
          turns: merged.turns.length,
          clusters: merged.clusters.length,
          speaker_map: merged.speaker_map.length,
          embedding_cache_size: this.embeddingCache.size,
          updated_at: merged.updated_at
        });
      });
    }

    if (action === "finalize-status" && request.method === "GET") {
      const status = await this.failStuckFinalizeIfNeeded("status-poll");
      if (!status) {
        return jsonResponse({
          session_id: sessionId,
          status: "idle",
          stage: "idle",
          progress: 0,
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2"
        });
      }
      const jobId = String(url.searchParams.get("job_id") ?? "").trim();
      if (jobId && jobId !== status.job_id) {
        return jsonResponse({ detail: "job_id not found", job_id: jobId }, 404);
      }
      return jsonResponse({
        session_id: sessionId,
        ...status
      });
    }

    if (action === "cluster-map" && request.method === "POST") {
      let payload: ClusterMapRequest;
      try {
        payload = await readJson<ClusterMapRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }
      const streamRole = parseStreamRole(payload.stream_role ?? "students", "students");
      if (streamRole !== "students") {
        return badRequest("cluster-map only supports stream_role=students");
      }
      const clusterId = String(payload.cluster_id ?? "").trim();
      const participantNameRaw = String(payload.participant_name ?? "").trim();
      const mode = payload.mode === "prebind" ? "prebind" : "bind";
      if (!clusterId || !participantNameRaw) {
        return badRequest("cluster_id and participant_name are required");
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const participantName = this.rosterNameByCandidate(state, participantNameRaw) ?? participantNameRaw;
        const now = this.currentIsoTs();
        const existingCluster = state.clusters.find((cluster) => cluster.cluster_id === clusterId);
        if (!existingCluster) {
          if (mode !== "prebind") {
            return jsonResponse(
              {
                detail: "cluster_id not found in state.clusters",
                cluster_id: clusterId,
                available_cluster_ids: state.clusters.map((item) => item.cluster_id)
              },
              400
            );
          }
          state.prebind_by_cluster[clusterId] = {
            participant_name: participantName,
            source: "manual_map",
            confidence: 1,
            locked: payload.lock !== false,
            updated_at: now
          };
          await this.ctx.storage.put(STORAGE_KEY_STATE, state);
          await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);
          return jsonResponse({
            session_id: sessionId,
            cluster_id: clusterId,
            participant_name: participantName,
            mode: "prebind",
            binding_locked: payload.lock !== false,
            prebind_meta: state.prebind_by_cluster[clusterId]
          });
        }

        state.bindings[clusterId] = participantName;
        existingCluster.bound_name = participantName;
        delete state.prebind_by_cluster[clusterId];
        state.cluster_binding_meta[clusterId] = {
          participant_name: participantName,
          source: "manual_map",
          confidence: 1,
          locked: payload.lock !== false,
          updated_at: now
        }
        if (state.enrollment_state?.unassigned_clusters?.[clusterId]) {
          delete state.enrollment_state.unassigned_clusters[clusterId];
          state.enrollment_state.updated_at = now;
        }
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);
        await this.appendSpeakerEvent({
          ts: now,
          stream_role: "students",
          source: "manual_map",
          identity_source: "manual_map",
          utterance_id: null,
          cluster_id: clusterId,
          speaker_name: participantName,
          decision: "auto",
          evidence: null,
          note: `cluster ${clusterId} mapped to ${participantName}`,
          backend: "worker",
          fallback_reason: null,
          confidence_bucket: "high",
          metadata: {
            binding_locked: payload.lock !== false
          }
        });
        return jsonResponse({
          session_id: sessionId,
          cluster_id: clusterId,
          participant_name: participantName,
          mode: "bind",
          binding_locked: payload.lock !== false,
          cluster_binding_meta: state.cluster_binding_meta[clusterId]
        });
      });
    }

    if (action === "unresolved-clusters" && request.method === "GET") {
      const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const events = await this.loadSpeakerEvents();
      const utterances = await this.loadUtterancesRawByStream();
      const utteranceById = new Map(utterances.students.map((item) => [item.utterance_id, item]));
      const recentStudentEvents = events.filter((item) => item.stream_role === "students");
      const latestByCluster = new Map<string, SpeakerEvent>();
      for (const event of recentStudentEvents) {
        if (!event.cluster_id) continue;
        latestByCluster.set(event.cluster_id, event);
      }
      const items = state.clusters
        .map((cluster) => {
          const meta = state.cluster_binding_meta[cluster.cluster_id];
          const latest = latestByCluster.get(cluster.cluster_id);
          const utterance =
            latest?.utterance_id && utteranceById.has(latest.utterance_id) ? utteranceById.get(latest.utterance_id) : null;
          const unresolved = !state.bindings[cluster.cluster_id] || (meta ? !meta.locked : true);
          return {
            cluster_id: cluster.cluster_id,
            sample_count: cluster.sample_count,
            bound_name: cluster.bound_name ?? null,
            unresolved,
            binding_meta: meta ?? null,
            latest_decision: latest?.decision ?? null,
            latest_text: utterance?.text ?? null,
            latest_ts: latest?.ts ?? null
          };
        })
        .filter((item) => item.unresolved || item.latest_decision === "unknown");
      return jsonResponse({
        session_id: sessionId,
        count: items.length,
        items
      });
    }

    if (action === "events" && request.method === "GET") {
      const streamRoleRaw = url.searchParams.get("stream_role");
      let filteredRole: StreamRole | null = null;
      if (streamRoleRaw) {
        try {
          filteredRole = parseStreamRole(streamRoleRaw, "mixed");
        } catch (error) {
          return badRequest((error as Error).message);
        }
      }
      const urlLimit = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isInteger(urlLimit) && urlLimit > 0 ? Math.min(urlLimit, 2000) : 100;
      const events = await this.loadSpeakerEvents();
      const scoped = filteredRole ? events.filter((item) => item.stream_role === filteredRole) : events;
      const normalizedItems = scoped.slice(-limit).map((item) => ({
        ...item,
        backend: item.backend ?? (item.source === "inference_resolve" ? "primary" : "worker"),
        fallback_reason: item.fallback_reason ?? null,
        confidence_bucket: item.confidence_bucket ?? this.confidenceBucketFromEvidence(item.evidence)
      }));
      return jsonResponse({
        session_id: sessionId,
        stream_role: filteredRole ?? "all",
        count: scoped.length,
        limit,
        items: normalizedItems
      });
    }

    if (action === "utterances" && request.method === "GET") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const view = String(url.searchParams.get("view") ?? "raw").trim().toLowerCase();
      if (!["raw", "merged"].includes(view)) {
        return badRequest("view must be raw or merged");
      }

      const urlLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(urlLimit) && urlLimit > 0 ? Math.min(urlLimit, 1000) : 50;

      if (view === "raw") {
        const raw = await this.loadUtterancesRawByStream();
        const items = raw[streamRole].slice(-limit);
        return jsonResponse({
          session_id: sessionId,
          stream_role: streamRole,
          view,
          count: raw[streamRole].length,
          limit,
          items
        });
      }

      const raw = await this.loadUtterancesRawByStream();
      const merged = await this.loadUtterancesMergedByStream();
      merged[streamRole] = mergeUtterances(raw[streamRole]);
      await this.storeUtterancesMergedByStream(merged);
      const items = merged[streamRole].slice(-limit);
      return jsonResponse({
        session_id: sessionId,
        stream_role: streamRole,
        view,
        count: merged[streamRole].length,
        limit,
        items
      });
    }

    if (action === "asr-run" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const queryMax = Number(url.searchParams.get("max_windows") ?? "0");
      const maxWindows = Number.isInteger(queryMax) && queryMax > 0 ? queryMax : 0;
      const result = await this.maybeRunAsrWindows(sessionId, streamRole, true, maxWindows);
      return jsonResponse({
        session_id: sessionId,
        stream_role: streamRole,
        ...result
      });
    }

    if (action === "asr-reset" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }

      return this.enqueueMutation(async () => {
        const [asrByStream, rawByStream, mergedByStream, events] = await Promise.all([
          this.loadAsrByStream(),
          this.loadUtterancesRawByStream(),
          this.loadUtterancesMergedByStream(),
          this.loadSpeakerEvents()
        ]);

        const removedRaw = rawByStream[streamRole].length;
        const removedMerged = mergedByStream[streamRole].length;
        const removedEvents = events.filter((item) => item.stream_role === streamRole).length;

        rawByStream[streamRole] = [];
        mergedByStream[streamRole] = [];
        asrByStream[streamRole] = this.buildDefaultAsrState();

        await this.storeUtterancesRawByStream(rawByStream);
        await this.storeUtterancesMergedByStream(mergedByStream);
        await this.storeAsrByStream(asrByStream);
        await this.storeSpeakerEvents(events.filter((item) => item.stream_role !== streamRole));
        await this.closeRealtimeAsrSession(streamRole, "asr-reset", true);
        await this.patchAsrCursor(streamRole, {
          last_ingested_seq: 0,
          last_sent_seq: 0,
          last_emitted_seq: 0
        });

        return jsonResponse({
          session_id: sessionId,
          stream_role: streamRole,
          removed_raw: removedRaw,
          removed_merged: removedMerged,
          removed_events: removedEvents,
          message: "asr state and utterances reset; chunks kept in R2"
        });
      });
    }

    if (action === "tier2-status" && request.method === "GET") {
      const tier2 = await this.loadTier2Status();
      return jsonResponse({
        session_id: sessionId,
        ...tier2
      });
    }

    if (action === "result" && request.method === "GET") {
      const version = String(url.searchParams.get("version") ?? "v1").trim().toLowerCase();
      const key =
        version === "v2"
          ? (await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2)) ?? resultObjectKeyV2(sessionId)
          : (await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY)) ?? resultObjectKey(sessionId);
      const object = await this.env.RESULT_BUCKET.get(key);
      if (!object) {
        return jsonResponse({ detail: `result not found for version=${version}` }, 404);
      }
      const content = await object.text();
      return new Response(content, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-result-version": version
        }
      });
    }

    if (action === "resolve" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
      const scopedIdemKey = idempotencyKey ? `${streamRole}:${idempotencyKey}` : "";
      if (scopedIdemKey) {
        const cached = await this.ctx.storage.get<ResolveResponse>(`idempotency:${scopedIdemKey}`);
        if (cached) {
          return jsonResponse(cached, 200, { "x-idempotent-replay": "true" });
        }
      }

      let payload: ResolveRequest;
      try {
        payload = await readJson<ResolveRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      if (!payload?.audio?.content_b64 || !payload?.audio?.format) {
        return badRequest("audio.content_b64 and audio.format are required");
      }

      return this.enqueueMutation(async () => {
        const currentState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        if (payload.roster && payload.roster.length > 0) {
          currentState.roster = payload.roster;
        }

        let resolved: ResolveResponse;
        let resolveBackend: "primary" | "secondary" = "primary";
        let degraded = false;
        let resolveWarnings: string[] = [];
        let resolveTimeline: InferenceBackendTimelineItem[] = [];
        try {
          const resolveCall = await this.invokeInferenceResolve(sessionId, payload.audio, payload.asr_text ?? null, currentState);
          resolved = resolveCall.resolved;
          resolveBackend = resolveCall.backend;
          degraded = resolveCall.degraded;
          resolveWarnings = resolveCall.warnings;
          resolveTimeline = resolveCall.timeline;
        } catch (error) {
          return jsonResponse({ detail: `inference request failed: ${(error as Error).message}` }, 502);
        }

        const mergedState = normalizeSessionState({
          ...resolved.updated_state,
          capture_by_stream: currentState.capture_by_stream
        });
        resolved.updated_state = mergedState;
        const boundSpeakerName =
          resolved.speaker_name ??
          mergedState.bindings[resolved.cluster_id] ??
          mergedState.clusters.find((item) => item.cluster_id === resolved.cluster_id)?.bound_name ??
          null;
        resolved.speaker_name = boundSpeakerName;
        await this.ctx.storage.put(STORAGE_KEY_STATE, mergedState);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());

        await this.appendSpeakerEvent({
          ts: new Date().toISOString(),
          stream_role: streamRole,
          source: "inference_resolve",
          identity_source: identitySourceFromBindingSource(resolved.evidence.binding_source),
          utterance_id: null,
          cluster_id: resolved.cluster_id,
          speaker_name: boundSpeakerName,
          decision: resolved.decision,
          evidence: resolved.evidence,
          backend: resolveBackend,
          fallback_reason: degraded ? "inference_failover" : null,
          confidence_bucket: this.confidenceBucketFromEvidence(resolved.evidence),
          metadata: {
            profile_score: resolved.evidence.profile_top_score ?? null,
            profile_margin: resolved.evidence.profile_margin ?? null,
            binding_locked: mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false,
            warnings: resolveWarnings,
            timeline: resolveTimeline
          }
        });

        if (scopedIdemKey) {
          await this.ctx.storage.put(`idempotency:${scopedIdemKey}`, resolved);
        }

        return jsonResponse(resolved);
      });
    }

    if (action === "finalize" && request.method === "POST") {
      let payload: FinalizeRequest = {};
      try {
        payload = await readJson<FinalizeRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const version = String(url.searchParams.get("version") ?? "v1").trim().toLowerCase();
      if (version === "v2") {
        if (!this.finalizeV2Enabled()) {
          return jsonResponse({ detail: "finalize v2 is disabled" }, 503);
        }
        await this.failStuckFinalizeIfNeeded("enqueue");
        const current = await this.loadFinalizeV2Status();
        if (current && (current.status === "queued" || current.status === "running")) {
          return jsonResponse({
            session_id: sessionId,
            job_id: current.job_id,
            status: current.status,
            stage: current.stage,
            progress: current.progress,
            warnings: current.warnings,
            degraded: current.degraded,
            backend_used: current.backend_used,
            version: "v2"
          });
        }
        const nextStatus: FinalizeV2Status = {
          job_id: `fv2_${crypto.randomUUID()}`,
          status: "queued",
          stage: "freeze",
          progress: 0,
          errors: [],
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2",
          started_at: this.currentIsoTs(),
          heartbeat_at: this.currentIsoTs(),
          finished_at: null
        };
        await this.storeFinalizeV2Status(nextStatus);
        this.ctx.waitUntil(
          this.enqueueMutation(async () => {
            await this.runFinalizeV2Job(sessionId, nextStatus.job_id, payload.metadata ?? {});
          })
        );
        return jsonResponse({
          session_id: sessionId,
          job_id: nextStatus.job_id,
          status: "queued",
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2"
        });
      }

      const [state, events, ingestByStream, rawByStream, mergedByStream, asrByStream] = await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.loadSpeakerEvents(),
        this.loadIngestByStream(sessionId),
        this.loadUtterancesRawByStream(),
        this.loadUtterancesMergedByStream(),
        this.loadAsrByStream()
      ]);
      mergedByStream.mixed = mergeUtterances(rawByStream.mixed);
      mergedByStream.teacher = mergeUtterances(rawByStream.teacher);
      mergedByStream.students = mergeUtterances(rawByStream.students);
      await this.storeUtterancesMergedByStream(mergedByStream);

      const finalizedAt = new Date().toISOString();
      const normalizedState = normalizeSessionState(state);
      const result = {
        session_id: sessionId,
        finalized_at: finalizedAt,
        state: normalizedState,
        events,
        ingest: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
        ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream),
        capture_by_stream: normalizedState.capture_by_stream,
        enrollment_state: normalizedState.enrollment_state,
        participant_profiles: normalizedState.participant_profiles,
        cluster_binding_meta: normalizedState.cluster_binding_meta,
        asr: asrByStream.mixed,
        asr_by_stream: asrByStream,
        utterances_raw: rawByStream.mixed,
        utterances_raw_by_stream: rawByStream,
        utterances_merged_by_stream: mergedByStream,
        metadata: payload.metadata ?? {}
      };

      const key = resultObjectKey(sessionId);
      await this.env.RESULT_BUCKET.put(key, JSON.stringify(result), {
        httpMetadata: {
          contentType: "application/json"
        }
      });

      await this.ctx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
      await this.ctx.storage.put(STORAGE_KEY_RESULT_KEY, key);

      return jsonResponse({
        session_id: sessionId,
        result_key: key,
        event_count: events.length,
        finalized_at: finalizedAt
      });
    }

    return jsonResponse({ detail: "route not found" }, 404);
  }
}
