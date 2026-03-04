/**
 * incremental-processor.ts — Incremental (during-recording) processing jobs.
 *
 * Handles the V1 incremental pipeline:
 * - runIncrementalJob: processes a PCM window during recording, posts to /v1/incremental/process-chunk
 * - runIncrementalFinalize: post-recording finalization, posts to /v1/incremental/finalize
 *
 * Pattern: standalone async functions with explicit context rather than `this`.
 */

import { concatUint8Arrays, pcm16ToWavBytes, bytesToBase64, TARGET_SAMPLE_RATE, TARGET_CHANNELS } from "./audio-utils";
import { chunkObjectKey } from "./config";
import { log, getErrorMessage, normalizeSessionState, getSessionLocale, STORAGE_KEY_STATE, STORAGE_KEY_INCREMENTAL_UTTERANCES, STORAGE_KEY_INCREMENTAL_SPEAKER_PROFILES, STORAGE_KEY_INCREMENTAL_CHECKPOINT, MAX_STORED_UTTERANCES } from "./config";
import type { Env } from "./config";
import { incrementalV1Enabled } from "./config";
import {
  shouldScheduleIncremental,
  parseProcessChunkResponse,
  incrementalAnalysisInterval,
} from "./incremental";
import { buildFinalizePayloadV1 } from "./incremental_v1";
import type { RecomputeSegment } from "./incremental_v1";
import type {
  IncrementalStatus,
  MemoItem,
  SpeakerStatItem,
  StoredUtterance,
  EvidenceItem,
} from "./types_v2";
import type { IngestState, StreamRole } from "./config";

// ── Context interface ──────────────────────────────────────────────────────

export interface IncrementalContext {
  storage: DurableObjectStorage;
  env: Env;
  loadIncrementalStatus: () => Promise<IncrementalStatus>;
  updateIncrementalStatus: (patch: Partial<IncrementalStatus>) => Promise<IncrementalStatus>;
  loadIngestByStream: (sessionId: string) => Promise<Record<StreamRole, IngestState>>;
  currentIsoTs: () => string;
}

// ── runIncrementalJob ──────────────────────────────────────────────────────

/**
 * Main incremental processing job — runs in the alarm handler.
 * Gathers a PCM window from R2, POSTs to /v1/incremental/process-chunk, stores results.
 * Non-fatal: logs warning and increments failed count on any error.
 */
export async function runIncrementalJob(sessionId: string, ctx: IncrementalContext): Promise<void> {
  const { env, storage, loadIncrementalStatus, updateIncrementalStatus, loadIngestByStream, currentIsoTs } = ctx;
  const status = await loadIncrementalStatus();
  if (!incrementalV1Enabled(env)) return;

  const ingestByStream = await loadIngestByStream(sessionId);
  const totalAudioMs = ingestByStream.mixed.received_chunks * 1000;

  const decision = shouldScheduleIncremental(env, status, totalAudioMs);
  if (!decision.schedule) {
    if (status.status === "idle") {
      await updateIncrementalStatus({ status: "recording", enabled: true });
    }
    return;
  }

  await updateIncrementalStatus({
    status: "processing",
    enabled: true,
    started_at: status.started_at ?? currentIsoTs()
  });

  try {
    const chunksPrefix = `chunks/${sessionId}/`;

    const allChunkKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await env.RESULT_BUCKET.list({
        prefix: chunksPrefix,
        cursor,
        limit: 500
      });
      for (const obj of listing.objects) {
        if (!obj.key.slice(chunksPrefix.length).includes("/")) {
          allChunkKeys.push(obj.key);
        }
      }
      cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
    } while (cursor);

    allChunkKeys.sort();

    const startSeq = Math.floor(decision.startMs / 1000);
    const endSeq = Math.ceil(decision.endMs / 1000);

    const rangeKeys = allChunkKeys.filter((key) => {
      const seqStr = key.split("/").pop()?.replace(".pcm", "") ?? "0";
      const seq = parseInt(seqStr, 10);
      return seq >= startSeq && seq < endSeq;
    });

    if (rangeKeys.length === 0) {
      log("warn", "incremental: no chunks found for range", { sessionId, action: "incremental", startMs: decision.startMs, endMs: decision.endMs });
      await updateIncrementalStatus({
        status: "recording",
        increments_failed: status.increments_failed + 1,
        warnings: [...status.warnings, `no chunks for range [${decision.startMs},${decision.endMs})`]
      });
      return;
    }

    const pcmParts: Uint8Array[] = [];
    for (const key of rangeKeys) {
      const obj = await env.RESULT_BUCKET.get(key);
      if (obj) {
        pcmParts.push(new Uint8Array(await obj.arrayBuffer()));
      }
    }

    const fullPcm = concatUint8Arrays(pcmParts);
    const wavBytes = pcm16ToWavBytes(fullPcm, TARGET_SAMPLE_RATE, TARGET_CHANNELS);
    const audioB64 = bytesToBase64(wavBytes);

    const state = normalizeSessionState(await storage.get(STORAGE_KEY_STATE));
    const locale = getSessionLocale(state, env);

    const inferenceBase = (
      (env.INFERENCE_BASE_URL ?? env.INFERENCE_BASE_URL_PRIMARY ?? "")
    ).trim() || "http://127.0.0.1:8000";
    const apiKey = ((env as unknown as Record<string, string | undefined>).INFERENCE_API_KEY ?? "").trim();

    const incrementId = crypto.randomUUID();
    const analysisInterval = incrementalAnalysisInterval(env);
    const runAnalysis = analysisInterval > 0 && decision.incrementIndex % analysisInterval === 0;

    const v1Payload = {
      v: 1 as const,
      session_id: sessionId,
      increment_id: incrementId,
      increment_index: decision.incrementIndex,
      audio_b64: audioB64,
      audio_start_ms: decision.startMs,
      audio_end_ms: decision.endMs,
      locale,
      run_analysis: runAnalysis,
      total_frames: rangeKeys.length,
    };

    const resp = await fetch(`${inferenceBase}/v1/incremental/process-chunk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {})
      },
      body: JSON.stringify(v1Payload),
      signal: AbortSignal.timeout(240_000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`/incremental/process-chunk returned ${resp.status}: ${errText.slice(0, 200)}`);
    }

    const json = await resp.json() as Record<string, unknown>;
    const parsed = parseProcessChunkResponse(json);

    await storage.put(STORAGE_KEY_INCREMENTAL_SPEAKER_PROFILES, parsed.speakerProfiles);
    if (parsed.checkpoint) {
      await storage.put(STORAGE_KEY_INCREMENTAL_CHECKPOINT, parsed.checkpoint);
    }

    const existingUtts = await storage.get<StoredUtterance[]>(STORAGE_KEY_INCREMENTAL_UTTERANCES) ?? [];

    const newUtts: StoredUtterance[] = parsed.utterances.map(u => ({
      utterance_id: u.utterance_id,
      increment_index: u.increment_index,
      text: u.text,
      start_ms: u.start_ms,
      end_ms: u.end_ms,
      confidence: u.confidence ?? 1.0,
      speaker: u.cluster_id ?? u.speaker_name ?? "unknown",
      stream_role: u.stream_role ?? "mixed",
    }));

    const dedupKey = (u: StoredUtterance) => `${u.increment_index}:${u.utterance_id}`;
    const seen = new Set(existingUtts.map(dedupKey));
    const merged = [...existingUtts];
    for (const u of newUtts) {
      if (!seen.has(dedupKey(u))) {
        merged.push(u);
        seen.add(dedupKey(u));
      }
    }
    const trimmed = merged.length > MAX_STORED_UTTERANCES
      ? merged.slice(-MAX_STORED_UTTERANCES)
      : merged;

    await storage.put(STORAGE_KEY_INCREMENTAL_UTTERANCES, trimmed);

    await updateIncrementalStatus({
      status: "recording",
      increments_completed: status.increments_completed + 1,
      last_processed_ms: decision.endMs,
      speakers_detected: parsed.speakersDetected,
      stable_speaker_map: parsed.stableSpeakerMap,
      last_increment_at: currentIsoTs(),
      error: null
    });

    log("info", "incremental: increment completed", {
      sessionId, action: "incremental",
      incrementIndex: decision.incrementIndex,
      speakersDetected: parsed.speakersDetected,
      utteranceCount: parsed.utterances.length
    });
  } catch (err) {
    const message = getErrorMessage(err);
    log("warn", "incremental: increment failed (non-fatal)", {
      sessionId, action: "incremental",
      incrementIndex: decision.incrementIndex,
      error: message
    });
    await updateIncrementalStatus({
      status: "recording",
      increments_failed: status.increments_failed + 1,
      warnings: [...status.warnings, `increment ${decision.incrementIndex} failed: ${message}`],
      error: message
    });
  }
}

// ── runIncrementalFinalize ─────────────────────────────────────────────────

export interface IncrementalFinalizeContext {
  storage: DurableObjectStorage;
  env: Env;
  loadIncrementalStatus: () => Promise<IncrementalStatus>;
  updateIncrementalStatus: (patch: Partial<IncrementalStatus>) => Promise<IncrementalStatus>;
  currentIsoTs: () => string;
}

/**
 * Call the /incremental/finalize endpoint after recording ends.
 * Returns true if finalization succeeded (caller can skip Tier 2).
 * Returns false on failure (caller should fall back to Tier 2).
 */
export async function runIncrementalFinalize(
  sessionId: string,
  memos: MemoItem[],
  stats: SpeakerStatItem[],
  evidence: Array<EvidenceItem>,
  locale: string,
  nameAliases: Record<string, string[]>,
  ctx: IncrementalFinalizeContext
): Promise<boolean> {
  const { env, storage, loadIncrementalStatus, updateIncrementalStatus, currentIsoTs } = ctx;
  try {
    const incrementalStatus = await loadIncrementalStatus();
    if (!incrementalV1Enabled(env) || incrementalStatus.increments_completed === 0) {
      return false;
    }

    await updateIncrementalStatus({ status: "finalizing" });

    const chunksPrefix = `chunks/${sessionId}/`;
    const allChunkKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await env.RESULT_BUCKET.list({
        prefix: chunksPrefix,
        cursor,
        limit: 500
      });
      for (const obj of listing.objects) {
        if (!obj.key.slice(chunksPrefix.length).includes("/")) {
          allChunkKeys.push(obj.key);
        }
      }
      cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
    } while (cursor);

    allChunkKeys.sort();

    if (allChunkKeys.length === 0) {
      log("warn", "incremental: finalize found no audio chunks", { sessionId, action: "incremental_finalize" });
      await updateIncrementalStatus({ status: "failed", error: "no audio chunks" });
      return false;
    }

    const inferenceBase = (
      (env.INFERENCE_BASE_URL ?? env.INFERENCE_BASE_URL_PRIMARY ?? "")
    ).trim() || "http://127.0.0.1:8000";
    const apiKey = ((env as unknown as Record<string, string | undefined>).INFERENCE_API_KEY ?? "").trim();

    const r2AudioRefs: Array<{ key: string; startMs: number; endMs: number }> = allChunkKeys.map((key) => {
      const seqStr = key.split("/").pop()?.replace(".pcm", "") ?? "0";
      const seq = parseInt(seqStr, 10);
      return {
        key,
        startMs: seq * 1000,
        endMs: (seq + 1) * 1000,
      };
    });

    const totalAudioMs = allChunkKeys.length * 1000;

    const RECOMPUTE_CONFIDENCE_THRESHOLD = 0.7;
    const RECOMPUTE_MAX_SEGMENTS = 10;
    const RECOMPUTE_MIN_DURATION_MS = 500;
    const RECOMPUTE_MAX_DURATION_MS = 30_000;
    const RECOMPUTE_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
    const BASE64_OVERHEAD = 4 / 3;
    const JSON_FIELD_OVERHEAD = 200;

    const storedUtterances = await storage.get<StoredUtterance[]>(STORAGE_KEY_INCREMENTAL_UTTERANCES) ?? [];

    const lowConfUtterances = storedUtterances
      .filter(u =>
        u.confidence < RECOMPUTE_CONFIDENCE_THRESHOLD &&
        (u.end_ms - u.start_ms) >= RECOMPUTE_MIN_DURATION_MS &&
        (u.end_ms - u.start_ms) <= RECOMPUTE_MAX_DURATION_MS
      )
      .sort((a, b) => a.confidence - b.confidence)
      .slice(0, RECOMPUTE_MAX_SEGMENTS);

    const recomputeSegments: RecomputeSegment[] = [];
    let estimatedPayloadBytes = 0;

    for (const utt of lowConfUtterances) {
      if (estimatedPayloadBytes >= RECOMPUTE_MAX_PAYLOAD_BYTES) break;

      const startSeq = Math.floor(utt.start_ms / 1000);
      const endSeq = Math.ceil(utt.end_ms / 1000);

      const pcmChunks: Uint8Array[] = [];
      let fetchFailed = false;
      for (let seq = startSeq; seq < endSeq; seq++) {
        const key = chunkObjectKey(sessionId, utt.stream_role as StreamRole, seq);
        const obj = await env.RESULT_BUCKET.get(key);
        if (!obj) { fetchFailed = true; break; }
        pcmChunks.push(new Uint8Array(await obj.arrayBuffer()));
      }

      if (fetchFailed || pcmChunks.length === 0) continue;

      const totalPcm = concatUint8Arrays(pcmChunks);
      const segPayload = Math.ceil(totalPcm.byteLength * BASE64_OVERHEAD) + JSON_FIELD_OVERHEAD;
      if (estimatedPayloadBytes + segPayload > RECOMPUTE_MAX_PAYLOAD_BYTES) continue;

      const wavBytes = pcm16ToWavBytes(totalPcm);
      const audioB64 = bytesToBase64(wavBytes);

      recomputeSegments.push({
        utterance_id: utt.utterance_id,
        increment_index: utt.increment_index,
        start_ms: utt.start_ms,
        end_ms: utt.end_ms,
        original_confidence: utt.confidence,
        stream_role: utt.stream_role,
        audio_b64: audioB64,
        audio_format: "wav",
      });

      estimatedPayloadBytes += segPayload;
    }

    const v1Payload = buildFinalizePayloadV1({
      sessionId,
      r2AudioRefs,
      totalAudioMs,
      locale,
      memos,
      stats,
      evidence,
      nameAliases,
      recomputeSegments,
    });

    const resp = await fetch(`${inferenceBase}/v1/incremental/finalize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {})
      },
      body: JSON.stringify(v1Payload),
      signal: AbortSignal.timeout(300_000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "unknown");
      throw new Error(`/incremental/finalize returned ${resp.status}: ${errText.slice(0, 200)}`);
    }

    await storage.delete(STORAGE_KEY_INCREMENTAL_UTTERANCES);

    await updateIncrementalStatus({
      status: "succeeded",
      last_increment_at: currentIsoTs(),
      error: null
    });

    log("info", "incremental: finalize succeeded", { component: "incremental", session_id: sessionId });
    return true;
  } catch (err) {
    const message = getErrorMessage(err);
    log("warn", "incremental: finalize failed (non-fatal)", { component: "incremental", session_id: sessionId, error: message });
    await storage.delete(STORAGE_KEY_INCREMENTAL_UTTERANCES).catch(() => {});
    await updateIncrementalStatus({ status: "failed", error: message });
    return false;
  }
}
