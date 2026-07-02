/**
 * realtime-asr-processor.ts — Realtime ASR processing methods.
 *
 * Extracted from MeetingSessionDO to reduce index.ts size.
 * Handles DashScope WebSocket realtime ASR, windowed ASR fallback,
 * speaker resolve/enroll during recording, and R2 chunk replay.
 *
 * Pattern: standalone async functions with explicit context rather than `this`.
 */

import { runFunAsrDashScope as runFunAsrDashScopeFn } from "./dashscope-asr";
import {
  openSpeechmaticsSocket,
  buildStartRecognition,
  buildEndOfStream,
  parseSpeechmaticsMessage,
  DEFAULT_SPEECHMATICS_CONFIG,
  type SpeechmaticsTranscript,
} from "./speechmatics-asr";
import { InferenceRequestError } from "./inference_client";
import type { InferenceCallContext } from "./inference-helpers";
import { invokeInferenceResolve as invokeInferenceResolveFn } from "./inference-helpers";
import { invokeInferenceEnroll as invokeInferenceEnrollFn } from "./inference-helpers";
import {
  concatUint8Arrays,
  pcm16ToWavBytes,
  bytesToBase64,
  tailPcm16BytesToWavForSeconds,
  truncatePcm16WavToSeconds,
  TARGET_SAMPLE_RATE,
  TARGET_CHANNELS,
} from "./audio-utils";
import { ONE_SECOND_PCM_BYTES } from "./audio-utils";
import {
  chunkObjectKey,
  log,
  getErrorMessage,
  normalizeSessionState,
  STORAGE_KEY_STATE,
  STORAGE_KEY_UPDATED_AT,
  DASHSCOPE_DEFAULT_WS_URL,
  DASHSCOPE_TIMEOUT_CAP_MS,
  MAX_BACKOFF_MS,
  WS_CLOSE_REASON_MAX_LEN,
  INFERENCE_MAX_AUDIO_SECONDS,
  parseTimeoutMs,
  toWebSocketHandshakeUrl,
  extractFirstString,
  extractBooleanByKeys,
  extractNumberByKeys,
  normalizeTextForMerge,
  quantile,
  identitySourceFromBindingSource,
  mergeUtterances,
  buildDefaultEnrollmentState,
  resolveMaxSpeakers,
  resolveSpeechmaticsOperatingPoint,
  resolveSpeechmaticsMaxDelay,
  resolveSpeechmaticsPunctuation,
  resolveSttUtteranceGapMs,
  resolveSttSilenceFlushMs,
  resolveSttMaxUtteranceSilenceMs,
  resolveSttMaxUtteranceMs,
  resolvePartialThrottleMs,
  joinTranscriptPieces,
} from "./config";
import { SENTENCE_FINAL_PUNCT } from "./transcript-cleaner";
import type {
  Env,
  StreamRole,
  SessionState,
  AsrState,
  IngestState,
  AsrRunResult,
  AsrReplayCursor,
  AsrRealtimeRuntime,
  UtteranceRaw,
  UtteranceMerged,
  ResolveEvidence,
  SpeakerEvent,
  AudioPayload,
  EnrollmentParticipantProgress,
} from "./config";
import { resolveTeacherIdentity as resolveTeacherIdentityFn } from "./speaker-helpers";
import { LocalWhisperASRProvider } from "./providers/asr-local-whisper";
import {
  shouldSendKeepalive,
  makeSilencePcm16,
  resolveKeepaliveMs,
  backpressureLag,
  shouldThrottle,
  BACKPRESSURE_WINDOW,
} from "./asr-helpers";

// ── sleep helper ───────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Context interface ──────────────────────────────────────────────────────

export interface RealtimeAsrContext {
  env: Env;
  doCtx: DurableObjectState;
  /** Mutable record — mutations propagate back to the DO instance. */
  asrProcessingByStream: Record<StreamRole, boolean>;
  /** Mutable record — mutations propagate back to the DO instance. */
  asrRealtimeByStream: Record<StreamRole, AsrRealtimeRuntime>;
  getLocalWhisperProvider: () => LocalWhisperASRProvider | null;
  setLocalWhisperProvider: (p: LocalWhisperASRProvider) => void;
  inferenceCallCtx: InferenceCallContext;
  asrRealtimeEnabled: () => boolean;
  asrDebugEnabled: () => boolean;
  resolveAudioWindowSeconds: () => number;
  currentIsoTs: () => string;
  loadAsrByStream: () => Promise<Record<StreamRole, AsrState>>;
  storeAsrByStream: (state: Record<StreamRole, AsrState>) => Promise<void>;
  loadAsrCursorByStream: () => Promise<Record<StreamRole, AsrReplayCursor>>;
  patchAsrCursor: (streamRole: StreamRole, patch: Partial<AsrReplayCursor>) => Promise<void>;
  loadIngestByStream: (sessionId: string) => Promise<Record<StreamRole, IngestState>>;
  loadUtterancesRawByStream: () => Promise<Record<StreamRole, UtteranceRaw[]>>;
  storeUtterancesRawByStream: (state: Record<StreamRole, UtteranceRaw[]>) => Promise<void>;
  loadUtterancesMergedByStream: () => Promise<Record<StreamRole, UtteranceMerged[]>>;
  storeUtterancesMergedByStream: (state: Record<StreamRole, UtteranceMerged[]>) => Promise<void>;
  appendSpeakerEvent: (event: SpeakerEvent) => Promise<void>;
  maybeScheduleCheckpoint: (sessionId: string, endMs: number, streamRole: StreamRole) => Promise<void>;
  confidenceBucketFromEvidence: (evidence: ResolveEvidence | null | undefined) => "high" | "medium" | "low" | "unknown";
  inferParticipantFromText: (state: SessionState, asrText: string) => string | null;
  rosterNameByCandidate: (state: SessionState, candidate: string | null) => string | null;
  updateUnassignedEnrollmentByCluster: (state: SessionState, clusterId: string | null | undefined, durationSeconds: number) => void;
  participantProgressFromProfiles: (state: SessionState) => Record<string, EnrollmentParticipantProgress>;
  refreshEnrollmentMode: (state: SessionState) => void;
  /** A2: push a realtime transcript frame to the Desktop ingest socket (downlink). */
  broadcastTranscriptFrame: (
    streamRole: StreamRole,
    speaker: string | null,
    text: string,
    isFinal: boolean,
    startMs: number,
    endMs: number
  ) => void;
}

// ── currentRealtimeWsState ─────────────────────────────────────────────────

export function currentRealtimeWsState(
  runtime: AsrRealtimeRuntime
): "disconnected" | "connecting" | "running" | "error" {
  if (runtime.connecting) return "connecting";
  if (runtime.connected && runtime.running) return "running";
  if (runtime.connected) return "connecting";
  return "disconnected";
}

// ── refreshAsrStreamMetrics ────────────────────────────────────────────────

export async function refreshAsrStreamMetrics(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext,
  patch: Partial<AsrState> = {}
): Promise<void> {
  const [asrByStream, ingestByStream] = await Promise.all([
    ctx.loadAsrByStream(),
    ctx.loadIngestByStream(sessionId),
  ]);
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const asr = asrByStream[streamRole];

  asr.mode = ctx.asrRealtimeEnabled() ? "realtime" : "windowed";
  asr.asr_ws_state = currentRealtimeWsState(runtime);
  asr.backlog_chunks = runtime.sendQueue.length;
  asr.ingest_lag_seconds = Math.max(0, ingestByStream[streamRole].last_seq - runtime.lastSentSeq);
  asr.last_emit_at = runtime.lastEmitAt;

  Object.assign(asr, patch);
  asrByStream[streamRole] = asr;
  await ctx.storeAsrByStream(asrByStream);
}

// ── closeRealtimeAsrSession ────────────────────────────────────────────────

export async function closeRealtimeAsrSession(
  streamRole: StreamRole,
  reason: string,
  ctx: RealtimeAsrContext,
  clearQueue = false,
  gracefulFinish = true,
  sessionId?: string
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const ws = runtime.ws;

  // Always cancel any pending silence-timeout flush on teardown — unconditional (not gated on
  // clearQueue), because reconnect closes with clearQueue=false and a stale timer firing
  // during the reconnect window could flush against a moved-on buffer / a torn-down WS.
  clearSilenceFlushTimer(runtime);

  // Graceful close (client-close / finalize / DashScope finish) is a terminal boundary: settle any
  // residual accumulated buffer NOW so no words are lost. This matters more since round-3 — the
  // buffer is held longer (short pauses no longer flush without sentence-final punctuation), so a
  // no-punctuation trailing sentence could otherwise sit unsettled at teardown. A RECONNECT close
  // (gracefulFinish=false) intentionally does NOT flush here: the buffer must survive the reconnect
  // (clearQueue=false) so accumulation continues on the new connection. A hard reset (clearQueue=true)
  // discards it below regardless. A real sessionId must be supplied (callers thread it from their
  // scope) — without it the emitted utterance would be keyed to a placeholder, so we skip the flush
  // and fall back to the EndOfStream→EndOfTranscript round-trip (which carries the real sessionId).
  if (gracefulFinish && !clearQueue && sessionId) {
    await flushSttBuffer(sessionId, streamRole, ctx);
  }

  if (clearQueue) {
    runtime.sendQueue = [];
    runtime.currentStartSeq = null;
    runtime.currentStartTsMs = null;
    runtime.lastSentSeq = 0;
    runtime.sentChunkTsBySeq.clear();
    runtime.lastEmitAt = null;
    runtime.lastFinalTextNorm = "";
    runtime.lastPartialTextNorm = "";
    runtime.lastPartialSentAt = 0;
    runtime.sttBuffer = null;
    // Backpressure counters are per-connection (mirror Speechmatics seq_no which
    // restarts at 1 each StartRecognition); reset on full teardown too.
    runtime.lastSentToSpeechmaticsSeq = 0;
    runtime.lastAckedSeq = 0;
    // P0-a: full teardown resets the session clock, so the connection offset resets too.
    runtime.connectionSessionBaseMs = 0;
  }

  if (ws) {
    try {
      if (gracefulFinish) {
        if (realtimeProvider(ctx) === "speechmatics") {
          // Speechmatics: signal end-of-stream so it flushes the final transcript.
          ws.send(JSON.stringify(buildEndOfStream(runtime.lastSentSeq)));
          await sleep(1000);
        } else if (runtime.taskId) {
          ws.send(
            JSON.stringify({
              header: {
                action: "finish-task",
                task_id: runtime.taskId,
                streaming: "duplex",
              },
              payload: { input: {} },
            })
          );
          await sleep(1000);
        }
      }
    } catch {
      // ignore finish errors during close
    }
    try {
      ws.close(1000, reason.slice(0, WS_CLOSE_REASON_MAX_LEN));
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

// ── hydrateRuntimeFromCursor ───────────────────────────────────────────────

export async function hydrateRuntimeFromCursor(
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const cursors = await ctx.loadAsrCursorByStream();
  const cursor = cursors[streamRole];
  const runtime = ctx.asrRealtimeByStream[streamRole];
  runtime.lastSentSeq = Math.max(runtime.lastSentSeq, cursor.last_sent_seq);
  if (runtime.currentStartSeq === null && cursor.last_emitted_seq > 0) {
    runtime.currentStartSeq = cursor.last_emitted_seq + 1;
  }
}

// ── enqueueRealtimeChunk ───────────────────────────────────────────────────

export async function enqueueRealtimeChunk(
  sessionId: string,
  streamRole: StreamRole,
  seq: number,
  timestampMs: number,
  bytes: Uint8Array,
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  if (seq <= runtime.lastSentSeq) return;
  if (runtime.sendQueue.some((item) => item.seq === seq)) return;

  runtime.sendQueue.push({ seq, timestampMs, receivedAtMs: Date.now(), bytes });
  const cursors = await ctx.loadAsrCursorByStream();
  const current = cursors[streamRole];
  await ctx.patchAsrCursor(streamRole, {
    last_ingested_seq: Math.max(current.last_ingested_seq, seq),
  });
  await refreshAsrStreamMetrics(sessionId, streamRole, ctx);
}

// ── replayGapFromR2 ────────────────────────────────────────────────────────

export async function replayGapFromR2(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const [cursors, ingestByStream] = await Promise.all([
    ctx.loadAsrCursorByStream(),
    ctx.loadIngestByStream(sessionId),
  ]);
  const cursor = cursors[streamRole];
  const ingest = ingestByStream[streamRole];
  const replayStart = cursor.last_sent_seq + 1;
  if (replayStart > ingest.last_seq) return;

  for (let seq = replayStart; seq <= ingest.last_seq; seq += 1) {
    const key = chunkObjectKey(sessionId, streamRole, seq);
    const object = await ctx.env.RESULT_BUCKET.get(key);
    if (!object) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== ONE_SECOND_PCM_BYTES) continue;
    const tsRaw = object.customMetadata?.timestamp_ms ?? "";
    const parsedTs = Number(tsRaw);
    const timestampMs = Number.isFinite(parsedTs) ? parsedTs : seq * 1000;
    await enqueueRealtimeChunk(sessionId, streamRole, seq, timestampMs, bytes, ctx);
  }
}

// ── loadChunkRange ─────────────────────────────────────────────────────────

export async function loadChunkRange(
  sessionId: string,
  streamRole: StreamRole,
  startSeq: number,
  endSeq: number,
  ctx: RealtimeAsrContext
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (let seq = startSeq; seq <= endSeq; seq += 1) {
    const key = chunkObjectKey(sessionId, streamRole, seq);
    const object = await ctx.env.RESULT_BUCKET.get(key);
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

// ── getAsrProvider ─────────────────────────────────────────────────────────

export function getAsrProvider(ctx: RealtimeAsrContext): "funASR" | "local-whisper" {
  const provider = (ctx.env.ASR_PROVIDER ?? "funASR").toLowerCase();
  if (provider === "local-whisper") {
    let lw = ctx.getLocalWhisperProvider();
    if (!lw) {
      // A4/§2.1 bug#3: no silent localhost fallback — require explicit config, fail loudly.
      const endpoint = (ctx.env.ASR_ENDPOINT ?? ctx.env.INFERENCE_BASE_URL_PRIMARY ?? "").trim();
      if (!endpoint) {
        throw new Error(
          "local-whisper ASR requires ASR_ENDPOINT or INFERENCE_BASE_URL_PRIMARY (no localhost fallback)"
        );
      }
      lw = new LocalWhisperASRProvider({
        endpoint,
        language: ctx.env.ASR_LANGUAGE ?? "auto",
        timeout_ms: parseInt(ctx.env.ASR_TIMEOUT_MS ?? "30000", 10),
        apiKey: (ctx.env.INFERENCE_API_KEY ?? "").trim(),
      });
      ctx.setLocalWhisperProvider(lw);
    }
    return "local-whisper";
  }
  return "funASR";
}

// ── autoResolveStudentsUtterance ───────────────────────────────────────────

export async function autoResolveStudentsUtterance(
  sessionId: string,
  utterance: UtteranceRaw,
  wavBytes: Uint8Array,
  ctx: RealtimeAsrContext
): Promise<{
  cluster_id: string;
  speaker_name: string | null;
  decision: "auto" | "confirm" | "unknown";
  evidence: ResolveEvidence | null;
} | null> {
  if (!utterance.text.trim()) return null;

  const currentState = normalizeSessionState(
    await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE)
  );
  const safeWavBytes = truncatePcm16WavToSeconds(wavBytes, ctx.resolveAudioWindowSeconds());
  const audioPayload: AudioPayload = {
    content_b64: bytesToBase64(safeWavBytes),
    format: "wav",
    sample_rate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
  };

  const resolveCall = await invokeInferenceResolveFn(
    ctx.inferenceCallCtx,
    sessionId,
    audioPayload,
    utterance.text,
    currentState
  );
  const resolved = resolveCall.resolved;
  const mergedState = normalizeSessionState({
    ...resolved.updated_state,
    capture_by_stream: currentState.capture_by_stream,
  });
  await ctx.doCtx.storage.put(STORAGE_KEY_STATE, mergedState);
  await ctx.doCtx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
  const boundSpeakerName =
    resolved.speaker_name ??
    mergedState.bindings[resolved.cluster_id] ??
    mergedState.clusters.find((item) => item.cluster_id === resolved.cluster_id)?.bound_name ??
    null;

  await ctx.appendSpeakerEvent({
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
    confidence_bucket: ctx.confidenceBucketFromEvidence(resolved.evidence),
    metadata: {
      profile_score: resolved.evidence.profile_top_score ?? null,
      profile_margin: resolved.evidence.profile_margin ?? null,
      binding_locked:
        mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false,
      warnings: resolveCall.warnings,
      timeline: resolveCall.timeline,
    },
  });
  return {
    cluster_id: resolved.cluster_id,
    speaker_name: boundSpeakerName,
    decision: resolved.decision,
    evidence: resolved.evidence ?? null,
  };
}

// ── maybeAutoEnrollStudentsUtterance ───────────────────────────────────────

export async function maybeAutoEnrollStudentsUtterance(
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
    | null,
  ctx: RealtimeAsrContext
): Promise<void> {
  const state = normalizeSessionState(
    await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE)
  );
  const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
  if (enrollment.mode !== "collecting" && enrollment.mode !== "ready") return;

  const durationSeconds = Math.max(1, utterance.duration_ms / 1000);
  let participantName =
    ctx.inferParticipantFromText(state, utterance.text) ??
    (resolved?.speaker_name ? ctx.rosterNameByCandidate(state, resolved.speaker_name) : null);

  if (!participantName) {
    ctx.updateUnassignedEnrollmentByCluster(state, resolved?.cluster_id, durationSeconds);
    await ctx.doCtx.storage.put(STORAGE_KEY_STATE, state);
    await ctx.doCtx.storage.put(STORAGE_KEY_UPDATED_AT, ctx.currentIsoTs());
    return;
  }

  const enrollAudio: AudioPayload = {
    content_b64: bytesToBase64(truncatePcm16WavToSeconds(wavBytes, INFERENCE_MAX_AUDIO_SECONDS)),
    format: "wav",
    sample_rate: TARGET_SAMPLE_RATE,
    channels: TARGET_CHANNELS,
  };
  const enrollCall = await invokeInferenceEnrollFn(
    ctx.inferenceCallCtx,
    sessionId,
    participantName,
    enrollAudio,
    state
  );
  const enrollResult = enrollCall.payload;
  const nextState = normalizeSessionState({
    ...enrollResult.updated_state,
    capture_by_stream: state.capture_by_stream,
  });
  const progress = ctx.participantProgressFromProfiles(nextState);
  nextState.enrollment_state = {
    ...(nextState.enrollment_state ?? buildDefaultEnrollmentState()),
    mode: "collecting",
    started_at: nextState.enrollment_state?.started_at ?? ctx.currentIsoTs(),
    stopped_at: null,
    participants: progress,
    updated_at: ctx.currentIsoTs(),
  };
  ctx.refreshEnrollmentMode(nextState);
  await ctx.doCtx.storage.put(STORAGE_KEY_STATE, nextState);
  await ctx.doCtx.storage.put(STORAGE_KEY_UPDATED_AT, ctx.currentIsoTs());

  if (enrollCall.degraded) {
    await ctx.appendSpeakerEvent({
      ts: ctx.currentIsoTs(),
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
        timeline: enrollCall.timeline,
      },
    });
  }
}

// ── appendTeacherSpeakerEvent ──────────────────────────────────────────────

export async function appendTeacherSpeakerEvent(
  sessionId: string,
  utterance: UtteranceRaw,
  ctx: RealtimeAsrContext
): Promise<void> {
  if (!utterance.text.trim()) return;

  const state = normalizeSessionState(
    await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE)
  );
  const identity = resolveTeacherIdentityFn(state, utterance.text);

  await ctx.appendSpeakerEvent({
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
    confidence_bucket: "high",
  });
}

// ── emitRealtimeUtterance ──────────────────────────────────────────────────

export async function emitRealtimeUtterance(
  sessionId: string,
  streamRole: StreamRole,
  text: string,
  ctx: RealtimeAsrContext,
  speakerOverride: string | null = null,
  timingOverride: { startMs: number; endMs: number } | null = null
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const endSeq = Math.max(runtime.lastSentSeq, runtime.currentStartSeq ?? runtime.lastSentSeq);
  if (endSeq <= 0) return;

  const startSeq = runtime.currentStartSeq ?? endSeq;
  const createdAt = new Date().toISOString();
  const endIngestAtMs = runtime.sentChunkTsBySeq.get(endSeq) ?? Date.now();
  const latencyMs = Math.max(0, Date.now() - endIngestAtMs);
  // P0-a: prefer the connection-session-based timing (Speechmatics word time + per-connection
  // session offset) when the caller supplies it — this spreads utterances across the real
  // session timeline instead of collapsing them onto emit-boundary seq spans. The seq cursors
  // (start_seq/end_seq below) stay authoritative for finalize cutoff/ordering. When no override
  // is given (DashScope realtime path), fall back to the seq-derived span, unchanged.
  const startMs = timingOverride
    ? Math.max(0, Math.round(timingOverride.startMs))
    : (startSeq - 1) * 1000;
  const endMs = timingOverride
    ? Math.max(startMs, Math.round(timingOverride.endMs))
    : endSeq * 1000;

  const [asrByStream, utterancesByStream, ingestByStream] = await Promise.all([
    ctx.loadAsrByStream(),
    ctx.loadUtterancesRawByStream(),
    ctx.loadIngestByStream(sessionId),
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
    asr_provider: realtimeProvider(ctx),
    confidence: null,
    created_at: createdAt,
    latency_ms: latencyMs,
  };
  utterances.push(utterance);
  utterancesByStream[streamRole] = utterances;
  await ctx.storeUtterancesRawByStream(utterancesByStream);

  // A2: push the realtime transcript frame down to the Desktop client. teacher →
  // resolve the interviewer identity; students → diarization label is not available
  // on the DashScope realtime path yet (speaker stays null until Speechmatics lands).
  let broadcastSpeaker: string | null = speakerOverride;
  if (broadcastSpeaker === null && streamRole === "teacher") {
    try {
      const state = normalizeSessionState(
        await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE)
      );
      broadcastSpeaker = resolveTeacherIdentityFn(state, utterance.text).speakerName;
    } catch {
      broadcastSpeaker = null;
    }
  }
  ctx.broadcastTranscriptFrame(streamRole, broadcastSpeaker, utterance.text, true, startMs, endMs);

  const mergedByStream = await ctx.loadUtterancesMergedByStream();
  mergedByStream[streamRole] = mergeUtterances(utterances);
  await ctx.storeUtterancesMergedByStream(mergedByStream);

  asrState.mode = ctx.asrRealtimeEnabled() ? "realtime" : "windowed";
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
  asrState.ingest_lag_seconds = Math.max(
    0,
    ingestByStream[streamRole].last_seq - runtime.lastSentSeq
  );

  asrByStream[streamRole] = asrState;
  await ctx.storeAsrByStream(asrByStream);

  runtime.lastEmitAt = createdAt;
  runtime.currentStartSeq = endSeq + 1;
  runtime.currentStartTsMs = null;
  for (const seq of runtime.sentChunkTsBySeq.keys()) {
    if (seq <= endSeq) runtime.sentChunkTsBySeq.delete(seq);
  }
  await ctx.patchAsrCursor(streamRole, {
    last_sent_seq: Math.max(runtime.lastSentSeq, endSeq),
    last_emitted_seq: endSeq,
  });

  if (streamRole === "students") {
    // All-cloud (Speechmatics): the diarization S-label IS the speaker identity. Persist it
    // as the speaker-event cluster_id so finalize reconcile can bind it to a candidate name
    // (B3 self-introduction extraction). The legacy inference speaker-verify / enrollment
    // path is disabled in all-cloud mode, so short-circuit it when an S-label is present.
    if (speakerOverride) {
      await ctx.appendSpeakerEvent({
        ts: new Date().toISOString(),
        stream_role: "students",
        source: "diarization",
        identity_source: null,
        utterance_id: utterance.utterance_id,
        cluster_id: speakerOverride,
        speaker_name: null,
        decision: "confirm",
        evidence: null,
        note: `speechmatics diarization label ${speakerOverride}`,
        backend: "primary",
        fallback_reason: null,
        confidence_bucket: "medium",
        metadata: null,
      });
      return;
    }
    let resolvedInfo: {
      cluster_id: string;
      speaker_name: string | null;
      decision: "auto" | "confirm" | "unknown";
      evidence: ResolveEvidence | null;
    } | null = null;
    try {
      const chunkRange = await loadChunkRange(sessionId, streamRole, startSeq, endSeq, ctx);
      const mergedPcm = concatUint8Arrays(chunkRange);
      const resolveWav = tailPcm16BytesToWavForSeconds(mergedPcm, ctx.resolveAudioWindowSeconds());
      resolvedInfo = await autoResolveStudentsUtterance(sessionId, utterance, resolveWav, ctx);
      const enrollWav = pcm16ToWavBytes(mergedPcm);
      await maybeAutoEnrollStudentsUtterance(sessionId, utterance, enrollWav, resolvedInfo, ctx);
    } catch (error) {
      const inferenceError = error instanceof InferenceRequestError ? error : null;
      await ctx.appendSpeakerEvent({
        ts: new Date().toISOString(),
        stream_role: "students",
        source: "inference_resolve",
        identity_source: "inference_resolve",
        utterance_id: utterance.utterance_id,
        cluster_id: null,
        speaker_name: null,
        decision: "unknown",
        evidence: null,
        note: `students auto-resolve failed: ${getErrorMessage(error)}`,
        backend: inferenceError ? inferenceError.health.active_backend : "primary",
        fallback_reason: inferenceError ? "resolve_all_backends_failed" : null,
        confidence_bucket: "unknown",
        metadata: {
          profile_score: resolvedInfo?.evidence?.profile_top_score ?? null,
          profile_margin: resolvedInfo?.evidence?.profile_margin ?? null,
          binding_locked: false,
          timeline: inferenceError?.timeline ?? null,
        },
      });
    }
  } else if (streamRole === "teacher") {
    await appendTeacherSpeakerEvent(sessionId, utterance, ctx);
  }

  ctx.doCtx.waitUntil(
    ctx.maybeScheduleCheckpoint(sessionId, utterance.end_ms, streamRole)
  );
}

// ── handleRealtimeAsrMessage ───────────────────────────────────────────────

export async function handleRealtimeAsrMessage(
  sessionId: string,
  streamRole: StreamRole,
  data: string | ArrayBuffer | ArrayBufferView,
  ctx: RealtimeAsrContext
): Promise<void> {
  if (realtimeProvider(ctx) === "speechmatics") {
    return handleSpeechmaticsMessage(sessionId, streamRole, data, ctx);
  }
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

  if (
    ctx.asrDebugEnabled() &&
    ["task-started", "result-generated", "task-finished", "task-failed"].includes(eventName)
  ) {
    log("debug", "asr-debug event", {
      sessionId,
      streamRole,
      eventName,
      payload: JSON.stringify(payloadObject).slice(0, 400),
    });
  }

  const runtime = ctx.asrRealtimeByStream[streamRole];
  if (eventName === "task-started") {
    runtime.running = true;
    runtime.readyResolve?.();
    runtime.readyResolve = null;
    runtime.readyReject = null;
    await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
      asr_ws_state: "running",
      last_error: null,
    });
    return;
  }

  if (eventName === "task-failed") {
    const detail = `dashscope task failed: ${JSON.stringify(payload).slice(0, 400)}`;
    runtime.readyReject?.(new Error(detail));
    runtime.readyResolve = null;
    runtime.readyReject = null;
    await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
      asr_ws_state: "error",
      last_error: detail,
    });
    return;
  }

  const text = extractFirstString(payloadObject);
  if (!text || !text.trim()) return;

  const finalFlag = extractBooleanByKeys(payloadObject, [
    "is_final",
    "final",
    "sentence_end",
    "sentenceEnd",
    "end_of_sentence",
  ]);
  const isFinal = eventName === "task-finished" || finalFlag !== false;
  if (!isFinal) return;

  const normalized = normalizeTextForMerge(text);
  if (normalized && normalized === runtime.lastFinalTextNorm) return;
  runtime.lastFinalTextNorm = normalized;

  const beginMs = extractNumberByKeys(payloadObject, [
    "begin_time",
    "beginTime",
    "start_ms",
    "startMs",
  ]);
  const endMs = extractNumberByKeys(payloadObject, [
    "end_time",
    "endTime",
    "end_ms",
    "endMs",
  ]);
  if (beginMs !== null && endMs !== null && endMs >= beginMs) {
    const startSeq = Math.max(1, Math.floor(beginMs / 1000) + 1);
    const inferredEndSeq = Math.max(startSeq, Math.ceil(endMs / 1000));
    runtime.currentStartSeq = startSeq;
    runtime.lastSentSeq = Math.max(runtime.lastSentSeq, inferredEndSeq);
  }

  await emitRealtimeUtterance(sessionId, streamRole, text, ctx);
}

// ── Speechmatics realtime (A1b) ────────────────────────────────────────────

/** Which provider the REALTIME path uses. Default dashscope (unchanged) unless
 *  ASR_PROVIDER=speechmatics. The finalize/windowed path still uses getAsrProvider(). */
export function realtimeProvider(ctx: RealtimeAsrContext): "dashscope" | "speechmatics" {
  return (ctx.env.ASR_PROVIDER ?? "").toLowerCase() === "speechmatics" ? "speechmatics" : "dashscope";
}

/** Pick the diarization speaker label that owns the most words in a transcript. */
function dominantSpeaker(t: SpeechmaticsTranscript): string | null {
  const counts = new Map<string, number>();
  for (const w of t.words) {
    if (w.is_punctuation || !w.speaker) continue;
    counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [spk, n] of counts) {
    if (n > bestN) { best = spk; bestN = n; }
  }
  return best;
}

/**
 * Open + maintain a Speechmatics realtime connection for a stream (A1b). Mirrors the
 * DashScope connect flow: open WS → send StartRecognition → resolve readyPromise on
 * RecognitionStarted (in handleSpeechmaticsMessage) → replay any R2 gap. The shared
 * drain/queue/reconnect/backpressure infrastructure (drainRealtimeQueue) sends raw PCM
 * frames, which Speechmatics accepts directly.
 */
async function connectSpeechmaticsRealtime(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const ws = await openSpeechmaticsSocket(ctx.env);
  ws.accept();

  runtime.ws = ws;
  runtime.connected = true;
  runtime.running = false;
  runtime.startedAt = Date.now();
  runtime.taskId = null; // Speechmatics has no task id; null marks the non-DashScope path.
  // Backpressure: Speechmatics assigns AudioAdded{seq_no} starting at 1 PER WS
  // connection (each StartRecognition numbers independently). Reset both the send
  // counter and the ack counter on every new connection so they realign. Without
  // this, after a reconnect the new connection's small acks (1,2,3…) would never
  // exceed the old high lastAckedSeq under Math.max → lag would grow unbounded →
  // permanent false throttle (deadlock).
  runtime.lastSentToSpeechmaticsSeq = 0;
  runtime.lastAckedSeq = 0;
  runtime.readyPromise = new Promise<void>((resolve, reject) => {
    runtime.readyResolve = resolve;
    runtime.readyReject = reject;
  });

  ws.addEventListener("message", (event) => {
    ctx.doCtx.waitUntil(
      handleRealtimeAsrMessage(sessionId, streamRole, event.data, ctx).catch(async (error) => {
        log("error", "asr realtime message handler failed", {
          component: "asr", stream_role: streamRole, error: getErrorMessage(error),
        });
        await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
          asr_ws_state: "error", last_error: getErrorMessage(error),
        });
      })
    );
  });
  ws.addEventListener("error", () => {
    ctx.doCtx.waitUntil(
      refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
        asr_ws_state: "error", last_error: "speechmatics websocket error",
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
    ctx.doCtx.waitUntil(refreshAsrStreamMetrics(sessionId, streamRole, ctx));
  });

  // P0-a: capture the session-time offset for THIS connection's Speechmatics timeline.
  // Speechmatics numbers word times from ~0 on every StartRecognition (its timeline resets
  // per connection). The session ms already ingested when this connection starts is the
  // offset that maps this connection's relative word times back onto the session timeline.
  // lastSentSeq is the session-monotonic ingest chunk seq (chunks ≈ 1s), preserved across a
  // reconnect (clearQueue=false) and 0 on the first connect — so the first connection's base
  // is 0 (relative times pass through) and a reconnect's base = session time already elapsed
  // (post-reconnect utterances land AFTER the pre-reconnect ones — monotonic, no collapse).
  runtime.connectionSessionBaseMs = Math.max(0, runtime.lastSentSeq) * 1000;

  // teacher = single speaker → diarization off (§9.3.4); students → diarization on.
  // maxSpeakers is only applied for the students stream (diarization must be true).
  const language = (ctx.env.SPEECHMATICS_LANGUAGE ?? "cmn_en").trim() || "cmn_en";
  const isDiarization = streamRole === "students";
  ws.send(JSON.stringify(buildStartRecognition({
    ...DEFAULT_SPEECHMATICS_CONFIG,
    language,
    diarization: isDiarization,
    // R5: accuracy tier (default "enhanced"); R6: final-transcript latency budget (default 1.0s).
    operatingPoint: resolveSpeechmaticsOperatingPoint(ctx.env),
    maxDelaySeconds: resolveSpeechmaticsMaxDelay(ctx.env),
    sampleRate: TARGET_SAMPLE_RATE,
    maxSpeakers: isDiarization ? resolveMaxSpeakers(ctx.env) : undefined,
    // R-H: request punctuation (。？！， for cmn/cmn_en). undefined when the env gate
    // disables it → punctuation_overrides omitted, never risking an invalid_config reject.
    punctuationSensitivity: resolveSpeechmaticsPunctuation(ctx.env),
  })));

  const timeoutMs = parseTimeoutMs(ctx.env.ASR_TIMEOUT_MS ?? "45000");
  const startedTimeout = setTimeout(() => {
    runtime.readyReject?.(new Error("speechmatics RecognitionStarted timeout"));
  }, Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS));

  await runtime.readyPromise;
  clearTimeout(startedTimeout);
  runtime.reconnectBackoffMs = 500;
  await replayGapFromR2(sessionId, streamRole, ctx);
  await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
    asr_ws_state: "running", last_error: null,
  });
}

/** Handle a Speechmatics realtime message: ready signal, transcripts, errors. */
export async function handleSpeechmaticsMessage(
  sessionId: string,
  streamRole: StreamRole,
  data: string | ArrayBuffer | ArrayBufferView,
  ctx: RealtimeAsrContext
): Promise<void> {
  if (typeof data !== "string") return;
  const msg = parseSpeechmaticsMessage(data);
  if (!msg) return;
  const runtime = ctx.asrRealtimeByStream[streamRole];

  if (msg.type === "RecognitionStarted") {
    runtime.running = true;
    runtime.readyResolve?.();
    runtime.readyResolve = null;
    runtime.readyReject = null;
    await refreshAsrStreamMetrics(sessionId, streamRole, ctx, { asr_ws_state: "running", last_error: null });
    return;
  }

  if (msg.type === "Error") {
    runtime.readyReject?.(new Error(msg.reason));
    runtime.readyResolve = null;
    runtime.readyReject = null;
    await refreshAsrStreamMetrics(sessionId, streamRole, ctx, { asr_ws_state: "error", last_error: msg.reason });
    return;
  }

  if (msg.type === "EndOfTranscript") {
    // Stream ended (e.g. EndOfStream during graceful close) — flush any buffered words.
    await flushSttBuffer(sessionId, streamRole, ctx);
    return;
  }
  // Track Speechmatics acks for backpressure. AudioAdded{seq_no} is emitted
  // once per ingested audio frame. Updating lastAckedSeq here (on the inbound
  // WS message path) is intentionally independent of drainRealtimeQueue (the
  // outbound send path) — acks keep flowing even when the drain loop throttles,
  // so there is no deadlock: lag falls as acks arrive, allowing the next drain
  // pass to proceed.
  if (msg.type === "AudioAdded") {
    runtime.lastAckedSeq = Math.max(runtime.lastAckedSeq, msg.seq_no);
    return;
  }

  if (msg.type !== "Transcript") return;       // Warning / Unknown
  const t = msg.transcript;

  // students → carry the Speechmatics diarization label (S1/S2…); teacher → resolved
  // via the interviewer identity. Partial and final take the SAME speaker path so the
  // in-place partial line and its final never disagree on who is speaking.
  const speaker = streamRole === "students" ? dominantSpeaker(t) : null;

  // R4: Speechmatics AddPartialTranscript carries the CUMULATIVE full text of the
  // in-progress utterance (it grows word-by-word and supersedes the prior partial —
  // not incremental deltas). Forward it as a non-final frame so the Desktop can render
  // a live, in-place "still typing" line. The final path (below) is unchanged.
  if (t.is_partial) {
    const partialText = t.text.trim();
    // Prefix continuity: Speechmatics closes a recognition segment every ~1s of continuous
    // speech (max_delay), and each segment's partials restart from empty — while the
    // endpointing buffer below keeps the earlier segment finals of the SAME UI-level
    // utterance un-broadcast. Prepend the buffered text so the forwarded partial stays
    // cumulative for the WHOLE utterance; the Desktop typewriter relies on that to keep
    // already-shown words untouched instead of wiping the line at every segment boundary.
    // Only a same-speaker buffer is joined (a speaker change flushes on the next final).
    const buf = runtime.sttBuffer;
    const cumulative =
      partialText && buf && buf.speaker === speaker
        ? joinTranscriptPieces([...buf.texts, partialText])
        : partialText;
    await maybeForwardPartial(sessionId, streamRole, cumulative, speaker, ctx);
    return;
  }

  const text = t.text.trim();
  if (!text) return;

  const normalized = normalizeTextForMerge(text);
  if (normalized && normalized === runtime.lastFinalTextNorm) return;
  runtime.lastFinalTextNorm = normalized;

  // A final arrived → the current partial line is now superseded. Clear the dedupe
  // marker AND reset the throttle timestamp to 0 ("never sent"), so the NEXT utterance's
  // first partial forwards immediately instead of being swallowed by the throttle window
  // (which would add up to STT_PARTIAL_THROTTLE_MS of cross-utterance first-word delay).
  runtime.lastPartialTextNorm = "";
  runtime.lastPartialSentAt = 0;

  // Endpointing: Speechmatics emits word-level finals, which fragment self-introductions
  // and evidence quotes. Accumulate finals into one sentence-level utterance. Real-user
  // round-3: a SHORT pause (gap) must only settle the buffer when its text already ends on a
  // sentence-final punctuation mark — otherwise a thinking / breathing pause chops a phrase
  // ("Imperial College … London") mid-way. A speaker change is a HARD turn boundary and always
  // flushes (regardless of punctuation). Buffers that never terminate on punctuation (Chinese —
  // Speechmatics cmn_en emits no CJK sentence-final marks in realtime, or long unpunctuated
  // clauses) are settled by the long-silence backstop in armSilenceFlushTimer instead.
  const gapMs = resolveSttUtteranceGapMs(ctx.env);
  const buf = runtime.sttBuffer;
  if (buf) {
    const speakerChanged = speaker !== buf.speaker;
    const gapExceeded = t.start_ms - buf.endMs > gapMs;
    if (speakerChanged || (gapExceeded && bufferEndsWithSentenceStop(buf))) {
      await flushSttBuffer(sessionId, streamRole, ctx);
    }
  }
  if (!runtime.sttBuffer) {
    runtime.sttBuffer = { texts: [text], speaker, startMs: t.start_ms, endMs: t.end_ms };
  } else {
    runtime.sttBuffer.texts.push(text);
    runtime.sttBuffer.endMs = Math.max(runtime.sttBuffer.endMs, t.end_ms);
  }
  // Re-arm the silence-timeout flush on every buffered final. If no next final arrives within
  // STT_SILENCE_FLUSH_MS this settles the trailing sentence (a pure pause otherwise never
  // reaches the gap-flush path, which needs a subsequent final to compare against).
  armSilenceFlushTimer(sessionId, streamRole, ctx);

  // Duration cap (last-resort backstop). A fluent unpunctuated monologue — the primary CJK case,
  // where Speechmatics cmn_en emits no sentence-final marks and breaths stay under the silence
  // backstop, with no speaker change — otherwise accumulates into ONE giant utterance forever.
  // Once the accumulated word-time span reaches STT_MAX_UTTERANCE_MS, force-flush at THIS final
  // boundary (never mid-word) so the monologue is cut into segments. The subsequent final starts
  // a fresh buffer (new segment) and arms its own timer. flushSttBuffer is idempotent, so this is
  // safe even if the silence timer just fired.
  const active = runtime.sttBuffer;
  if (active && active.endMs - active.startMs >= resolveSttMaxUtteranceMs(ctx.env)) {
    await flushSttBuffer(sessionId, streamRole, ctx);
  }
}

/**
 * R4: forward a partial (interim) transcript as a non-final frame to the Desktop.
 *
 * Speechmatics emits AddPartialTranscript very frequently. To keep the downlink light we
 * (a) drop empties, (b) drop partials whose normalized text is unchanged since the last
 * forward, and (c) throttle to at most one frame per resolvePartialThrottleMs() per stream.
 * The teacher speaker is resolved through resolveTeacherIdentity so the partial line
 * matches the eventual final (never mislabelled as a student — R1). Partials are UI-only:
 * they are NOT persisted to utterances and do NOT advance any seq cursor.
 */
export async function maybeForwardPartial(
  sessionId: string,
  streamRole: StreamRole,
  text: string,
  speaker: string | null,
  ctx: RealtimeAsrContext
): Promise<void> {
  if (!text) return;
  const runtime = ctx.asrRealtimeByStream[streamRole];

  const normalized = normalizeTextForMerge(text);
  // Dedupe: identical partial text to the last one we forwarded → skip.
  if (normalized && normalized === runtime.lastPartialTextNorm) return;

  // Throttle: at most one partial per stream per throttle window. A changed-text partial
  // that arrives inside the window is dropped; the next one past the window carries the
  // latest cumulative text anyway (partials are cumulative), so nothing is lost. The
  // very first partial of an utterance (lastPartialSentAt === 0 after a reset/flush)
  // always forwards so the live line appears immediately.
  const now = Date.now();
  const throttleMs = resolvePartialThrottleMs(ctx.env);
  if (runtime.lastPartialSentAt > 0 && now - runtime.lastPartialSentAt < throttleMs) {
    return;
  }

  let broadcastSpeaker: string | null = speaker;
  if (broadcastSpeaker === null && streamRole === "teacher") {
    try {
      const state = normalizeSessionState(
        await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE)
      );
      broadcastSpeaker = resolveTeacherIdentityFn(state, text).speakerName;
    } catch {
      broadcastSpeaker = null;
    }
  }

  runtime.lastPartialTextNorm = normalized;
  runtime.lastPartialSentAt = now;

  // Partial frames have no reliable seq mapping; reuse the current utterance span for
  // start/end ms so the Desktop keys them consistently (isFinal=false marks them interim).
  const startMs = Math.max(0, (runtime.currentStartSeq ?? 1) - 1) * 1000;
  const endMs = Math.max(startMs, runtime.lastSentSeq * 1000);
  ctx.broadcastTranscriptFrame(streamRole, broadcastSpeaker, text, false, startMs, endMs);
}

/**
 * Emit the accumulated sentence-level utterance (endpointing), then clear the buffer.
 *
 * P0-a — utterance timestamps: start_ms/end_ms are placed on the SESSION timeline as
 *   session_ms = connectionSessionBaseMs + speechmatics-relative word ms (buf.startMs/endMs).
 * buf.startMs/buf.endMs are Speechmatics CONNECTION-relative times that restart at ~0 on
 * every WS reconnect (each StartRecognition renumbers its timeline). connectionSessionBaseMs
 * (captured at StartRecognition = the session ms already ingested then) shifts them back onto
 * the real session clock. This spreads utterances across true speaking time (no 00:00
 * collapse) AND stays monotonic across a reconnect: the base only grows with the session, so a
 * post-reconnect utterance's ~0 relative time still lands AFTER every pre-reconnect utterance.
 *
 * R-E preserved: the ordering/cutoff INTEGER remains the SESSION-MONOTONIC ingest chunk seq
 * (runtime.currentStartSeq / runtime.lastSentSeq), which never resets — emitRealtimeUtterance
 * keeps start_seq/end_seq on those cursors. We still do NOT overwrite the seq cursors from
 * buf.startMs/buf.endMs (that would invert order post-reconnect); the connection-session base
 * is a SEPARATE, session-monotonic offset applied only to the timestamps. finalize sorts by
 * start_ms (reconcile.ts), which is now correct because the base is monotonic.
 */
/**
 * Cancel a pending silence-timeout flush timer (idempotent). Called whenever the buffer is
 * settled (flush) or the stream is torn down (close), so a stale timer can never fire
 * flushSttBuffer against a buffer that has since moved on to a newer sentence.
 */
function clearSilenceFlushTimer(runtime: AsrRealtimeRuntime): void {
  if (runtime.silenceFlushTimer !== null) {
    clearTimeout(runtime.silenceFlushTimer);
    runtime.silenceFlushTimer = null;
  }
}

/**
 * Whether the accumulated buffer text already terminates on a sentence-final punctuation mark
 * (reuses transcript-cleaner's SENTENCE_FINAL_PUNCT so the endpointing gate and the cleaner
 * agree on what "a complete sentence" looks like). Latin finals from Speechmatics carry ".?!";
 * Chinese realtime finals do not, so CJK utterances read as unterminated and rely on the
 * long-silence backstop. Compares the LAST buffered final's trailing char (that is the text
 * flushSttBuffer would join to the end).
 */
function bufferEndsWithSentenceStop(
  buf: NonNullable<AsrRealtimeRuntime["sttBuffer"]>
): boolean {
  const last = buf.texts[buf.texts.length - 1]?.trim() ?? "";
  return SENTENCE_FINAL_PUNCT.test(last);
}

/**
 * Arm (or re-arm) the per-stream silence-timeout flush — now a TWO-LEVEL settle so that a short
 * thinking pause never chops an unfinished phrase (real-user round-3):
 *
 *   1. At STT_SILENCE_FLUSH_MS (short pause) we only settle the buffer if its text already ends
 *      on sentence-final punctuation. If it does not (mid-phrase pause, or a Chinese utterance
 *      that carries no CJK sentence mark), we do NOT flush — instead we re-arm toward the
 *      backstop deadline so accumulation continues.
 *   2. At STT_MAX_UTTERANCE_SILENCE_MS (long-silence backstop, since the LAST buffered final) we
 *      flush UNCONDITIONALLY, so a long unpunctuated monologue still definitively settles instead
 *      of hanging forever.
 *
 * Each buffered final re-arms level 1 (bufferedAtMs = now), so the backstop is measured from the
 * most recent final. flushSttBuffer is idempotent (nulls sttBuffer before the empty check), so a
 * race with the gap-flush / speaker-change path is a harmless no-op.
 */
function armSilenceFlushTimer(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): void {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const silenceMs = resolveSttSilenceFlushMs(ctx.env);
  const backstopMs = resolveSttMaxUtteranceSilenceMs(ctx.env);
  // Backstop deadline (Date.now() basis) measured from THIS final. Re-armed every buffered final.
  const backstopDeadline = Date.now() + backstopMs;
  scheduleSilenceCheck(sessionId, streamRole, ctx, silenceMs, backstopDeadline);
}

/**
 * Schedule the next silence-flush check `delayMs` from now. When it fires it either flushes (buffer
 * ends on a sentence stop, or the backstop deadline has been reached) or re-schedules a check at the
 * backstop deadline. Split out from armSilenceFlushTimer so the re-arm on a punctuation miss reuses
 * the SAME deadline (the backstop stays anchored to the last final, not pushed forward each hop).
 */
function scheduleSilenceCheck(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext,
  delayMs: number,
  backstopDeadline: number
): void {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  clearSilenceFlushTimer(runtime);
  runtime.silenceFlushTimer = setTimeout(() => {
    runtime.silenceFlushTimer = null;
    const buf = runtime.sttBuffer;
    if (!buf || buf.texts.length === 0) return;
    const backstopReached = Date.now() >= backstopDeadline;
    if (backstopReached || bufferEndsWithSentenceStop(buf)) {
      // Fire-and-forget: flushSttBuffer is self-contained and idempotent. Swallow errors so an
      // emit failure can never surface as an unhandled rejection on the timer callback.
      void flushSttBuffer(sessionId, streamRole, ctx).catch(() => {});
      return;
    }
    // Short pause with no terminal punctuation → keep accumulating; re-schedule the next check at
    // the (unchanged) backstop deadline so the long-silence force-flush still fires on time.
    const remaining = Math.max(0, backstopDeadline - Date.now());
    scheduleSilenceCheck(sessionId, streamRole, ctx, remaining, backstopDeadline);
  }, delayMs);
}

async function flushSttBuffer(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  clearSilenceFlushTimer(runtime);
  const buf = runtime.sttBuffer;
  runtime.sttBuffer = null;
  if (!buf || buf.texts.length === 0) return;
  // R-H: CJK-aware join — plain ASCII-space join inserted phantom spaces into Chinese
  // ("你好 世界"). joinTranscriptPieces picks the separator per boundary (empty across a
  // CJK/punctuation boundary, single space between Latin words).
  const text = joinTranscriptPieces(buf.texts);
  if (!text) return;
  // P0-a: shift the Speechmatics connection-relative word times onto the session timeline via
  // this connection's session base. buf.startMs/buf.endMs already share the same connection
  // origin as connectionSessionBaseMs, so the sum is a correct absolute session timestamp.
  const base = runtime.connectionSessionBaseMs;
  await emitRealtimeUtterance(sessionId, streamRole, text, ctx, buf.speaker, {
    startMs: base + buf.startMs,
    endMs: base + buf.endMs,
  });
}

// ── ensureRealtimeAsrConnected ─────────────────────────────────────────────

export async function ensureRealtimeAsrConnected(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  await hydrateRuntimeFromCursor(streamRole, ctx);
  if (runtime.connected && runtime.running && runtime.ws) return;
  if (runtime.connectPromise) return runtime.connectPromise;

  runtime.connectPromise = (async () => {
    runtime.connecting = true;
    await refreshAsrStreamMetrics(sessionId, streamRole, ctx);

    // A1b: realtime provider dispatch. Default stays DashScope (unchanged below);
    // ASR_PROVIDER=speechmatics routes to the Speechmatics outbound WS instead.
    if (realtimeProvider(ctx) === "speechmatics") {
      await connectSpeechmaticsRealtime(sessionId, streamRole, ctx);
      return;
    }

    const apiKey = (ctx.env.ALIYUN_DASHSCOPE_API_KEY ?? "").trim();
    if (!apiKey) throw new Error("ALIYUN_DASHSCOPE_API_KEY is missing");

    const asrByStream = await ctx.loadAsrByStream();
    const asrState = asrByStream[streamRole];
    const wsUrl = ctx.env.ASR_WS_URL ?? DASHSCOPE_DEFAULT_WS_URL;
    const handshakeUrl = toWebSocketHandshakeUrl(wsUrl);
    const timeoutMs = parseTimeoutMs(ctx.env.ASR_TIMEOUT_MS ?? "45000");

    const fetchAbort = new AbortController();
    const fetchTimer = setTimeout(
      () => fetchAbort.abort(),
      Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS)
    );
    const response = await fetch(handshakeUrl, {
      method: "GET",
      headers: {
        Authorization: `bearer ${apiKey}`,
        Upgrade: "websocket",
      },
      signal: fetchAbort.signal,
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
      ctx.doCtx.waitUntil(
        handleRealtimeAsrMessage(sessionId, streamRole, event.data, ctx).catch(async (error) => {
          log("error", "asr realtime message handler failed", {
            component: "asr",
            stream_role: streamRole,
            error: getErrorMessage(error),
          });
          await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
            asr_ws_state: "error",
            last_error: getErrorMessage(error),
          });
        })
      );
    });

    ws.addEventListener("error", () => {
      ctx.doCtx.waitUntil(
        refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
          asr_ws_state: "error",
          last_error: "dashscope websocket error",
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
      ctx.doCtx.waitUntil(refreshAsrStreamMetrics(sessionId, streamRole, ctx));
    });

    ws.send(
      JSON.stringify({
        header: {
          action: "run-task",
          task_id: runtime.taskId,
          streaming: "duplex",
        },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          model: asrState.model,
          input: {},
          parameters: {
            format: "pcm",
            sample_rate: TARGET_SAMPLE_RATE,
          },
        },
      })
    );

    const startedTimeout = setTimeout(() => {
      runtime.readyReject?.(new Error("dashscope task-started timeout"));
    }, Math.min(timeoutMs, DASHSCOPE_TIMEOUT_CAP_MS));

    await runtime.readyPromise;
    clearTimeout(startedTimeout);
    runtime.reconnectBackoffMs = 500;
    await replayGapFromR2(sessionId, streamRole, ctx);

    await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
      asr_ws_state: "running",
      last_error: null,
    });
  })()
    .catch(async (error) => {
      runtime.connected = false;
      runtime.running = false;
      runtime.ws = null;
      runtime.readyPromise = null;
      runtime.readyResolve = null;
      runtime.readyReject = null;
      await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
        asr_ws_state: "error",
        last_error: getErrorMessage(error),
      });
      throw error;
    })
    .finally(() => {
      runtime.connecting = false;
      runtime.connectPromise = null;
    });

  return runtime.connectPromise;
}

// ── drainRealtimeQueue ─────────────────────────────────────────────────────

export async function drainRealtimeQueue(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  if (runtime.flushPromise) return runtime.flushPromise;

  // Backpressure is driven by Speechmatics AudioAdded acks, which only the
  // Speechmatics provider emits. On the DashScope path lastAckedSeq never advances,
  // so gating here prevents a false permanent throttle for that provider.
  const backpressureEnabled = realtimeProvider(ctx) === "speechmatics";

  const startGen = runtime.drainGeneration;
  runtime.flushPromise = (async () => {
    while (runtime.sendQueue.length > 0 && runtime.drainGeneration === startGen) {
      try {
        let lastSentSeq = runtime.lastSentSeq;
        await ensureRealtimeAsrConnected(sessionId, streamRole, ctx);
        if (runtime.drainGeneration !== startGen) break;
        if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) {
          throw new Error("dashscope websocket is not open");
        }

        // Backpressure: if Speechmatics is more than BACKPRESSURE_WINDOW frames
        // behind our sent-seq, skip this drain pass and let AudioAdded acks reduce
        // the lag. Acks arrive via handleSpeechmaticsMessage (inbound WS path),
        // which is independent of this send path — no deadlock risk.
        let throttled = false;
        while (runtime.sendQueue.length > 0 && runtime.drainGeneration === startGen) {
          // Compare frames actually sent on THIS WS (lastSentToSpeechmaticsSeq)
          // against Speechmatics acks (lastAckedSeq) — NOT lastSentSeq, which is the
          // ingest/replay cursor mutated by transcript-timing inference.
          if (backpressureEnabled) {
            const lag = backpressureLag(runtime.lastSentToSpeechmaticsSeq, runtime.lastAckedSeq);
            if (shouldThrottle(lag, BACKPRESSURE_WINDOW)) {
              throttled = true;
              break;
            }
          }

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
          // Per-connection send counter for backpressure: one increment per real
          // frame, mirroring the seq_no Speechmatics will assign in its AudioAdded ack.
          runtime.lastSentToSpeechmaticsSeq++;
          runtime.sentChunkTsBySeq.set(head.seq, head.receivedAtMs);
          // Update idle timestamp so a recent real frame suppresses keepalive.
          runtime.lastAudioSentAt = Date.now();
          runtime.sendQueue.shift();
        }

        await ctx.patchAsrCursor(streamRole, { last_sent_seq: lastSentSeq });
        // Include backpressure lag in the metrics snapshot so operators can observe it.
        // Only meaningful on the Speechmatics path (it depends on AudioAdded acks);
        // left undefined on DashScope so the metric is absent rather than a misleading
        // monotonically-growing value.
        await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
          backpressure_lag: backpressureEnabled
            ? backpressureLag(runtime.lastSentToSpeechmaticsSeq, runtime.lastAckedSeq)
            : undefined,
        });

        // If we throttled this pass, stop draining now. The next incoming audio
        // chunk or keepalive tick will re-trigger drainRealtimeQueue; by then acks
        // should have reduced the lag below the window.
        // throttle triggered in inner loop; stop this drain pass — re-entry via next enqueue or tick
        if (throttled) break;
      } catch (error) {
        if (runtime.drainGeneration !== startGen) break;
        await refreshAsrStreamMetrics(sessionId, streamRole, ctx, {
          asr_ws_state: "error",
          last_error: getErrorMessage(error),
        });
        await closeRealtimeAsrSession(streamRole, "reconnect", ctx, false, false);
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

// ── maybeSendKeepalive ─────────────────────────────────────────────────────

/**
 * Send a PCM-silence keepalive frame to the outbound ASR WebSocket if the stream
 * has been idle longer than ASR_KEEPALIVE_MS (default 5 s).
 *
 * Design: the pure decision logic lives in shouldSendKeepalive() (asr-helpers.ts),
 * which is fully unit-tested without any timer or WS dependency. This function is
 * the thin integration wrapper — call it from a periodic DO alarm or a tick handler.
 *
 * Silence is safe for diarization: Speechmatics produces no speech/speaker output
 * for a zero-valued PCM frame, so no phantom speaker label is ever injected.
 *
 * NOTE: DO alarm wiring is deferred to gate R3 (idle-drop risk unconfirmed;
 * desktop captures audio continuously). See phase-r-pipeline-hardening.md Task 2.
 *
 * @returns true if a keepalive frame was actually sent, false if skipped.
 */
export function maybeSendKeepalive(
  streamRole: StreamRole,
  ctx: RealtimeAsrContext
): boolean {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  if (!runtime.ws || !runtime.connected || !runtime.running) return false;
  // WebSocket.OPEN === 1 per the WS spec; Workers runtime exposes it as a numeric constant.
  if (runtime.ws.readyState !== WebSocket.OPEN) return false;

  const intervalMs = resolveKeepaliveMs(ctx.env);
  const now = Date.now();
  if (!shouldSendKeepalive(runtime.lastAudioSentAt, now, intervalMs)) return false;

  // 100 ms of PCM16 silence (3200 bytes at 16 kHz mono). Short enough to be negligible
  // bandwidth-wise, long enough to reset any server-side idle watchdog.
  const silence = makeSilencePcm16(100);
  try {
    runtime.ws.send(silence);
    // Do NOT update lastAudioSentAt here — a keepalive must not suppress the next
    // keepalive tick. Only real audio chunks reset the idle clock (see drainRealtimeQueue).
  } catch {
    // Ignore send errors; the next tick will retry or reconnect via drainRealtimeQueue.
  }
  return true;
}

// ── maybeRunAsrWindows ─────────────────────────────────────────────────────

export async function maybeRunAsrWindows(
  sessionId: string,
  streamRole: StreamRole,
  ctx: RealtimeAsrContext,
  force = false,
  maxWindows = 0
): Promise<AsrRunResult> {
  const asrByStream = await ctx.loadAsrByStream();
  const asrState = asrByStream[streamRole];
  asrState.mode = "windowed";
  asrState.asr_ws_state = "disconnected";
  const utterancesByStream = await ctx.loadUtterancesRawByStream();
  const utterances = utterancesByStream[streamRole];

  if (!asrState.enabled) {
    asrState.last_error = "ASR disabled or API key missing";
    asrByStream[streamRole] = asrState;
    await ctx.storeAsrByStream(asrByStream);
    return {
      generated: 0,
      last_window_end_seq: asrState.last_window_end_seq,
      utterance_count: utterances.length,
      total_windows_processed: asrState.total_windows_processed,
      total_audio_seconds_processed: asrState.total_audio_seconds_processed,
      last_window_latency_ms: asrState.last_window_latency_ms ?? null,
      avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
      avg_rtf: asrState.avg_rtf ?? null,
      last_error: asrState.last_error,
    };
  }

  if (ctx.asrProcessingByStream[streamRole] && !force) {
    return {
      generated: 0,
      last_window_end_seq: asrState.last_window_end_seq,
      utterance_count: utterances.length,
      total_windows_processed: asrState.total_windows_processed,
      total_audio_seconds_processed: asrState.total_audio_seconds_processed,
      last_window_latency_ms: asrState.last_window_latency_ms ?? null,
      avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
      avg_rtf: asrState.avg_rtf ?? null,
      last_error: asrState.last_error ?? null,
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
      last_error: asrState.last_error ?? null,
    };
  }

  ctx.asrProcessingByStream[streamRole] = true;
  let generated = 0;

  try {
    const ingestByStream = await ctx.loadIngestByStream(sessionId);
    const ingest = ingestByStream[streamRole];
    let nextEndSeq = Math.max(
      asrState.last_window_end_seq + asrState.hop_seconds,
      asrState.window_seconds
    );

    while (nextEndSeq <= ingest.last_seq && (maxWindows <= 0 || generated < maxWindows)) {
      const startSeq = nextEndSeq - asrState.window_seconds + 1;
      const chunkRange = await loadChunkRange(sessionId, streamRole, startSeq, nextEndSeq, ctx);
      const pcm = concatUint8Arrays(chunkRange);
      const wavBytes = pcm16ToWavBytes(pcm);
      let result: { text: string; latencyMs: number };
      const asrProviderType = getAsrProvider(ctx);
      const lw = ctx.getLocalWhisperProvider();
      if (asrProviderType === "local-whisper" && lw) {
        result = await lw.transcribeWindow(wavBytes);
      } else {
        result = await runFunAsrDashScopeFn(ctx.env, wavBytes, asrState.model);
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
        latency_ms: result.latencyMs,
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
          await autoResolveStudentsUtterance(sessionId, utterance, wavBytes, ctx);
        } catch (error) {
          const inferenceError = error instanceof InferenceRequestError ? error : null;
          await ctx.appendSpeakerEvent({
            ts: new Date().toISOString(),
            stream_role: "students",
            source: "inference_resolve",
            utterance_id: utterance.utterance_id,
            cluster_id: null,
            speaker_name: null,
            decision: "unknown",
            evidence: null,
            note: `students auto-resolve failed: ${getErrorMessage(error)}`,
            backend: inferenceError ? inferenceError.health.active_backend : "primary",
            fallback_reason: inferenceError ? "resolve_all_backends_failed" : null,
            confidence_bucket: "unknown",
            metadata: { timeline: inferenceError?.timeline ?? null },
          });
        }
      } else if (streamRole === "teacher") {
        await appendTeacherSpeakerEvent(sessionId, utterance, ctx);
      }

      // Persist state after every window to keep the DO I/O gate alive
      asrByStream[streamRole] = asrState;
      await ctx.storeAsrByStream(asrByStream);
      utterancesByStream[streamRole] = utterances;
      await ctx.storeUtterancesRawByStream(utterancesByStream);

      if (generated % 5 === 0) {
        log("info", "asr progress", {
          component: "asr",
          stream_role: streamRole,
          windows: generated,
          last_seq: nextEndSeq,
          total_seq: ingest.last_seq,
        });
      }

      nextEndSeq += asrState.hop_seconds;
    }

    // Final merge after all windows
    const mergedByStream = await ctx.loadUtterancesMergedByStream();
    mergedByStream[streamRole] = mergeUtterances(utterances);
    await ctx.storeUtterancesMergedByStream(mergedByStream);

    return {
      generated,
      last_window_end_seq: asrState.last_window_end_seq,
      utterance_count: utterances.length,
      total_windows_processed: asrState.total_windows_processed,
      total_audio_seconds_processed: asrState.total_audio_seconds_processed,
      last_window_latency_ms: asrState.last_window_latency_ms ?? null,
      avg_window_latency_ms: asrState.avg_window_latency_ms ?? null,
      avg_rtf: asrState.avg_rtf ?? null,
      last_error: asrState.last_error ?? null,
    };
  } catch (error) {
    asrState.consecutive_failures += 1;
    asrState.last_error = getErrorMessage(error);
    const backoffMs = Math.min(
      MAX_BACKOFF_MS,
      1000 * 2 ** Math.min(asrState.consecutive_failures, 6)
    );
    asrState.next_retry_after_ms = Date.now() + backoffMs;
    asrByStream[streamRole] = asrState;
    await ctx.storeAsrByStream(asrByStream);

    if (generated > 0) {
      utterancesByStream[streamRole] = utterances;
      await ctx.storeUtterancesRawByStream(utterancesByStream);
      const mergedByStream = await ctx.loadUtterancesMergedByStream();
      mergedByStream[streamRole] = mergeUtterances(utterances);
      await ctx.storeUtterancesMergedByStream(mergedByStream);
      log("warn", "asr persisted partial utterances despite error", {
        component: "asr",
        stream_role: streamRole,
        windows: generated,
        error: getErrorMessage(error),
      });
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
      last_error: asrState.last_error,
    };
  } finally {
    ctx.asrProcessingByStream[streamRole] = false;
  }
}
