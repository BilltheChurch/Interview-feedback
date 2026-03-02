/**
 * incremental.ts — Incremental scheduling helpers for the MeetingSessionDO.
 *
 * Pure helper functions (no DO state access) for scheduling decisions and
 * response parsing. Payload construction is in incremental_v1.ts.
 *
 * V0 payload builders have been removed — all traffic goes through V1.
 */

import type { IncrementalStatus, IncrementalSpeakerProfile } from "./types_v2";

// ── Env subset needed by scheduling helpers ───────────────────────────────
// Internal tuning — these values are code defaults, not exposed in wrangler.jsonc.

export interface IncrementalEnv {
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

function parseEnvInt(raw: string | undefined, fallback: number): number {
  const v = Number(raw ?? String(fallback));
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
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

  // Callers gate on incrementalV1Enabled() before reaching here.
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
    confidence: number;
    increment_index: number;
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
  const rawIncrementIndex = typeof json.increment_index === "number" ? json.increment_index : 0;
  const utterances = Array.isArray(json.utterances)
    ? (json.utterances as any[]).map((u) => ({
        ...u,
        confidence: typeof u.confidence === "number" ? u.confidence : 1.0,
        increment_index: typeof u.increment_index === "number" ? u.increment_index : rawIncrementIndex,
      }))
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
