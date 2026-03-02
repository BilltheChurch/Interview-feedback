/**
 * V1 Incremental Pipeline helpers for Worker → Inference communication.
 *
 * Changes from V0:
 * - Uses audio_start_ms/audio_end_ms (not start_ms/end_ms) — P0 fix
 * - Finalize uses r2_audio_refs (not audio_b64) — B+ design
 * - Queue backpressure with MAX_QUEUE_CHUNKS
 * - Schema version: v=1
 */

export const SCHEMA_VERSION = 1;
export const MAX_QUEUE_CHUNKS = 500;

// ── Types ────────────────────────────────────────────────────────

export interface StartFrameV1 {
  v: 1;
  type: 'start';
  session_id: string;
  increment_id: string;
  increment_index: number;
  audio_start_ms: number;
  audio_end_ms: number;
  language: string;
  run_analysis: boolean;
  total_frames: number;
  sample_rate: number;
  channels: number;
  bit_depth: number;
}

export interface R2AudioRefV1 {
  key: string;
  start_ms: number;
  end_ms: number;
}

export interface FinalizePayloadV1 {
  v: 1;
  session_id: string;
  r2_audio_refs: R2AudioRefV1[];
  total_audio_ms: number;
  locale: string;
  memos: unknown[];
  stats: unknown[];
  evidence: unknown[];
  name_aliases: Record<string, string[]>;
}

export interface DropDecision {
  drop: boolean;
  reason: string;
}

// ── Builders ─────────────────────────────────────────────────────

export function buildStartFrameV1(opts: {
  sessionId: string;
  incrementId: string;
  incrementIndex: number;
  audioStartMs: number;
  audioEndMs: number;
  language: string;
  runAnalysis: boolean;
  totalFrames: number;
}): StartFrameV1 {
  return {
    v: SCHEMA_VERSION as 1,
    type: 'start',
    session_id: opts.sessionId,
    increment_id: opts.incrementId,
    increment_index: opts.incrementIndex,
    audio_start_ms: opts.audioStartMs,
    audio_end_ms: opts.audioEndMs,
    language: opts.language,
    run_analysis: opts.runAnalysis,
    total_frames: opts.totalFrames,
    sample_rate: 16000,
    channels: 1,
    bit_depth: 16,
  };
}

export function buildFinalizePayloadV1(opts: {
  sessionId: string;
  r2AudioRefs: Array<{ key: string; startMs: number; endMs: number }>;
  totalAudioMs: number;
  locale: string;
  memos?: unknown[];
  stats?: unknown[];
  evidence?: unknown[];
  nameAliases?: Record<string, string[]>;
}): FinalizePayloadV1 {
  return {
    v: SCHEMA_VERSION as 1,
    session_id: opts.sessionId,
    r2_audio_refs: opts.r2AudioRefs.map((r) => ({
      key: r.key,
      start_ms: r.startMs,
      end_ms: r.endMs,
    })),
    total_audio_ms: opts.totalAudioMs,
    locale: opts.locale,
    memos: opts.memos ?? [],
    stats: opts.stats ?? [],
    evidence: opts.evidence ?? [],
    name_aliases: opts.nameAliases ?? {},
  };
}

// ── Queue Backpressure ───────────────────────────────────────────

export function shouldDropChunk(
  currentQueueSize: number,
  maxSize: number = MAX_QUEUE_CHUNKS,
): DropDecision {
  if (currentQueueSize > maxSize) {
    return {
      drop: true,
      reason: `Queue backpressure: ${currentQueueSize} > ${maxSize} max chunks`,
    };
  }
  return { drop: false, reason: '' };
}
