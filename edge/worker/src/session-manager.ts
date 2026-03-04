/**
 * session-manager.ts — DO storage load/store functions for session state.
 *
 * Each function takes explicit storage/env dependencies rather than `this`.
 * The MeetingSessionDO class delegates to these functions to reduce its
 * internal surface area while keeping the DO class as the orchestrator.
 *
 * Pattern: all functions are `async` and accept a `DurableObjectStorage`
 * as their first parameter, matching the established helper module style.
 */

import {
  emptyIngestByStream,
  emptyUtterancesRawByStream,
  STORAGE_KEY_INGEST_BY_STREAM,
  STORAGE_KEY_INGEST_STATE,
  STORAGE_KEY_ASR_BY_STREAM,
  STORAGE_KEY_ASR_STATE,
  STORAGE_KEY_UTTERANCES_RAW_BY_STREAM,
  STORAGE_KEY_UTTERANCES_RAW,
  STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM,
  STORAGE_KEY_EVENTS,
  STORAGE_KEY_DEPENDENCY_HEALTH,
  STORAGE_KEY_ASR_CURSOR_BY_STREAM,
  STORAGE_KEY_MEMOS,
  STORAGE_KEY_SPEAKER_LOGS,
  STORAGE_KEY_FEEDBACK_CACHE,
  STORAGE_KEY_UPDATED_AT,
  STORAGE_KEY_FINALIZE_V2_STATUS,
  STORAGE_KEY_FINALIZE_LOCK,
  STORAGE_KEY_SESSION_PHASE,
  STORAGE_KEY_FINALIZE_STAGE_DATA,
  STORAGE_KEY_TIER2_STATUS,
  STORAGE_KEY_INCREMENTAL_STATUS,
  STORAGE_KEY_INCREMENTAL_ALARM_TAG,
  STORAGE_KEY_CHECKPOINTS,
  STORAGE_KEY_LAST_CHECKPOINT_AT,
  STORAGE_KEY_STATE,
  STREAM_ROLES,
  type StreamRole,
  type SessionState,
  type IngestState,
  type AsrState,
  type UtteranceRaw,
  type UtteranceMerged,
  type SpeakerEvent,
  type AsrReplayCursor,
  type FeedbackCache,
  normalizeSessionState,
  mergeUtterances,
  transitionSessionPhase,
  log,
  emptyFeedbackCache
} from "./config";
import type {
  FinalizeV2Status,
  FinalizeStageCheckpoint,
  Tier2Status,
  MemoItem,
  SpeakerLogs,
  SessionPhase,
  CheckpointResult,
  IncrementalStatus
} from "./types_v2";
import type { DependencyHealthSnapshot } from "./inference_client";
import { emptySpeakerLogs } from "./speaker_logs";
import { createDefaultIncrementalStatus } from "./incremental";
import type { AsrEnvConfig } from "./asr-helpers";
import { sanitizeAsrState, defaultAsrByStream, emptyAsrCursorByStream } from "./asr-helpers";

// ── Ingest state ─────────────────────────────────────────────────────

export async function loadIngestByStream(
  storage: DurableObjectStorage,
  sessionId: string
): Promise<Record<StreamRole, IngestState>> {
  const current = await storage.get<Record<StreamRole, IngestState>>(STORAGE_KEY_INGEST_BY_STREAM);
  if (current?.mixed && current?.teacher && current?.students) {
    return current;
  }

  const migrated = emptyIngestByStream(sessionId);
  const legacy = await storage.get<IngestState>(STORAGE_KEY_INGEST_STATE);
  if (legacy) {
    migrated.mixed = legacy;
  }

  await storeIngestByStream(storage, migrated);
  return migrated;
}

export async function storeIngestByStream(
  storage: DurableObjectStorage,
  state: Record<StreamRole, IngestState>
): Promise<void> {
  for (const role of STREAM_ROLES) {
    state[role].updated_at = new Date().toISOString();
  }
  await storage.put(STORAGE_KEY_INGEST_BY_STREAM, state);
  await storage.put(STORAGE_KEY_INGEST_STATE, state.mixed);
}

// ── ASR state ────────────────────────────────────────────────────────

export async function loadAsrByStream(
  storage: DurableObjectStorage,
  env: AsrEnvConfig
): Promise<Record<StreamRole, AsrState>> {
  const current = await storage.get<Record<StreamRole, AsrState>>(STORAGE_KEY_ASR_BY_STREAM);
  if (current?.mixed && current?.teacher && current?.students) {
    current.mixed = sanitizeAsrState(current.mixed, env);
    current.teacher = sanitizeAsrState(current.teacher, env);
    current.students = sanitizeAsrState(current.students, env);
    return current;
  }

  const migrated = defaultAsrByStream(env);
  const legacy = await storage.get<AsrState>(STORAGE_KEY_ASR_STATE);
  if (legacy) {
    migrated.mixed = sanitizeAsrState(legacy, env);
  }

  await storeAsrByStream(storage, migrated);
  return migrated;
}

export async function storeAsrByStream(
  storage: DurableObjectStorage,
  state: Record<StreamRole, AsrState>
): Promise<void> {
  for (const role of STREAM_ROLES) {
    state[role].updated_at = new Date().toISOString();
  }
  await storage.put(STORAGE_KEY_ASR_BY_STREAM, state);
  await storage.put(STORAGE_KEY_ASR_STATE, state.mixed);
}

// ── Utterances ───────────────────────────────────────────────────────

export async function loadUtterancesRawByStream(
  storage: DurableObjectStorage
): Promise<Record<StreamRole, UtteranceRaw[]>> {
  const current = await storage.get<Record<StreamRole, UtteranceRaw[]>>(STORAGE_KEY_UTTERANCES_RAW_BY_STREAM);
  if (current?.mixed && current?.teacher && current?.students) {
    return current;
  }

  const migrated = emptyUtterancesRawByStream();
  const legacy = await storage.get<UtteranceRaw[]>(STORAGE_KEY_UTTERANCES_RAW);
  if (legacy && Array.isArray(legacy)) {
    migrated.mixed = legacy.map((item) => ({ ...item, stream_role: item.stream_role ?? "mixed" }));
  }

  await storeUtterancesRawByStream(storage, migrated);
  return migrated;
}

export async function storeUtterancesRawByStream(
  storage: DurableObjectStorage,
  state: Record<StreamRole, UtteranceRaw[]>
): Promise<void> {
  await storage.put(STORAGE_KEY_UTTERANCES_RAW_BY_STREAM, state);
  await storage.put(STORAGE_KEY_UTTERANCES_RAW, state.mixed);
}

export async function loadUtterancesMergedByStream(
  storage: DurableObjectStorage
): Promise<Record<StreamRole, UtteranceMerged[]>> {
  const current = await storage.get<Record<StreamRole, UtteranceMerged[]>>(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM);
  if (current?.mixed && current?.teacher && current?.students) {
    return current;
  }

  const raw = await loadUtterancesRawByStream(storage);
  const rebuilt: Record<StreamRole, UtteranceMerged[]> = {
    mixed: mergeUtterances(raw.mixed),
    teacher: mergeUtterances(raw.teacher),
    students: mergeUtterances(raw.students)
  };
  await storage.put(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM, rebuilt);
  return rebuilt;
}

export async function storeUtterancesMergedByStream(
  storage: DurableObjectStorage,
  state: Record<StreamRole, UtteranceMerged[]>
): Promise<void> {
  await storage.put(STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM, state);
}

// ── Speaker events ───────────────────────────────────────────────────

export async function loadSpeakerEvents(
  storage: DurableObjectStorage
): Promise<SpeakerEvent[]> {
  return (await storage.get<SpeakerEvent[]>(STORAGE_KEY_EVENTS)) ?? [];
}

export async function storeSpeakerEvents(
  storage: DurableObjectStorage,
  events: SpeakerEvent[]
): Promise<void> {
  await storage.put(STORAGE_KEY_EVENTS, events);
}

export async function appendSpeakerEvent(
  storage: DurableObjectStorage,
  event: SpeakerEvent
): Promise<void> {
  const events = await loadSpeakerEvents(storage);
  events.push(event);
  await storage.put(STORAGE_KEY_EVENTS, events);
}

// ── Dependency health ────────────────────────────────────────────────

export async function storeDependencyHealth(
  storage: DurableObjectStorage,
  health: DependencyHealthSnapshot
): Promise<void> {
  await storage.put(STORAGE_KEY_DEPENDENCY_HEALTH, health);
}

export async function loadDependencyHealth(
  storage: DurableObjectStorage,
  fallbackSnapshot: DependencyHealthSnapshot
): Promise<DependencyHealthSnapshot> {
  const stored = await storage.get<DependencyHealthSnapshot>(STORAGE_KEY_DEPENDENCY_HEALTH);
  if (stored) return stored;
  await storeDependencyHealth(storage, fallbackSnapshot);
  return fallbackSnapshot;
}

// ── ASR cursor ───────────────────────────────────────────────────────

export async function loadAsrCursorByStream(
  storage: DurableObjectStorage,
  nowIsoTs: string
): Promise<Record<StreamRole, AsrReplayCursor>> {
  const current = await storage.get<Record<StreamRole, AsrReplayCursor>>(STORAGE_KEY_ASR_CURSOR_BY_STREAM);
  if (current?.mixed && current?.teacher && current?.students) {
    return current;
  }
  const created = emptyAsrCursorByStream(nowIsoTs);
  await storage.put(STORAGE_KEY_ASR_CURSOR_BY_STREAM, created);
  return created;
}

export async function patchAsrCursor(
  storage: DurableObjectStorage,
  streamRole: StreamRole,
  patch: Partial<AsrReplayCursor>,
  nowIsoTs: string
): Promise<void> {
  const current = await loadAsrCursorByStream(storage, nowIsoTs);
  const next = {
    ...current[streamRole],
    ...patch,
    updated_at: nowIsoTs
  };
  current[streamRole] = next;
  await storage.put(STORAGE_KEY_ASR_CURSOR_BY_STREAM, current);
}

// ── Memos ────────────────────────────────────────────────────────────

export async function loadMemos(
  storage: DurableObjectStorage
): Promise<MemoItem[]> {
  return (await storage.get<MemoItem[]>(STORAGE_KEY_MEMOS)) ?? [];
}

export async function storeMemos(
  storage: DurableObjectStorage,
  memos: MemoItem[]
): Promise<void> {
  await storage.put(STORAGE_KEY_MEMOS, memos);
}

// ── Speaker logs ─────────────────────────────────────────────────────

export async function loadSpeakerLogs(
  storage: DurableObjectStorage,
  nowIsoTs: string
): Promise<SpeakerLogs> {
  const stored = await storage.get<SpeakerLogs>(STORAGE_KEY_SPEAKER_LOGS);
  if (stored) return stored;
  const created = emptySpeakerLogs(nowIsoTs);
  await storage.put(STORAGE_KEY_SPEAKER_LOGS, created);
  return created;
}

export async function storeSpeakerLogs(
  storage: DurableObjectStorage,
  logs: SpeakerLogs
): Promise<void> {
  await storage.put(STORAGE_KEY_SPEAKER_LOGS, logs);
}

// ── Feedback cache ───────────────────────────────────────────────────

export async function loadFeedbackCache(
  storage: DurableObjectStorage,
  sessionId: string,
  nowIsoTs: string
): Promise<FeedbackCache> {
  const existing = await storage.get<FeedbackCache>(STORAGE_KEY_FEEDBACK_CACHE);
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
  const created = emptyFeedbackCache(sessionId, nowIsoTs);
  await storage.put(STORAGE_KEY_FEEDBACK_CACHE, created);
  return created;
}

export async function storeFeedbackCache(
  storage: DurableObjectStorage,
  cache: FeedbackCache
): Promise<void> {
  await storage.put(STORAGE_KEY_FEEDBACK_CACHE, cache);
  await storage.put(STORAGE_KEY_UPDATED_AT, cache.updated_at);
}

// ── Finalize V2 status ───────────────────────────────────────────────

export async function loadFinalizeV2Status(
  storage: DurableObjectStorage,
  nowIsoTs: string
): Promise<FinalizeV2Status | null> {
  const stored = (await storage.get<FinalizeV2Status>(STORAGE_KEY_FINALIZE_V2_STATUS)) ?? null;
  if (!stored) return null;
  const heartbeat = typeof stored.heartbeat_at === "string" ? stored.heartbeat_at : stored.started_at;
  const normalized: FinalizeV2Status = {
    ...stored,
    heartbeat_at: heartbeat ?? nowIsoTs,
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
  await storage.put(STORAGE_KEY_FINALIZE_V2_STATUS, normalized);
  return normalized;
}

export async function storeFinalizeV2Status(
  storage: DurableObjectStorage,
  status: FinalizeV2Status,
  nowIsoTs: string
): Promise<FinalizeV2Status> {
  const normalized: FinalizeV2Status = {
    ...status,
    heartbeat_at: status.heartbeat_at ?? status.started_at ?? nowIsoTs,
    warnings: Array.isArray(status.warnings) ? status.warnings : [],
    degraded: Boolean(status.degraded),
    backend_used: status.backend_used ?? "primary"
  };
  await storage.put(STORAGE_KEY_FINALIZE_V2_STATUS, normalized);
  return normalized;
}

export async function setFinalizeLock(
  storage: DurableObjectStorage,
  locked: boolean
): Promise<void> {
  await storage.put(STORAGE_KEY_FINALIZE_LOCK, locked);
}

export async function isFinalizeLocked(
  storage: DurableObjectStorage
): Promise<boolean> {
  return Boolean(await storage.get<boolean>(STORAGE_KEY_FINALIZE_LOCK));
}

// ── Session phase ────────────────────────────────────────────────────

export async function loadSessionPhase(
  storage: DurableObjectStorage
): Promise<SessionPhase> {
  const stored = await storage.get<SessionPhase>(STORAGE_KEY_SESSION_PHASE);
  if (stored && ["idle", "recording", "finalizing", "finalized", "archived"].includes(stored)) {
    return stored;
  }
  return "idle";
}

export async function setSessionPhase(
  storage: DurableObjectStorage,
  target: SessionPhase
): Promise<SessionPhase> {
  const current = await loadSessionPhase(storage);
  const result = transitionSessionPhase(current, target);
  if (result.valid) {
    await storage.put(STORAGE_KEY_SESSION_PHASE, result.phase);
    log("info", `session-phase: ${current} → ${result.phase}`, { component: "session-phase" });
    return result.phase;
  }
  log("warn", `session-phase: invalid transition ${current} → ${target}, staying at ${current}`, { component: "session-phase" });
  return current;
}

export async function resetSessionPhase(
  storage: DurableObjectStorage,
  phase: SessionPhase
): Promise<void> {
  await storage.put(STORAGE_KEY_SESSION_PHASE, phase);
}

// ── Finalize stage checkpoint ────────────────────────────────────────

export async function loadFinalizeStageCheckpoint(
  storage: DurableObjectStorage
): Promise<FinalizeStageCheckpoint | null> {
  return (await storage.get<FinalizeStageCheckpoint>(STORAGE_KEY_FINALIZE_STAGE_DATA)) ?? null;
}

export async function saveFinalizeStageCheckpoint(
  storage: DurableObjectStorage,
  jobId: string,
  completedStage: FinalizeV2Status["stage"],
  stageData: Record<string, unknown>
): Promise<void> {
  const checkpoint: FinalizeStageCheckpoint = {
    job_id: jobId,
    completed_stage: completedStage,
    saved_at: Date.now(),
    stage_data: stageData
  };
  await storage.put(STORAGE_KEY_FINALIZE_STAGE_DATA, checkpoint);
}

export async function clearFinalizeStageCheckpoint(
  storage: DurableObjectStorage
): Promise<void> {
  await storage.delete(STORAGE_KEY_FINALIZE_STAGE_DATA);
}

// ── Tier 2 status ────────────────────────────────────────────────────

export function defaultTier2Status(enabled: boolean): Tier2Status {
  return {
    enabled,
    status: "idle",
    started_at: null,
    completed_at: null,
    error: null,
    report_version: "tier1_instant",
    progress: 0,
    warnings: []
  };
}

export async function loadTier2Status(
  storage: DurableObjectStorage,
  enabled: boolean
): Promise<Tier2Status> {
  const stored = await storage.get<Tier2Status>(STORAGE_KEY_TIER2_STATUS);
  if (!stored) return defaultTier2Status(enabled);
  return {
    ...stored,
    enabled: stored.enabled ?? enabled,
    warnings: Array.isArray(stored.warnings) ? stored.warnings : []
  };
}

export async function storeTier2Status(
  storage: DurableObjectStorage,
  status: Tier2Status
): Promise<void> {
  await storage.put(STORAGE_KEY_TIER2_STATUS, status);
}

export async function updateTier2Status(
  storage: DurableObjectStorage,
  patch: Partial<Tier2Status>,
  enabled: boolean
): Promise<Tier2Status> {
  const current = await loadTier2Status(storage, enabled);
  const next: Tier2Status = { ...current, ...patch };
  await storeTier2Status(storage, next);
  return next;
}

// ── Incremental status ───────────────────────────────────────────────

export async function loadIncrementalStatus(
  storage: DurableObjectStorage,
  enabled: boolean
): Promise<IncrementalStatus> {
  const stored = await storage.get<IncrementalStatus>(STORAGE_KEY_INCREMENTAL_STATUS);
  if (!stored) return createDefaultIncrementalStatus();
  return {
    ...createDefaultIncrementalStatus(),
    ...stored,
    enabled
  };
}

export async function storeIncrementalStatus(
  storage: DurableObjectStorage,
  status: IncrementalStatus
): Promise<void> {
  await storage.put(STORAGE_KEY_INCREMENTAL_STATUS, status);
}

export async function updateIncrementalStatus(
  storage: DurableObjectStorage,
  patch: Partial<IncrementalStatus>,
  enabled: boolean
): Promise<IncrementalStatus> {
  const current = await loadIncrementalStatus(storage, enabled);
  const next: IncrementalStatus = { ...current, ...patch };
  await storeIncrementalStatus(storage, next);
  return next;
}

export async function scheduleIncrementalAlarm(
  storage: DurableObjectStorage,
  sessionId: string
): Promise<void> {
  const existing = await storage.get<string>(STORAGE_KEY_INCREMENTAL_ALARM_TAG);
  if (existing) return;

  const tag = `incremental_${sessionId}_${Date.now()}`;
  await storage.put(STORAGE_KEY_INCREMENTAL_ALARM_TAG, tag);
  await storage.put("incremental_session_id", sessionId);
  await storage.setAlarm(Date.now() + 500);
  log("info", "incremental: alarm scheduled", { component: "incremental", session_id: sessionId, tag });
}

// ── Checkpoints ──────────────────────────────────────────────────────

export async function loadCheckpoints(
  storage: DurableObjectStorage
): Promise<CheckpointResult[]> {
  return (await storage.get<CheckpointResult[]>(STORAGE_KEY_CHECKPOINTS)) ?? [];
}

export async function storeCheckpoints(
  storage: DurableObjectStorage,
  checkpoints: CheckpointResult[]
): Promise<void> {
  await storage.put(STORAGE_KEY_CHECKPOINTS, checkpoints);
}

export async function loadLastCheckpointAt(
  storage: DurableObjectStorage
): Promise<number> {
  return (await storage.get<number>(STORAGE_KEY_LAST_CHECKPOINT_AT)) ?? 0;
}

export async function storeLastCheckpointAt(
  storage: DurableObjectStorage,
  ms: number
): Promise<void> {
  await storage.put(STORAGE_KEY_LAST_CHECKPOINT_AT, ms);
}

// ── Normalized session state helper ─────────────────────────────────

export async function loadNormalizedSessionState(
  storage: DurableObjectStorage
): Promise<SessionState> {
  return normalizeSessionState(await storage.get<SessionState>(STORAGE_KEY_STATE));
}
