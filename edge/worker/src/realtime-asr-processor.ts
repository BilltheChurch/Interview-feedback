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
} from "./config";
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
  gracefulFinish = true
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
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
              streaming: "duplex",
            },
            payload: { input: {} },
          })
        );
        await sleep(1000);
      }
    } catch {
      // ignore finish-task errors during close
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
      const endpoint =
        ctx.env.ASR_ENDPOINT ?? ctx.env.INFERENCE_BASE_URL_PRIMARY ?? "http://127.0.0.1:8000";
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
  ctx: RealtimeAsrContext
): Promise<void> {
  const runtime = ctx.asrRealtimeByStream[streamRole];
  const endSeq = Math.max(runtime.lastSentSeq, runtime.currentStartSeq ?? runtime.lastSentSeq);
  if (endSeq <= 0) return;

  const startSeq = runtime.currentStartSeq ?? endSeq;
  const createdAt = new Date().toISOString();
  const endIngestAtMs = runtime.sentChunkTsBySeq.get(endSeq) ?? Date.now();
  const latencyMs = Math.max(0, Date.now() - endIngestAtMs);
  const startMs = (startSeq - 1) * 1000;
  const endMs = endSeq * 1000;

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
    asr_provider: "dashscope",
    confidence: null,
    created_at: createdAt,
    latency_ms: latencyMs,
  };
  utterances.push(utterance);
  utterancesByStream[streamRole] = utterances;
  await ctx.storeUtterancesRawByStream(utterancesByStream);

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

        await ctx.patchAsrCursor(streamRole, { last_sent_seq: lastSentSeq });
        await refreshAsrStreamMetrics(sessionId, streamRole, ctx);
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
