/**
 * incremental.ts — Incremental processing helpers for the MeetingSessionDO.
 *
 * This module provides pure helper functions (no DO state access) for scheduling
 * and constructing incremental processing requests. The DO class in index.ts
 * calls these functions, keeping index.ts changes minimal.
 */

import type { IncrementalStatus, IncrementalSpeakerProfile, MemoItem, SpeakerStatItem, EvidenceItem } from "./types_v2";

// ── Env subset needed by scheduling helpers ───────────────────────────────

export interface IncrementalEnv {
  INCREMENTAL_ENABLED?: string;
  INCREMENTAL_INTERVAL_MS?: string;
  INCREMENTAL_OVERLAP_MS?: string;
  INCREMENTAL_CUMULATIVE_THRESHOLD?: string;
  INCREMENTAL_ANALYSIS_INTERVAL?: string;
}

// ── Default status ────────────────────────────────────────────────────────

export function createDefaultIncrementalStatus(): IncrementalStatus {
  return {
    enabled: false,
    status: "idle",
    increments_completed: 0,
    increments_failed: 0,
    last_processed_ms: 0,
    speakers_detected: 0,
    stable_speaker_map: false,
    checkpoints_completed: 0,
    started_at: null,
    last_increment_at: null,
    error: null,
    warnings: []
  };
}

// ── Env parsing helpers ───────────────────────────────────────────────────

function parseEnvBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const n = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(n)) return true;
  if (["0", "false", "no", "off"].includes(n)) return false;
  return fallback;
}

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const v = Number(raw ?? String(fallback));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

export function incrementalEnabled(env: IncrementalEnv): boolean {
  return parseEnvBool(env.INCREMENTAL_ENABLED, false);
}

export function incrementalIntervalMs(env: IncrementalEnv): number {
  return parseEnvInt(env.INCREMENTAL_INTERVAL_MS, 180_000);
}

export function incrementalOverlapMs(env: IncrementalEnv): number {
  return parseEnvInt(env.INCREMENTAL_OVERLAP_MS, 30_000);
}

export function incrementalCumulativeThreshold(env: IncrementalEnv): number {
  return parseEnvInt(env.INCREMENTAL_CUMULATIVE_THRESHOLD, 2);
}

export function incrementalAnalysisInterval(env: IncrementalEnv): number {
  return parseEnvInt(env.INCREMENTAL_ANALYSIS_INTERVAL, 2);
}

// ── Scheduling decision ───────────────────────────────────────────────────

export interface ScheduleDecision {
  schedule: boolean;
  startMs: number;
  endMs: number;
  incrementIndex: number;
}

/**
 * Determine whether a new incremental processing job should be scheduled.
 *
 * @param env            Worker env vars
 * @param status         Current IncrementalStatus stored in DO
 * @param totalAudioMs   Total audio duration ingested so far (received_chunks * 1000)
 * @returns              Decision object; schedule=false means "not yet"
 */
export function shouldScheduleIncremental(
  env: IncrementalEnv,
  status: IncrementalStatus,
  totalAudioMs: number
): ScheduleDecision {
  const noOp: ScheduleDecision = { schedule: false, startMs: 0, endMs: 0, incrementIndex: 0 };

  if (!incrementalEnabled(env)) return noOp;

  // Do not re-schedule while a job is running or the session is finalizing
  if (status.status === "processing" || status.status === "finalizing") return noOp;

  const intervalMs = incrementalIntervalMs(env);
  const overlapMs = incrementalOverlapMs(env);
  const cumulativeThreshold = incrementalCumulativeThreshold(env);

  const alreadyProcessedMs = status.last_processed_ms;
  const unprocessedMs = totalAudioMs - alreadyProcessedMs;

  if (unprocessedMs < intervalMs) return noOp;

  const incrementIndex = status.increments_completed;
  const endMs = totalAudioMs;

  // First N increments: cumulative mode (startMs=0 for full context)
  // After threshold: sliding window with overlap
  const startMs =
    incrementIndex < cumulativeThreshold
      ? 0
      : Math.max(0, alreadyProcessedMs - overlapMs);

  return { schedule: true, startMs, endMs, incrementIndex };
}

// ── Payload builders ──────────────────────────────────────────────────────

export interface ProcessChunkPayload {
  session_id: string;
  increment_index: number;
  audio_b64: string;
  start_ms: number;
  end_ms: number;
  language: string;
  speaker_profiles: IncrementalSpeakerProfile[];
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  run_analysis: boolean;
}

/**
 * Build the request body for POST /incremental/process-chunk.
 */
export function buildProcessChunkPayload(params: {
  sessionId: string;
  incrementIndex: number;
  audioB64: string;
  startMs: number;
  endMs: number;
  language: string;
  speakerProfiles: IncrementalSpeakerProfile[];
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  analysisInterval: number;
}): ProcessChunkPayload {
  const {
    sessionId,
    incrementIndex,
    audioB64,
    startMs,
    endMs,
    language,
    speakerProfiles,
    memos,
    stats,
    analysisInterval
  } = params;

  // Run analysis (events/claims) every N increments
  const runAnalysis = analysisInterval > 0 && incrementIndex % analysisInterval === 0;

  return {
    session_id: sessionId,
    increment_index: incrementIndex,
    audio_b64: audioB64,
    start_ms: startMs,
    end_ms: endMs,
    language,
    speaker_profiles: speakerProfiles,
    memos,
    stats,
    run_analysis: runAnalysis
  };
}

export interface FinalizePayload {
  session_id: string;
  audio_b64: string;
  start_ms: number;
  end_ms: number;
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  evidence: EvidenceItem[];
  locale: string;
  name_aliases: Record<string, string[]>;
}

/**
 * Build the request body for POST /incremental/finalize.
 */
export function buildFinalizePayload(params: {
  sessionId: string;
  finalAudioB64: string;
  startMs: number;
  endMs: number;
  memos: MemoItem[];
  stats: SpeakerStatItem[];
  evidence: EvidenceItem[];
  locale: string;
  nameAliases: Record<string, string[]>;
}): FinalizePayload {
  return {
    session_id: params.sessionId,
    audio_b64: params.finalAudioB64,
    start_ms: params.startMs,
    end_ms: params.endMs,
    memos: params.memos,
    stats: params.stats,
    evidence: params.evidence,
    locale: params.locale,
    name_aliases: params.nameAliases
  };
}

// ── Response parsers ──────────────────────────────────────────────────────

export interface ParsedProcessChunkResponse {
  utterances: Array<{
    utterance_id: string;
    stream_role: "mixed" | "teacher" | "students";
    speaker_name?: string | null;
    cluster_id?: string | null;
    text: string;
    start_ms: number;
    end_ms: number;
    duration_ms: number;
  }>;
  speakerProfiles: IncrementalSpeakerProfile[];
  checkpoint: Record<string, unknown> | null;
  speakerMapping: Record<string, string>;
  speakersDetected: number;
  stableSpeakerMap: boolean;
}

/**
 * Parse the JSON response from POST /incremental/process-chunk.
 * Returns safe defaults for missing fields so the DO never crashes on a partial response.
 */
export function parseProcessChunkResponse(json: Record<string, unknown>): ParsedProcessChunkResponse {
  const utterances = Array.isArray(json.utterances)
    ? (json.utterances as ParsedProcessChunkResponse["utterances"])
    : [];
  const speakerProfiles = Array.isArray(json.speaker_profiles)
    ? (json.speaker_profiles as IncrementalSpeakerProfile[])
    : [];
  const checkpoint =
    json.checkpoint && typeof json.checkpoint === "object"
      ? (json.checkpoint as Record<string, unknown>)
      : null;
  const speakerMapping =
    json.speaker_mapping && typeof json.speaker_mapping === "object" && !Array.isArray(json.speaker_mapping)
      ? (json.speaker_mapping as Record<string, string>)
      : {};
  const speakersDetected = typeof json.speakers_detected === "number" ? json.speakers_detected : speakerProfiles.length;
  const stableSpeakerMap = Boolean(json.stable_speaker_map);

  return { utterances, speakerProfiles, checkpoint, speakerMapping, speakersDetected, stableSpeakerMap };
}
