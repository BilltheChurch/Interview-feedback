/**
 * asr-helpers.ts — Pure functions for ASR state management.
 *
 * Builder and sanitization functions for ASR state records.
 * All functions take explicit config dependencies instead of `this.env`.
 */

import type {
  StreamRole,
  AsrState,
  AsrRealtimeRuntime,
  AsrReplayCursor,
  Env
} from "./config";
import {
  DASHSCOPE_DEFAULT_MODEL,
  parsePositiveInt,
  parseBool
} from "./config";
import { TARGET_SAMPLE_RATE } from "./audio-utils";

// ── A2: realtime transcript downlink frame ──────────────────────────

/** Wire contract for a realtime transcript frame pushed Worker → Desktop.
 *  Both repos depend on these exact field names — keep them in sync with the
 *  Desktop WebSocketService transcript handler and the sessionStore TranscriptSegment. */
export interface TranscriptFrame {
  type: "transcript";
  role: StreamRole;
  speaker: string | null;
  text: string;
  is_final: boolean;
  ts_ms: number;
  start_ms: number;
  words: Array<{ text: string; start_ms: number; end_ms: number; speaker?: string | null }>;
}

/** Build a realtime transcript downlink frame (pure). */
export function buildTranscriptFrame(
  streamRole: StreamRole,
  speaker: string | null,
  text: string,
  isFinal: boolean,
  startMs: number,
  endMs: number,
  words: TranscriptFrame["words"] = []
): TranscriptFrame {
  return {
    type: "transcript",
    role: streamRole,
    speaker,
    text,
    is_final: isFinal,
    ts_ms: endMs,
    start_ms: startMs,
    words,
  };
}

// ── ASR config resolution ───────────────────────────────────────────

/** Subset of Env fields needed by ASR helpers. Accepts full Env without index signature issues. */
export interface AsrEnvConfig {
  ASR_ENABLED?: string;
  ASR_PROVIDER?: string;
  ASR_REALTIME_ENABLED?: string;
  ASR_MODEL?: string;
  ASR_WINDOW_SECONDS?: string;
  ASR_HOP_SECONDS?: string;
  ASR_DEBUG_LOG_EVENTS?: string;
  ALIYUN_DASHSCOPE_API_KEY?: string;
  SPEECHMATICS_API_KEY?: string;
  INFERENCE_RESOLVE_AUDIO_WINDOW_SECONDS?: string;
}

export function asrRealtimeEnabled(env: AsrEnvConfig): boolean {
  return parseBool(env.ASR_REALTIME_ENABLED, true);
}

export function asrDebugEnabled(env: AsrEnvConfig): boolean {
  return parseBool(env.ASR_DEBUG_LOG_EVENTS, false);
}

export function isAsrEnabled(env: AsrEnvConfig): boolean {
  if (!parseBool(env.ASR_ENABLED, true)) return false;
  // local-whisper uses the inference service, not DashScope — no API key needed
  const provider = (env.ASR_PROVIDER ?? "funASR").toLowerCase();
  if (provider === "local-whisper") return true;
  // Speechmatics realtime requires its own key, not the DashScope one.
  if (provider === "speechmatics") return Boolean((env.SPEECHMATICS_API_KEY ?? "").trim());
  return Boolean((env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim());
}

// ── Keepalive helpers ───────────────────────────────────────────────

/** Resolve the keepalive interval from the environment. Default: 5000 ms. */
export function resolveKeepaliveMs(env: Pick<Env, "ASR_KEEPALIVE_MS">): number {
  return parsePositiveInt(env.ASR_KEEPALIVE_MS, 5000);
}

/**
 * Pure decision function: should a silence keepalive frame be sent right now?
 *
 * Returns true when the outbound ASR WebSocket has been idle for at least
 * `intervalMs` milliseconds, meaning no real audio chunk has been forwarded
 * in that window. Sending a PCM-silence frame (all zeros) keeps the connection
 * alive without introducing phantom speech — Speechmatics will not emit a
 * speaker label or transcript for a silent frame, so diarization is unaffected.
 *
 * Call this on a periodic tick (e.g. a DO alarm) for each active stream runtime.
 * Update `runtime.lastAudioSentAt = Date.now()` whenever a real frame is sent
 * so a recent real chunk suppresses the keepalive correctly.
 *
 * @param lastAudioMs - Date.now() timestamp of the last real audio send (ms)
 * @param nowMs       - Current timestamp (ms); pass Date.now() in production
 * @param intervalMs  - Idle threshold in ms before a keepalive is required
 */
export function shouldSendKeepalive(
  lastAudioMs: number,
  nowMs: number,
  intervalMs: number
): boolean {
  return nowMs - lastAudioMs >= intervalMs;
}

/**
 * Generate a zero-filled PCM16 buffer representing `durationMs` milliseconds of
 * silence at 16 kHz mono. This is safe to send to Speechmatics as a keepalive:
 * silent audio produces no speech detection, no speaker label, and no transcript
 * output — it only resets the server-side idle timer.
 *
 * @param durationMs - Length of silence to generate in milliseconds (default 100 ms)
 * @returns Uint8Array of zero bytes (PCM16 silence, no WAV header)
 */
export function makeSilencePcm16(durationMs = 100): Uint8Array {
  // PCM16 mono: 2 bytes per sample × sample_rate samples/s × duration_s
  const byteLength = Math.ceil((durationMs / 1000) * TARGET_SAMPLE_RATE * 2);
  return new Uint8Array(byteLength); // Uint8Array is zero-initialized by spec
}

// ── ASR state builders ──────────────────────────────────────────────

export function buildDefaultAsrState(env: AsrEnvConfig): AsrState {
  return {
    enabled: isAsrEnabled(env),
    provider: "dashscope",
    model: env.ASR_MODEL ?? DASHSCOPE_DEFAULT_MODEL,
    mode: asrRealtimeEnabled(env) ? "realtime" : "windowed",
    asr_ws_state: "disconnected",
    backlog_chunks: 0,
    ingest_lag_seconds: 0,
    last_emit_at: null,
    ingest_to_utterance_p50_ms: null,
    ingest_to_utterance_p95_ms: null,
    recent_ingest_to_utterance_ms: [],
    window_seconds: parsePositiveInt(env.ASR_WINDOW_SECONDS, 10),
    hop_seconds: parsePositiveInt(env.ASR_HOP_SECONDS, 3),
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

export function sanitizeAsrState(current: AsrState, env: AsrEnvConfig): AsrState {
  current.enabled = isAsrEnabled(env);
  current.model = env.ASR_MODEL ?? current.model ?? DASHSCOPE_DEFAULT_MODEL;
  current.mode = asrRealtimeEnabled(env) ? "realtime" : "windowed";
  current.asr_ws_state = current.asr_ws_state ?? "disconnected";
  current.backlog_chunks = Number.isFinite(current.backlog_chunks) ? current.backlog_chunks : 0;
  current.ingest_lag_seconds = Number.isFinite(current.ingest_lag_seconds) ? current.ingest_lag_seconds : 0;
  current.last_emit_at = current.last_emit_at ?? null;
  current.ingest_to_utterance_p50_ms = current.ingest_to_utterance_p50_ms ?? null;
  current.ingest_to_utterance_p95_ms = current.ingest_to_utterance_p95_ms ?? null;
  current.recent_ingest_to_utterance_ms = Array.isArray(current.recent_ingest_to_utterance_ms)
    ? current.recent_ingest_to_utterance_ms.filter((item) => Number.isFinite(item)).slice(-200)
    : [];
  current.window_seconds = parsePositiveInt(env.ASR_WINDOW_SECONDS, current.window_seconds || 10);
  current.hop_seconds = parsePositiveInt(env.ASR_HOP_SECONDS, current.hop_seconds || 3);
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

export function defaultAsrByStream(env: AsrEnvConfig): Record<StreamRole, AsrState> {
  return {
    mixed: buildDefaultAsrState(env),
    teacher: buildDefaultAsrState(env),
    students: buildDefaultAsrState(env)
  };
}

// ── ASR replay cursor ───────────────────────────────────────────────

export function emptyAsrCursorByStream(nowIso: string): Record<StreamRole, AsrReplayCursor> {
  return {
    mixed: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: nowIso },
    teacher: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: nowIso },
    students: { last_ingested_seq: 0, last_sent_seq: 0, last_emitted_seq: 0, updated_at: nowIso }
  };
}

// ── Realtime runtime builder ────────────────────────────────────────

export function buildRealtimeRuntime(streamRole: StreamRole): AsrRealtimeRuntime {
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
    drainGeneration: 0,
    sttBuffer: null,
    lastAudioSentAt: 0 // epoch sentinel: never sent → keepalive eligible immediately
  };
}

// ── WebSocket message helpers ───────────────────────────────────────

export function sendWsJson(socket: WebSocket, payload: unknown): void {
  socket.send(JSON.stringify(payload));
}

export function sendWsError(socket: WebSocket, detail: string): void {
  sendWsJson(socket, {
    type: "error",
    detail
  });
}
