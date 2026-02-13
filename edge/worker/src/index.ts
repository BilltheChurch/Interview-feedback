import { DurableObject } from "cloudflare:workers";
import {
  attachEvidenceToMemos,
  buildEvidence,
  buildMemoFirstReport,
  buildReportExportMarkdown,
  buildReportExportText,
  buildResultV2,
  computeSpeakerStats,
  validatePersonFeedbackEvidence
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { filterMemos, nextMemoId, parseMemoPayload } from "./memos";
import { emptySpeakerLogs, mergeSpeakerLogs, parseSpeakerLogsPayload } from "./speaker_logs";
import type {
  FinalizeV2Status,
  MemoItem,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SpeakerStatItem,
  SpeakerLogs
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
  config: Record<string, string | number | boolean>;
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
  diarization_backend?: "cloud" | "edge";
  mode?: "1v1" | "group";
  template_id?: string;
  booking_ref?: string;
  teams_join_url?: string;
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
  asr_provider: "dashscope";
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
  asr_provider: "dashscope";
  created_at: string;
  source_utterance_ids: string[];
}

interface FeedbackTimings {
  assemble_ms: number;
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
  INFERENCE_API_KEY?: string;
  INFERENCE_TIMEOUT_MS?: string;
  INFERENCE_RESOLVE_PATH?: string;
  INFERENCE_ENROLL_PATH?: string;
  INFERENCE_EVENTS_PATH?: string;
  INFERENCE_REPORT_PATH?: string;
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
  DIARIZATION_BACKEND_DEFAULT?: "cloud" | "edge";
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
    needs_evidence_count: 0
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
      validation_ms: 0,
      persist_ms: 0,
      total_ms: 0
    }
  };
}

const SESSION_ROUTE_REGEX =
  /^\/v1\/sessions\/([^/]+)\/(resolve|state|finalize|utterances|asr-run|asr-reset|config|events|cluster-map|unresolved-clusters|memos|speaker-logs|result|feedback-ready|feedback-open|feedback-regenerate-claim|export)$/;
const SESSION_ENROLL_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/enrollment\/(start|stop|state)$/;
const SESSION_FINALIZE_STATUS_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/finalize\/status$/;
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
const STORAGE_KEY_MEMOS = "memos";
const STORAGE_KEY_SPEAKER_LOGS = "speaker_logs";
const STORAGE_KEY_ASR_CURSOR_BY_STREAM = "asr_cursor_by_stream";
const STORAGE_KEY_FEEDBACK_CACHE = "feedback_cache";

const STORAGE_KEY_INGEST_STATE = "ingest_state";
const STORAGE_KEY_ASR_STATE = "asr_state";
const STORAGE_KEY_UTTERANCES_RAW = "utterances_raw";

const STORAGE_KEY_INGEST_BY_STREAM = "ingest_by_stream";
const STORAGE_KEY_ASR_BY_STREAM = "asr_by_stream";
const STORAGE_KEY_UTTERANCES_RAW_BY_STREAM = "utterances_raw_by_stream";
const STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM = "utterances_merged_by_stream";

const TARGET_FORMAT = "pcm_s16le";
const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1;
const ONE_SECOND_PCM_BYTES = 32000;
const INFERENCE_MAX_AUDIO_SECONDS = 30;
const DASHSCOPE_DEFAULT_WS_URL = "wss://dashscope.aliyuncs.com/api-ws/v1/inference/";
const DASHSCOPE_DEFAULT_MODEL = "fun-asr-realtime-2025-11-07";
const FEEDBACK_REFRESH_INTERVAL_MS = 10_000;
const FEEDBACK_TOTAL_BUDGET_MS = 3_000;
const FEEDBACK_ASSEMBLE_BUDGET_MS = 900;
const FEEDBACK_VALIDATE_BUDGET_MS = 600;
const FEEDBACK_PERSIST_FETCH_BUDGET_MS = 700;

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

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function decodeBase64ToBytes(contentB64: string): Uint8Array {
  const binary = atob(contentB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x2000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, item) => acc + item.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

function pcm16ToWavBytes(pcm: Uint8Array, sampleRate = TARGET_SAMPLE_RATE, channels = TARGET_CHANNELS): Uint8Array {
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);

  const encoder = new TextEncoder();
  header.set(encoder.encode("RIFF"), 0);
  view.setUint32(4, 36 + pcm.byteLength, true);
  header.set(encoder.encode("WAVE"), 8);
  header.set(encoder.encode("fmt "), 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  header.set(encoder.encode("data"), 36);
  view.setUint32(40, pcm.byteLength, true);

  return concatUint8Arrays([header, pcm]);
}

function truncatePcm16WavToSeconds(
  wavBytes: Uint8Array,
  maxSeconds: number,
  sampleRate = TARGET_SAMPLE_RATE,
  channels = TARGET_CHANNELS
): Uint8Array {
  const maxPcmBytes = Math.max(0, Math.floor(maxSeconds * sampleRate * channels * 2));
  if (maxPcmBytes <= 0 || wavBytes.byteLength <= 44) {
    return wavBytes;
  }

  const pcm = wavBytes.subarray(44);
  if (pcm.byteLength <= maxPcmBytes) {
    return wavBytes;
  }

  return pcm16ToWavBytes(pcm.subarray(0, maxPcmBytes), sampleRate, channels);
}

function tailPcm16BytesToWavForSeconds(
  pcmBytes: Uint8Array,
  seconds: number,
  sampleRate = TARGET_SAMPLE_RATE,
  channels = TARGET_CHANNELS
): Uint8Array {
  const maxPcmBytes = Math.max(ONE_SECOND_PCM_BYTES, Math.floor(seconds * sampleRate * channels * 2));
  if (pcmBytes.byteLength <= maxPcmBytes) {
    return pcm16ToWavBytes(pcmBytes, sampleRate, channels);
  }
  const offset = Math.max(0, pcmBytes.byteLength - maxPcmBytes);
  return pcm16ToWavBytes(pcmBytes.subarray(offset), sampleRate, channels);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeUtf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function makeZipStored(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = encodeUtf8(file.name);
    const fileData = file.data;
    const crc = crc32(fileData);
    const localHeader = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, fileData.length, true);
    localView.setUint32(22, fileData.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);
    chunks.push(localHeader, fileData);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, fileData.length, true);
    centralView.setUint32(24, fileData.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);
    centralChunks.push(centralHeader);

    offset += localHeader.length + fileData.length;
  }

  const centralSize = centralChunks.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, 0, true);

  return concatUint8Arrays([...chunks, ...centralChunks, end]);
}

function xmlEscape(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildDocxBytesFromText(content: string): Uint8Array {
  const paragraphXml = content
    .split(/\r?\n/)
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>`)
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
 xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
 xmlns:v="urn:schemas-microsoft-com:vml"
 xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
 xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
 xmlns:w10="urn:schemas-microsoft-com:office:word"
 xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
 xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
 xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
 xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
 xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
 xmlns:wne="http://schemas.microsoft.com/office/2006/wordml"
 xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
 mc:Ignorable="w14 w15 wp14">
 <w:body>${paragraphXml}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>
</w:document>`;
  return makeZipStored([
    { name: "[Content_Types].xml", data: encodeUtf8(contentTypes) },
    { name: "_rels/.rels", data: encodeUtf8(rels) },
    { name: "word/document.xml", data: encodeUtf8(documentXml) }
  ]);
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
  const patterns = [
    /\bmy name is\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\bi am\s+([A-Za-z][A-Za-z .'-]{0,60})/i,
    /\bi'm\s+([A-Za-z][A-Za-z .'-]{0,60})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || !match[1]) continue;
    const cleaned = match[1].trim().replace(/\s+/g, " ").replace(/[.,;:!?]+$/, "");
    if (cleaned.length >= 2 && cleaned.length <= 80) {
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
    out.push({ name, email });
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
    merged.config.diarization_backend = "cloud";
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
      const asrEnabled = parseBool(env.ASR_ENABLED, true) && Boolean((env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim());
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
        stream_roles: STREAM_ROLES
      });
    }

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.asrRealtimeByStream = {
      mixed: this.buildRealtimeRuntime("mixed"),
      teacher: this.buildRealtimeRuntime("teacher"),
      students: this.buildRealtimeRuntime("students")
    };
  }

  async alarm(): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.failStuckFinalizeIfNeeded("alarm");
    });
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
    return this.env.DIARIZATION_BACKEND_DEFAULT === "edge" ? "edge" : "cloud";
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
    let fuzzy: string | null = null;
    for (const item of roster) {
      const rosterNorm = item.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (!rosterNorm) continue;
      if (rosterNorm === normalized) {
        return item.name;
      }
      if (normalized.length >= 4 && (normalized.includes(rosterNorm) || rosterNorm.includes(normalized))) {
        fuzzy = item.name;
      }
    }
    return fuzzy;
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

  private async callInferenceEnroll(
    sessionId: string,
    participantName: string,
    audio: AudioPayload,
    state: SessionState
  ): Promise<InferenceEnrollResponse> {
    const enrollPath = this.env.INFERENCE_ENROLL_PATH ?? "/speaker/enroll";
    const baseUrl = normalizeBaseUrl(this.env.INFERENCE_BASE_URL);
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(baseUrl + enrollPath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.env.INFERENCE_API_KEY ? { "x-api-key": this.env.INFERENCE_API_KEY } : {})
        },
        body: JSON.stringify({
          session_id: sessionId,
          participant_name: participantName,
          audio,
          state
        } satisfies InferenceEnrollRequest),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const payloadText = await response.text();
    if (!response.ok) {
      throw new Error(`inference enroll non-success: status=${response.status} body=${payloadText.slice(0, 240)}`);
    }
    try {
      return JSON.parse(payloadText) as InferenceEnrollResponse;
    } catch {
      throw new Error("inference enroll returned non-JSON response");
    }
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
      lastFinalTextNorm: ""
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
    const hasKey = Boolean((this.env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim());
    return parseBool(this.env.ASR_ENABLED, true) && hasKey;
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
      return existing;
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
    eventDecision: "auto" | "confirm" | "unknown" | null
  ): { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null } {
    if (!clusterId) {
      if (eventSpeakerName) {
        return {
          speaker_name: eventSpeakerName,
          decision: eventDecision ?? "confirm"
        };
      }
      return { speaker_name: null, decision: "unknown" };
    }
    const bound = state.bindings[clusterId] ?? null;
    const meta = state.cluster_binding_meta[clusterId];
    if (meta?.locked && bound) return { speaker_name: bound, decision: "auto" };
    if (meta?.source === "manual_map" && bound) return { speaker_name: bound, decision: "auto" };
    if (meta?.source === "enrollment_match" && bound) return { speaker_name: bound, decision: "auto" };
    if (meta?.source === "name_extract" && bound) return { speaker_name: bound, decision: "confirm" };
    if (bound) return { speaker_name: bound, decision: "auto" };
    if (eventSpeakerName) {
      return {
        speaker_name: eventSpeakerName,
        decision: eventDecision ?? "confirm"
      };
    }
    return { speaker_name: null, decision: "unknown" };
  }

  private buildTranscriptForFeedback(
    state: SessionState,
    rawByStream: Record<StreamRole, UtteranceRaw[]>,
    events: SpeakerEvent[],
    speakerLogsStored: SpeakerLogs,
    diarizationBackend: "cloud" | "edge"
  ): TranscriptItem[] {
    const eventByUtterance = new Map(
      events
        .filter((item) => item.stream_role === "students" && item.utterance_id)
        .map((item) => [item.utterance_id as string, item])
    );
    const teacherEventByUtterance = new Map(
      events
        .filter((item) => item.stream_role === "teacher" && item.utterance_id)
        .map((item) => [item.utterance_id as string, item])
    );
    const edgeTurns =
      diarizationBackend === "edge"
        ? [...speakerLogsStored.turns]
            .filter((item) => item.stream_role === "students")
            .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
        : [];
    const inferStudentsClusterFromEdgeTurns = (startMs: number, endMs: number): string | null => {
      if (edgeTurns.length === 0) return null;
      let bestCluster: string | null = null;
      let bestOverlap = 0;
      for (const turn of edgeTurns) {
        const overlap = Math.min(endMs, turn.end_ms) - Math.max(startMs, turn.start_ms);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestCluster = turn.cluster_id;
        }
      }
      return bestOverlap > 0 ? bestCluster : null;
    };

    return [...rawByStream.teacher, ...rawByStream.students]
      .map((item) => {
        const event =
          item.stream_role === "teacher"
            ? teacherEventByUtterance.get(item.utterance_id)
            : eventByUtterance.get(item.utterance_id);
        const inferredStudentsCluster =
          item.stream_role === "students" && diarizationBackend === "edge"
            ? inferStudentsClusterFromEdgeTurns(item.start_ms, item.end_ms)
            : null;
        const clusterId =
          event?.cluster_id ??
          (item.stream_role === "students" ? inferredStudentsCluster : "teacher");
        const reconciled =
          item.stream_role === "students"
            ? this.resolveStudentBindingForFeedback(
                state,
                clusterId ?? null,
                event?.speaker_name ?? null,
                event?.decision ?? null
              )
            : {
                speaker_name: event?.speaker_name ?? null,
                decision: event?.decision ?? null
              };
        return {
          utterance_id: item.utterance_id,
          stream_role: item.stream_role,
          cluster_id: clusterId ?? null,
          speaker_name: reconciled.speaker_name,
          decision: reconciled.decision,
          text: item.text,
          start_ms: item.start_ms,
          end_ms: item.end_ms,
          duration_ms: item.duration_ms
        } satisfies TranscriptItem;
      })
      .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);
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
    const [stateRaw, events, rawByStream, memos, speakerLogsStored] = await Promise.all([
      this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
      this.loadSpeakerEvents(),
      this.loadUtterancesRawByStream(),
      this.loadMemos(),
      this.loadSpeakerLogs()
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

    const validateStart = Date.now();
    const validation = validatePersonFeedbackEvidence(memoFirst.per_person);
    const validationMs = Date.now() - validateStart;

    const unresolvedClusterCount = state.clusters.filter((cluster) => {
      const bound = state.bindings[cluster.cluster_id];
      const meta = state.cluster_binding_meta[cluster.cluster_id];
      return !bound || !meta || !meta.locked;
    }).length;
    const tentative = unresolvedClusterCount > 0;
    const finalizedAt = this.currentIsoTs();
    const quality: ReportQualityMeta = {
      ...validation.quality,
      generated_at: finalizedAt,
      build_ms: assembleMs,
      validation_ms: validationMs
    };

    const result = buildResultV2({
      sessionId,
      finalizedAt,
      tentative,
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
      overall: memoFirst.overall,
      perPerson: memoFirst.per_person,
      quality,
      finalizeJobId: `feedback-open-${crypto.randomUUID()}`,
      modelVersions: {
        asr: DASHSCOPE_DEFAULT_MODEL,
        analysis_events_path: this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
        analysis_report_path: this.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
        summary_mode: "memo_first"
      },
      thresholds: {
        feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
        feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
        feedback_persist_fetch_budget_ms: FEEDBACK_PERSIST_FETCH_BUDGET_MS
      }
    });

    const nextCache: FeedbackCache = {
      session_id: sessionId,
      updated_at: finalizedAt,
      ready: validation.valid,
      person_summary_cache: memoFirst.per_person,
      overall_summary_cache: memoFirst.overall,
      evidence_index_cache: this.buildEvidenceIndex(memoFirst.per_person),
      report: result,
      quality,
      timings: {
        assemble_ms: assembleMs,
        validation_ms: validationMs,
        persist_ms: 0,
        total_ms: 0
      }
    };
    const persistStart = Date.now();
    await this.storeFeedbackCache(nextCache);
    const persistMs = Date.now() - persistStart;
    const totalMs = Date.now() - totalStart;
    const meetsBudget =
      totalMs <= FEEDBACK_TOTAL_BUDGET_MS &&
      assembleMs <= FEEDBACK_ASSEMBLE_BUDGET_MS &&
      validationMs <= FEEDBACK_VALIDATE_BUDGET_MS &&
      persistMs <= FEEDBACK_PERSIST_FETCH_BUDGET_MS;
    nextCache.timings.persist_ms = persistMs;
    nextCache.timings.total_ms = totalMs;
    nextCache.ready = validation.valid && meetsBudget;
    await this.storeFeedbackCache(nextCache);
    return nextCache;
  }

  private async loadFinalizeV2Status(): Promise<FinalizeV2Status | null> {
    const stored = (await this.ctx.storage.get<FinalizeV2Status>(STORAGE_KEY_FINALIZE_V2_STATUS)) ?? null;
    if (!stored) return null;
    const heartbeat = typeof stored.heartbeat_at === "string" ? stored.heartbeat_at : stored.started_at;
    if (!heartbeat) return stored;
    if (stored.heartbeat_at === heartbeat) return stored;
    const normalized: FinalizeV2Status = {
      ...stored,
      heartbeat_at: heartbeat
    };
    await this.ctx.storage.put(STORAGE_KEY_FINALIZE_V2_STATUS, normalized);
    return normalized;
  }

  private async storeFinalizeV2Status(status: FinalizeV2Status): Promise<void> {
    const normalized: FinalizeV2Status = {
      ...status,
      heartbeat_at: status.heartbeat_at ?? status.started_at ?? this.currentIsoTs()
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
          metadata: {
            profile_score: resolvedInfo?.evidence?.profile_top_score ?? null,
            profile_margin: resolvedInfo?.evidence?.profile_margin ?? null,
            binding_locked: false
          }
        });
      }
    } else if (streamRole === "teacher") {
      await this.appendTeacherSpeakerEvent(sessionId, utterance);
    }
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

    runtime.flushPromise = (async () => {
      while (runtime.sendQueue.length > 0) {
        try {
          let lastSentSeq = runtime.lastSentSeq;
          await this.ensureRealtimeAsrConnected(sessionId, streamRole);
          if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
            throw new Error("dashscope websocket is not open");
          }

          while (runtime.sendQueue.length > 0) {
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
          await this.refreshAsrStreamMetrics(sessionId, streamRole, {
            asr_ws_state: "error",
            last_error: (error as Error).message
          });
          await this.closeRealtimeAsrSession(streamRole, "reconnect", false, false);
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
  ): Promise<ResolveResponse> {
    const resolvePath = this.env.INFERENCE_RESOLVE_PATH ?? "/speaker/resolve";
    const baseUrl = normalizeBaseUrl(this.env.INFERENCE_BASE_URL);
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    let inferenceResponse: Response;
    try {
      inferenceResponse = await fetch(baseUrl + resolvePath, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.env.INFERENCE_API_KEY
            ? { "x-api-key": this.env.INFERENCE_API_KEY }
            : {})
        },
        body: JSON.stringify({
          session_id: sessionId,
          audio,
          asr_text: asrText,
          state: currentState
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const inferenceText = await inferenceResponse.text();
    if (!inferenceResponse.ok) {
      throw new Error(
        `inference backend non-success: status=${inferenceResponse.status} body=${inferenceText.slice(0, 240)}`
      );
    }

    let resolved: ResolveResponse;
    try {
      resolved = JSON.parse(inferenceText) as ResolveResponse;
    } catch {
      throw new Error("inference backend returned non-JSON response");
    }

    return resolved;
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

    const resolved = await this.invokeInferenceResolve(sessionId, audioPayload, utterance.text, currentState);
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
      metadata: {
        profile_score: resolved.evidence.profile_top_score ?? null,
        profile_margin: resolved.evidence.profile_margin ?? null,
        binding_locked: mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false
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
    const enrollResult = await this.callInferenceEnroll(sessionId, participantName, enrollAudio, state);
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
      note: `teacher direct bind for session ${sessionId}`
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
        const result = await this.runFunAsrDashScope(wavBytes, asrState.model);

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
          asr_provider: "dashscope",
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
            await this.appendSpeakerEvent({
              ts: new Date().toISOString(),
              stream_role: "students",
              source: "inference_resolve",
              utterance_id: utterance.utterance_id,
              cluster_id: null,
              speaker_name: null,
              decision: "unknown",
              evidence: null,
              note: `students auto-resolve failed: ${(error as Error).message}`
            });
          }
        } else if (streamRole === "teacher") {
          await this.appendTeacherSpeakerEvent(sessionId, utterance);
        }

        nextEndSeq += asrState.hop_seconds;
      }

      utterancesByStream[streamRole] = utterances;
      await this.storeUtterancesRawByStream(utterancesByStream);

      const mergedByStream = await this.loadUtterancesMergedByStream();
      mergedByStream[streamRole] = mergeUtterances(utterances);
      await this.storeUtterancesMergedByStream(mergedByStream);

      asrByStream[streamRole] = asrState;
      await this.storeAsrByStream(asrByStream);

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
      started_at: current.started_at ?? nowIso,
      heartbeat_at: patch.heartbeat_at ?? nowIso
    };
    await this.storeFinalizeV2Status(next);
    return next;
  }

  private async invokeInferenceAnalysisEvents(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events";
    const baseUrl = normalizeBaseUrl(this.env.INFERENCE_BASE_URL);
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "15000");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(baseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.env.INFERENCE_API_KEY ? { "x-api-key": this.env.INFERENCE_API_KEY } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`analysis/events failed: status=${response.status} body=${text.slice(0, 240)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("analysis/events returned non-JSON response");
    }
  }

  private async invokeInferenceAnalysisReport(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const path = this.env.INFERENCE_REPORT_PATH ?? "/analysis/report";
    const baseUrl = normalizeBaseUrl(this.env.INFERENCE_BASE_URL);
    const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS ?? "15000");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(baseUrl + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.env.INFERENCE_API_KEY ? { "x-api-key": this.env.INFERENCE_API_KEY } : {})
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`analysis/report failed: status=${response.status} body=${text.slice(0, 240)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error("analysis/report returned non-JSON response");
    }
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
      const bound = state.bindings[clusterId] ?? null;
      const meta = state.cluster_binding_meta[clusterId];
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
      const bound = state.bindings[clusterId] ?? mapByCluster.get(clusterId)?.display_name ?? null;
      const meta = state.cluster_binding_meta[clusterId];
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
    const startedAt = this.currentIsoTs();
    await this.updateFinalizeV2Status(jobId, {
      status: "running",
      stage: "freeze",
      progress: 5,
      started_at: startedAt
    });
    await this.setFinalizeLock(true);

    try {
      await this.ensureFinalizeJobActive(jobId);
      const timeoutMs = this.finalizeTimeoutMs();
      const drainWithTimeout = async (streamRole: StreamRole): Promise<void> => {
        await Promise.race([
          this.drainRealtimeQueue(sessionId, streamRole),
          new Promise<void>((_, reject) => {
            setTimeout(() => reject(new Error(`drain timeout stream=${streamRole}`)), timeoutMs);
          })
        ]);
      };

      const ingestByStream = await this.loadIngestByStream(sessionId);
      const cutoff = {
        mixed: ingestByStream.mixed.last_seq,
        teacher: ingestByStream.teacher.last_seq,
        students: ingestByStream.students.last_seq
      };

      await this.updateFinalizeV2Status(jobId, { stage: "drain", progress: 18 });
      await this.ensureFinalizeJobActive(jobId);
      await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);

      await this.updateFinalizeV2Status(jobId, { stage: "replay_gap", progress: 30 });
      await this.ensureFinalizeJobActive(jobId);
      await Promise.all([this.replayGapFromR2(sessionId, "teacher"), this.replayGapFromR2(sessionId, "students")]);
      await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);

      await this.closeRealtimeAsrSession("teacher", "finalize-v2", false, true);
      await this.closeRealtimeAsrSession("students", "finalize-v2", false, true);
      await this.refreshAsrStreamMetrics(sessionId, "teacher");
      await this.refreshAsrStreamMetrics(sessionId, "students");

      await this.updateFinalizeV2Status(jobId, { stage: "reconcile", progress: 42 });
      const [stateRaw, events, rawByStream, mergedByStream, memos, speakerLogsStored, asrByStream] = await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.loadSpeakerEvents(),
        this.loadUtterancesRawByStream(),
        this.loadUtterancesMergedByStream(),
        this.loadMemos(),
        this.loadSpeakerLogs(),
        this.loadAsrByStream()
      ]);
      const state = normalizeSessionState(stateRaw);
      const diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";

      const eventByUtterance = new Map(
        events
          .filter((item) => item.stream_role === "students" && item.utterance_id)
          .map((item) => [item.utterance_id as string, item])
      );
      const teacherEventByUtterance = new Map(
        events
          .filter((item) => item.stream_role === "teacher" && item.utterance_id)
          .map((item) => [item.utterance_id as string, item])
      );

      const edgeTurns =
        diarizationBackend === "edge"
          ? [...speakerLogsStored.turns]
              .filter((item) => item.stream_role === "students")
              .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
          : [];
      const inferStudentsClusterFromEdgeTurns = (startMs: number, endMs: number): string | null => {
        if (edgeTurns.length === 0) return null;
        let bestCluster: string | null = null;
        let bestOverlap = 0;
        for (const turn of edgeTurns) {
          const overlap = Math.min(endMs, turn.end_ms) - Math.max(startMs, turn.start_ms);
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestCluster = turn.cluster_id;
          }
        }
        return bestOverlap > 0 ? bestCluster : null;
      };
      const resolveStudentBinding = (
        clusterId: string | null,
        eventSpeakerName: string | null,
        eventDecision: "auto" | "confirm" | "unknown" | null
      ): { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null } => {
        if (!clusterId) {
          if (eventSpeakerName) {
            return {
              speaker_name: eventSpeakerName,
              decision: eventDecision ?? "confirm"
            };
          }
          return { speaker_name: null, decision: "unknown" };
        }

        const bound = state.bindings[clusterId] ?? null;
        const meta = state.cluster_binding_meta[clusterId];
        if (meta?.locked && bound) {
          return { speaker_name: bound, decision: "auto" };
        }
        if (meta?.source === "manual_map" && bound) {
          return { speaker_name: bound, decision: "auto" };
        }
        if (meta?.source === "enrollment_match" && bound) {
          return { speaker_name: bound, decision: "auto" };
        }
        if (meta?.source === "name_extract" && bound) {
          return { speaker_name: bound, decision: "confirm" };
        }
        if (bound) {
          return { speaker_name: bound, decision: "auto" };
        }
        if (eventSpeakerName) {
          return {
            speaker_name: eventSpeakerName,
            decision: eventDecision ?? "confirm"
          };
        }
        return { speaker_name: null, decision: "unknown" };
      };

      const transcript = [...rawByStream.teacher, ...rawByStream.students]
        .filter((item) => item.end_seq <= cutoff[item.stream_role])
        .map((item) => {
          const event = item.stream_role === "teacher"
            ? teacherEventByUtterance.get(item.utterance_id)
            : eventByUtterance.get(item.utterance_id);
          const inferredStudentsCluster =
            item.stream_role === "students" && diarizationBackend === "edge"
              ? inferStudentsClusterFromEdgeTurns(item.start_ms, item.end_ms)
              : null;
          const clusterId =
            event?.cluster_id ??
            (item.stream_role === "students" ? inferredStudentsCluster : "teacher");
          const reconciled =
            item.stream_role === "students"
              ? resolveStudentBinding(clusterId ?? null, event?.speaker_name ?? null, event?.decision ?? null)
              : {
                  speaker_name: event?.speaker_name ?? null,
                  decision: event?.decision ?? null
                };
          return {
            utterance_id: item.utterance_id,
            stream_role: item.stream_role,
            cluster_id: clusterId ?? null,
            speaker_name: reconciled.speaker_name,
            decision: reconciled.decision,
            text: item.text,
            start_ms: item.start_ms,
            end_ms: item.end_ms,
            duration_ms: item.duration_ms
          };
        })
        .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms);

      mergedByStream.teacher = mergeUtterances(rawByStream.teacher);
      mergedByStream.students = mergeUtterances(rawByStream.students);
      await this.storeUtterancesMergedByStream(mergedByStream);

      const unresolvedClusterCount = state.clusters.filter((cluster) => {
        const bound = state.bindings[cluster.cluster_id];
        const meta = state.cluster_binding_meta[cluster.cluster_id];
        return !bound || !meta || !meta.locked;
      }).length;
      const tentative = unresolvedClusterCount > 0;

      const hasStudentTranscript = transcript.some((item) => item.stream_role === "students");
      let speakerLogs: SpeakerLogs;
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

      await this.updateFinalizeV2Status(jobId, { stage: "stats", progress: 56 });
      const stats = this.mergeStatsWithRoster(computeSpeakerStats(transcript), state);
      const evidence = buildEvidence({ memos, transcript });
      const memosWithEvidence = attachEvidenceToMemos(memos, evidence);
      const memoFirstStart = Date.now();
      const memoFirstReport = buildMemoFirstReport({
        transcript,
        memos: memosWithEvidence,
        evidence,
        stats
      });
      const memoFirstBuildMs = Date.now() - memoFirstStart;
      const validationStart = Date.now();
      const validation = validatePersonFeedbackEvidence(memoFirstReport.per_person);
      const validationMs = Date.now() - validationStart;
      const quality: ReportQualityMeta = {
        ...validation.quality,
        generated_at: this.currentIsoTs(),
        build_ms: memoFirstBuildMs,
        validation_ms: validationMs
      };
      if (!validation.valid) {
        throw new Error(
          `report evidence validation failed: claim_count=${quality.claim_count} invalid_claim_count=${quality.invalid_claim_count}`
        );
      }

      await this.updateFinalizeV2Status(jobId, { stage: "events", progress: 70 });
      await this.ensureFinalizeJobActive(jobId);
      const eventsPayload = {
        session_id: sessionId,
        transcript,
        memos: memosWithEvidence,
        stats,
        locale: "zh-CN"
      };
      const eventsResult = await this.invokeInferenceAnalysisEvents(eventsPayload);
      const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];

      await this.updateFinalizeV2Status(jobId, { stage: "report", progress: 84 });
      await this.ensureFinalizeJobActive(jobId);
      // Keep calling report endpoint to preserve pipeline compatibility and warm
      // model-side analytics, but memo-first output remains authoritative.
      this.ctx.waitUntil(
        this.invokeInferenceAnalysisReport({
          session_id: sessionId,
          transcript,
          memos: memosWithEvidence,
          stats,
          evidence,
          events: analysisEvents,
          locale: "zh-CN"
        }).catch((error) => {
          console.error(`analysis/report warmup failed session=${sessionId}:`, error);
          return null;
        })
      );

      await this.updateFinalizeV2Status(jobId, { stage: "persist", progress: 95 });
      await this.ensureFinalizeJobActive(jobId);
      const finalizedAt = this.currentIsoTs();
      const thresholdMeta: Record<string, number | string | boolean> = {};
      for (const [key, value] of Object.entries(metadata ?? {})) {
        if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
          thresholdMeta[key] = value;
        }
      }
      const resultV2 = buildResultV2({
        sessionId,
        finalizedAt,
        tentative,
        unresolvedClusterCount,
        diarizationBackend,
        transcript,
        speakerLogs,
        stats,
        memos,
        evidence,
        overall: memoFirstReport.overall,
        perPerson: memoFirstReport.per_person,
        quality: {
          ...quality,
          generated_at: finalizedAt
        },
        finalizeJobId: jobId,
        modelVersions: {
          asr: asrByStream.students.model,
          analysis_events_path: this.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
          analysis_report_path: this.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
          summary_mode: "memo_first"
        },
        thresholds: {
          sv_t_low: 0.45,
          sv_t_high: 0.70,
          tentative,
          unresolved_cluster_count: unresolvedClusterCount,
          diarization_backend: diarizationBackend,
          finalize_timeout_ms: timeoutMs,
          feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
          feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
          feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
          ...thresholdMeta
        }
      });

      const resultV2Key = resultObjectKeyV2(sessionId);
      await this.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
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
      cache.ready = resultV2.quality.needs_evidence_count === 0;
      await this.storeFeedbackCache(cache);

      await this.updateFinalizeV2Status(jobId, {
        status: "succeeded",
        stage: "persist",
        progress: 100,
        finished_at: finalizedAt,
        errors: []
      });
    } catch (error) {
      const message = (error as Error).message;
      const current = await this.loadFinalizeV2Status();
      if (current && current.job_id === jobId && !this.isFinalizeTerminal(current.status)) {
        await this.updateFinalizeV2Status(jobId, {
          status: "failed",
          stage: "persist",
          progress: 100,
          finished_at: this.currentIsoTs(),
          errors: [...current.errors, message]
        });
      }
    } finally {
      await this.setFinalizeLock(false);
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

    this.ctx.waitUntil(
      this.maybeRefreshFeedbackCache(sessionId, false).catch((error) => {
        console.error(`feedback cache refresh failed session=${sessionId}:`, error);
      })
    );
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
      const [state, events, updatedAt, ingestByStream, utterancesByStream, asrByStream, memos, finalizeV2Status, speakerLogs, asrCursorByStream, feedbackCache] =
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
        this.loadFeedbackCache(sessionId)
      ]);

      const utteranceCountByStream = {
        mixed: utterancesByStream.mixed.length,
        teacher: utterancesByStream.teacher.length,
        students: utterancesByStream.students.length
      };
      const normalizedState = normalizeSessionState(state);

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
        speaker_logs: speakerLogs,
        asr_cursor_by_stream: asrCursorByStream,
        feedback: {
          ready: feedbackCache.ready,
          updated_at: feedbackCache.updated_at,
          quality: feedbackCache.quality,
          timings: feedbackCache.timings
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
          config.diarization_backend = payload.diarization_backend === "edge" ? "edge" : "cloud";
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

        const roster = parseRosterEntries(payload.participants ?? payload.teams_participants);
        if (roster.length > 0) {
          state.roster = roster;
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
        this.ctx.waitUntil(
          this.maybeRefreshFeedbackCache(sessionId, true).catch((error) => {
            console.error(`feedback cache refresh after memo failed session=${sessionId}:`, error);
          })
        );
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
        quality: cache.quality
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
      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready && withinBudget,
        within_budget: withinBudget,
        opened_in_ms: elapsedMs,
        budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        timings: cache.timings,
        quality: cache.quality,
        report: cache.report
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
      const person = report.per_person.find((item) => item.person_key === personKey);
      if (!person) {
        return jsonResponse({ detail: `person_key not found: ${personKey}` }, 404);
      }
      const targetDimension = person.dimensions.find((item) => item.dimension === dimension);
      if (!targetDimension) {
        return jsonResponse({ detail: `dimension not found: ${dimension}` }, 404);
      }
      const claims = targetDimension[claimType];
      const fallbackRefs = cache.evidence_index_cache[`${person.person_key}:${dimension}`] ?? [];
      let targetClaim = payload.claim_id
        ? claims.find((item) => item.claim_id === payload.claim_id)
        : claims[0];
      if (!targetClaim) {
        targetClaim = {
          claim_id: `c_${person.person_key}_${dimension}_${claimType}_${Date.now()}`,
          text: "",
          evidence_refs: [],
          confidence: 0.66
        };
        claims.push(targetClaim);
      }
      const hint = String(payload.text_hint || "").trim();
      targetClaim.text = hint || `${targetClaim.text || "已根据老师最新 memo 重新整理该条结论。"}（updated）`;
      if (!Array.isArray(targetClaim.evidence_refs) || targetClaim.evidence_refs.length === 0) {
        targetClaim.evidence_refs = fallbackRefs.slice(0, 2);
      }
      if (!Array.isArray(targetClaim.evidence_refs) || targetClaim.evidence_refs.length === 0) {
        return jsonResponse(
          {
            detail: "claim regeneration requires evidence_refs; add evidence before regenerate",
            person_key: person.person_key,
            dimension
          },
          422
        );
      }
      targetClaim.confidence = Math.min(0.95, Math.max(0.6, Number(targetClaim.confidence || 0.72)));

      const validation = validatePersonFeedbackEvidence(report.per_person);
      const nowIso = this.currentIsoTs();
      report.quality = {
        ...validation.quality,
        generated_at: nowIso,
        validation_ms: validation.quality.validation_ms
      };
      cache.updated_at = nowIso;
      cache.report = report;
      cache.person_summary_cache = report.per_person;
      cache.overall_summary_cache = report.overall;
      cache.quality = report.quality;
      cache.ready = validation.valid;
      await this.storeFeedbackCache(cache);

      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        quality: cache.quality,
        person
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
        return jsonResponse({
          session_id: sessionId,
          source: merged.source,
          turns: merged.turns.length,
          clusters: merged.clusters.length,
          speaker_map: merged.speaker_map.length,
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
      return jsonResponse({
        session_id: sessionId,
        stream_role: filteredRole ?? "all",
        count: scoped.length,
        limit,
        items: scoped.slice(-limit)
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
        try {
          resolved = await this.invokeInferenceResolve(sessionId, payload.audio, payload.asr_text ?? null, currentState);
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
          metadata: {
            profile_score: resolved.evidence.profile_top_score ?? null,
            profile_margin: resolved.evidence.profile_margin ?? null,
            binding_locked: mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false
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
            version: "v2"
          });
        }
        const nextStatus: FinalizeV2Status = {
          job_id: `fv2_${crypto.randomUUID()}`,
          status: "queued",
          stage: "freeze",
          progress: 0,
          errors: [],
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
