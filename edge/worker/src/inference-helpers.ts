/**
 * inference-helpers.ts — Inference HTTP call wrappers for MeetingSessionDO.
 *
 * Wraps InferenceFailoverClient calls with path/timeout resolution from env,
 * dependency health tracking, and local fallback for events analysis.
 *
 * Pattern: standalone async functions with explicit context rather than `this`.
 */

import {
  InferenceFailoverClient,
  InferenceRequestError,
  type InferenceBackendTimelineItem,
  type InferenceEndpointKey,
  type DependencyHealthSnapshot,
} from "./inference_client";
import { analyzeEventsLocally } from "./local_events_analyzer";
import type { Env } from "./config";
import { parseTimeoutMs, log, getErrorMessage } from "./config";
import type {
  AudioPayload,
  ResolveResponse,
  InferenceEnrollRequest,
  InferenceEnrollResponse,
  InferenceRegenerateClaimRequest,
  InferenceRegenerateClaimResponse,
  SessionState,
} from "./config";
import type {
  SynthesizeRequestPayload,
  CheckpointRequestPayload,
  CheckpointResult,
  MergeCheckpointsRequestPayload,
} from "./types_v2";

// ── Context interface ──────────────────────────────────────────────────────

export interface InferenceCallContext {
  inferenceClient: InferenceFailoverClient;
  env: Env;
  storeDependencyHealth: (health: DependencyHealthSnapshot) => Promise<void>;
}

// ── Core failover wrapper ──────────────────────────────────────────────────

export async function callInferenceWithFailover<T>(
  ctx: InferenceCallContext,
  params: {
    endpoint: InferenceEndpointKey;
    path: string;
    body: unknown;
    timeoutMs?: number;
  }
): Promise<{
  data: T;
  backend: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  try {
    const response = await ctx.inferenceClient.callJson<T>({
      endpoint: params.endpoint,
      path: params.path,
      body: params.body,
      timeoutMs: params.timeoutMs,
    });
    await ctx.storeDependencyHealth(response.health);
    return response;
  } catch (error) {
    if (error instanceof InferenceRequestError) {
      await ctx.storeDependencyHealth(error.health);
    } else {
      await ctx.storeDependencyHealth(ctx.inferenceClient.snapshot());
    }
    throw error;
  }
}

// ── Inference endpoint wrappers ────────────────────────────────────────────

export async function invokeInferenceResolve(
  ctx: InferenceCallContext,
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
  const resolvePath = ctx.env.INFERENCE_RESOLVE_PATH ?? "/speaker/resolve";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS);
  const response = await callInferenceWithFailover<ResolveResponse>(ctx, {
    endpoint: "resolve",
    path: resolvePath,
    timeoutMs,
    body: {
      session_id: sessionId,
      audio,
      asr_text: asrText,
      state: currentState,
    },
  });
  return {
    resolved: response.data,
    backend: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceEnroll(
  ctx: InferenceCallContext,
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
  const enrollPath = ctx.env.INFERENCE_ENROLL_PATH ?? "/speaker/enroll";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS);
  const response = await callInferenceWithFailover<InferenceEnrollResponse>(ctx, {
    endpoint: "enroll",
    path: enrollPath,
    timeoutMs,
    body: {
      session_id: sessionId,
      participant_name: participantName,
      audio,
      state,
    } satisfies InferenceEnrollRequest,
  });
  return {
    payload: response.data,
    backend: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceAnalysisEvents(
  ctx: InferenceCallContext,
  payload: Record<string, unknown>
): Promise<{
  events: Record<string, unknown>[];
  backend_used: "primary" | "secondary" | "local";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
  fallback_reason: string | null;
}> {
  const path = ctx.env.INFERENCE_EVENTS_PATH ?? "/analysis/events";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "15000");
  try {
    const response = await callInferenceWithFailover<{ events?: Record<string, unknown>[] }>(ctx, {
      endpoint: "analysis_events",
      path,
      timeoutMs,
      body: payload,
    });
    const events = Array.isArray(response.data?.events) ? response.data.events : [];
    return {
      events,
      backend_used: response.backend,
      degraded: response.degraded,
      warnings: response.warnings,
      timeline: response.timeline,
      fallback_reason: null,
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
      stats: stats as Array<{ speaker_key: string; talk_time_ms: number; turns: number }>,
    });
    const warning = `analysis/events fallback local analyzer: ${error.message}`;
    return {
      events: localEvents as unknown as Record<string, unknown>[],
      backend_used: "local",
      degraded: true,
      warnings: [warning],
      timeline: error.timeline,
      fallback_reason: "analysis_events_all_backends_failed",
    };
  }
}

export async function invokeInferenceAnalysisReport(
  ctx: InferenceCallContext,
  payload: Record<string, unknown>
): Promise<{
  data: Record<string, unknown>;
  backend_used: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  const path = ctx.env.INFERENCE_REPORT_PATH ?? "/analysis/report";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "15000");
  const response = await callInferenceWithFailover<Record<string, unknown>>(ctx, {
    endpoint: "analysis_report",
    path,
    timeoutMs,
    body: payload,
  });
  return {
    data: response.data,
    backend_used: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceSynthesizeReport(
  ctx: InferenceCallContext,
  payload: SynthesizeRequestPayload
): Promise<{
  data: Record<string, unknown>;
  backend_used: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  const path = ctx.env.INFERENCE_SYNTHESIZE_PATH ?? "/analysis/synthesize";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "45000");
  const response = await callInferenceWithFailover<Record<string, unknown>>(ctx, {
    endpoint: "analysis_synthesize",
    path,
    timeoutMs,
    body: payload,
  });
  return {
    data: response.data,
    backend_used: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceCheckpoint(
  ctx: InferenceCallContext,
  payload: CheckpointRequestPayload
): Promise<{
  data: CheckpointResult;
  backend_used: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  const path = ctx.env.INFERENCE_CHECKPOINT_PATH ?? "/analysis/checkpoint";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "30000");
  const response = await callInferenceWithFailover<CheckpointResult>(ctx, {
    endpoint: "analysis_checkpoint",
    path,
    timeoutMs,
    body: payload,
  });
  return {
    data: response.data,
    backend_used: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceMergeCheckpoints(
  ctx: InferenceCallContext,
  payload: MergeCheckpointsRequestPayload
): Promise<{
  data: Record<string, unknown>;
  backend_used: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  const path = ctx.env.INFERENCE_MERGE_CHECKPOINTS_PATH ?? "/analysis/merge-checkpoints";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "45000");
  const response = await callInferenceWithFailover<Record<string, unknown>>(ctx, {
    endpoint: "analysis_merge_checkpoints",
    path,
    timeoutMs,
    body: payload,
  });
  return {
    data: response.data,
    backend_used: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceRegenerateClaim(
  ctx: InferenceCallContext,
  payload: InferenceRegenerateClaimRequest
): Promise<{
  data: InferenceRegenerateClaimResponse;
  backend_used: "primary" | "secondary";
  degraded: boolean;
  warnings: string[];
  timeline: InferenceBackendTimelineItem[];
}> {
  const path = ctx.env.INFERENCE_REGENERATE_CLAIM_PATH ?? "/analysis/regenerate-claim";
  const timeoutMs = parseTimeoutMs(ctx.env.INFERENCE_TIMEOUT_MS ?? "15000");
  const response = await callInferenceWithFailover<InferenceRegenerateClaimResponse>(ctx, {
    endpoint: "analysis_regenerate_claim",
    path,
    timeoutMs,
    body: payload,
  });
  return {
    data: response.data,
    backend_used: response.backend,
    degraded: response.degraded,
    warnings: response.warnings,
    timeline: response.timeline,
  };
}

export async function invokeInferenceExtractEmbedding(
  ctx: InferenceCallContext,
  sessionId: string,
  audio: AudioPayload
): Promise<{ embedding: number[] }> {
  const response = await callInferenceWithFailover<{ embedding: number[] }>(ctx, {
    endpoint: "sv_extract_embedding",
    path: ctx.env.INFERENCE_EXTRACT_EMBEDDING_PATH ?? "/sv/extract_embedding",
    body: { session_id: sessionId, audio },
    timeoutMs: 10_000,
  });
  return response.data;
}

// ── Log helper for inference calls ────────────────────────────────────────

export function logInferenceError(component: string, error: unknown, extra?: Record<string, unknown>): void {
  log("error", `${component}: inference call failed`, {
    component,
    error: getErrorMessage(error),
    ...extra,
  });
}
