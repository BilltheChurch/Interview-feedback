/**
 * tier2-processor.ts — Tier 2 background batch processing for MeetingSessionDO.
 *
 * Tier 2 runs after Tier 1 finalization: gathers all PCM audio from R2,
 * sends to /batch/process for full diarization, re-generates the LLM report
 * with the improved transcript, and overwrites the R2 result.
 *
 * Pattern: standalone async function with explicit context object rather than `this`.
 */

import {
  addStageMetadata,
  attachEvidenceToMemos,
  backfillSupportingUtterances,
  buildEvidence,
  buildMultiEvidence,
  buildSynthesizePayload,
  collectEnrichedContext,
  computeSpeakerStats,
  enrichEvidencePack,
  extractMemoNames,
  generateStatsObservations,
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { concatUint8Arrays, pcm16ToWavBytes, bytesToBase64, TARGET_SAMPLE_RATE, TARGET_CHANNELS } from "./audio-utils";
import { persistSessionToD1 } from "./d1-helpers";
import type {
  Tier2Status,
  ResultV2,
  MemoItem,
  SpeakerStatItem,
  PersonFeedbackItem,
  ReportQualityMeta,
  OverallFeedback,
  DimensionPresetItem,
} from "./types_v2";
import type { InferenceBackendTimelineItem } from "./inference_client";
import type { Env, FeedbackCache } from "./config";
import {
  calcTranscriptDurationMs,
  getSessionLocale,
  normalizeSessionState,
  parseBool,
  log,
  getErrorMessage,
  STORAGE_KEY_STATE,
  STORAGE_KEY_RESULT_KEY_V2,
} from "./config";

// ── Tier 2 helpers ─────────────────────────────────────────────────────────

export function tier2Enabled(env: Env): boolean {
  return parseBool(env.TIER2_ENABLED, false);
}

export function tier2AutoTrigger(env: Env): boolean {
  return parseBool(env.TIER2_AUTO_TRIGGER, false);
}

export function tier2BatchEndpoint(env: Env): string {
  return (env.TIER2_BATCH_ENDPOINT ?? "").trim() || `${env.INFERENCE_BASE_URL}/batch/process`;
}

export function isTier2Terminal(status: Tier2Status["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "idle";
}

// ── Context interface ───────────────────────────────────────────────────────

export interface Tier2Context {
  /** DO storage for reading session state and result keys */
  storage: DurableObjectStorage;
  /** Worker env for accessing R2 bucket, API keys, config vars */
  env: Env;
  /** Callbacks to update Tier2Status in DO storage */
  updateTier2Status: (patch: Partial<Tier2Status>) => Promise<Tier2Status>;
  /** Load memos from DO storage */
  loadMemos: () => Promise<MemoItem[]>;
  /** Load feedback cache from DO storage */
  loadFeedbackCache: (sessionId: string) => Promise<FeedbackCache>;
  /** Store feedback cache to DO storage */
  storeFeedbackCache: (cache: FeedbackCache) => Promise<void>;
  /** Build evidence index from per-person feedback items */
  buildEvidenceIndex: (perPerson: PersonFeedbackItem[]) => Record<string, string[]>;
  /** Merge stats with roster from session state */
  mergeStatsWithRoster: (stats: SpeakerStatItem[], state: ReturnType<typeof normalizeSessionState>) => SpeakerStatItem[];
  /** Sanitize claim evidence refs */
  sanitizeClaimEvidenceRefs: (
    perPerson: PersonFeedbackItem[],
    evidence: ResultV2["evidence"]
  ) => { sanitized: PersonFeedbackItem[]; strippedCount: number };
  /** Validate claim evidence refs */
  validateClaimEvidenceRefs: (
    report: ResultV2
  ) => { valid: boolean; claimCount: number; invalidCount: number; needsEvidenceCount: number; failures: string[] };
  /** Call inference synthesize endpoint */
  invokeInferenceSynthesizeReport: (payload: unknown) => Promise<{
    data: Record<string, unknown>;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }>;
  /** Current ISO timestamp */
  currentIsoTs: () => string;
}

// ── Main Tier 2 job ────────────────────────────────────────────────────────

/**
 * Run the Tier 2 batch processing job for a session.
 *
 * Stages:
 * 1. Collect all PCM audio chunks from R2
 * 2. POST to /batch/process for full Whisper + Pyannote diarization
 * 3. Re-reconcile with manual bindings from Tier 1
 * 4. Re-run LLM synthesis with improved transcript
 * 5. Persist Tier 2 result back to R2 and update feedback cache
 */
export async function runTier2Job(sessionId: string, ctx: Tier2Context): Promise<void> {
  const { env, storage, updateTier2Status, currentIsoTs } = ctx;

  await updateTier2Status({
    status: "downloading",
    started_at: currentIsoTs(),
    progress: 5
  });

  try {
    // ── Stage 1: Collect audio chunks ────────────────────────────────
    const resultKey = await storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (!resultKey) {
      throw new Error("no result key found — tier1 may not have completed");
    }
    const sessionPrefix = resultKey.replace(/\/result_v2\.json$/, "");
    const chunksPrefix = `${sessionPrefix}/chunks/`;

    const chunkKeys: string[] = [];
    let cursor: string | undefined;
    do {
      const listing = await env.RESULT_BUCKET.list({
        prefix: chunksPrefix,
        cursor,
        limit: 500
      });
      for (const obj of listing.objects) {
        chunkKeys.push(obj.key);
      }
      cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
    } while (cursor);

    if (chunkKeys.length === 0) {
      throw new Error("no audio chunks found in R2 for tier2 processing");
    }

    chunkKeys.sort();
    await updateTier2Status({ progress: 15 });

    // ── Stage 2: Concatenate PCM and send to batch processor ─────────
    const pcmParts: Uint8Array[] = [];
    for (const key of chunkKeys) {
      const obj = await env.RESULT_BUCKET.get(key);
      if (obj) {
        pcmParts.push(new Uint8Array(await obj.arrayBuffer()));
      }
    }
    const fullPcm = concatUint8Arrays(pcmParts);
    const wavBytes = pcm16ToWavBytes(fullPcm, TARGET_SAMPLE_RATE, TARGET_CHANNELS);

    await updateTier2Status({
      status: "transcribing",
      progress: 25
    });

    const endpoint = tier2BatchEndpoint(env);
    const state = normalizeSessionState(
      await storage.get(STORAGE_KEY_STATE)
    );
    const numSpeakers = (state.roster ?? []).length || undefined;
    const audioB64 = bytesToBase64(wavBytes);

    const batchResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.INFERENCE_API_KEY ? { "x-api-key": env.INFERENCE_API_KEY } : {})
      },
      body: JSON.stringify({
        audio_url: `data:audio/wav;base64,${audioB64}`,
        num_speakers: numSpeakers,
        language: getSessionLocale(state, env)
      }),
      signal: AbortSignal.timeout(180_000)
    });

    await updateTier2Status({
      status: "diarizing",
      progress: 50
    });

    if (!batchResponse.ok) {
      const errText = await batchResponse.text().catch(() => "unknown");
      throw new Error(`batch/process returned ${batchResponse.status}: ${errText}`);
    }

    const batchResult = (await batchResponse.json()) as {
      transcript?: Array<{
        utterance_id?: string;
        speaker?: string;
        text?: string;
        start_ms?: number;
        end_ms?: number;
      }>;
      speaker_stats?: Record<string, unknown>;
      diarization?: Record<string, unknown>;
    };

    await updateTier2Status({
      status: "reconciling",
      progress: 65
    });

    // ── Stage 3: Re-reconcile with Tier 1 result ─────────────────────
    const existingResult = await env.RESULT_BUCKET.get(resultKey);
    if (!existingResult) {
      throw new Error("could not load tier1 result for re-reconciliation");
    }
    const tier1Result = (await existingResult.json()) as ResultV2;

    const batchTranscript = (batchResult.transcript ?? []).map((item, idx) => ({
      utterance_id: item.utterance_id ?? `tier2_utt_${idx}`,
      stream_role: "students" as const,
      cluster_id: null,
      speaker_name: item.speaker ?? null,
      decision: "auto" as const,
      text: item.text ?? "",
      start_ms: item.start_ms ?? 0,
      end_ms: item.end_ms ?? 0,
      duration_ms: (item.end_ms ?? 0) - (item.start_ms ?? 0)
    }));

    const finalTranscript = batchTranscript.length > 0
      ? batchTranscript
      : tier1Result.transcript;

    await updateTier2Status({
      status: "reporting",
      progress: 75
    });

    // ── Stage 4: Re-generate stats and LLM report ─────────────────────
    const tier2Stats = computeSpeakerStats(finalTranscript as TranscriptItem[]);
    const mergedStats = ctx.mergeStatsWithRoster(tier2Stats, state);

    const tier2Warnings: string[] = [];
    const memos = await ctx.loadMemos();
    const enrichedMemos = addStageMetadata(memos, (state.config as Record<string, unknown>)?.stages as string[] ?? []);
    const knownSpeakers = mergedStats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
    const memoBindings = extractMemoNames(enrichedMemos, knownSpeakers);
    let evidence = buildMultiEvidence({
      memos: enrichedMemos,
      transcript: finalTranscript as TranscriptItem[],
      bindings: memoBindings
    });

    const tier2EnrichedEvidence = enrichEvidencePack(finalTranscript as TranscriptItem[], mergedStats);
    evidence = [...evidence, ...tier2EnrichedEvidence];

    const tier2AudioDurationMs = calcTranscriptDurationMs(finalTranscript);
    const tier2StatsObservations = generateStatsObservations(mergedStats, tier2AudioDurationMs);

    const locale = getSessionLocale(state, env);
    const fullConfig = (state.config ?? {}) as Record<string, unknown>;
    const configStages: string[] = fullConfig.stages as string[] ?? [];
    const { rubric, sessionContext, freeFormNotes, stages: contextStages } = collectEnrichedContext({
      sessionConfig: {
        mode: fullConfig.mode as "1v1" | "group" | undefined,
        interviewer_name: fullConfig.interviewer_name as string | undefined,
        position_title: fullConfig.position_title as string | undefined,
        company_name: fullConfig.company_name as string | undefined,
        stages: configStages,
        free_form_notes: fullConfig.free_form_notes as string | undefined,
        rubric: fullConfig.rubric as Parameters<typeof collectEnrichedContext>[0]["sessionConfig"]["rubric"],
      },
    });

    if (sessionContext) {
      const it = fullConfig.interview_type;
      if (typeof it === "string" && it) sessionContext.interview_type = it;
      const dp = fullConfig.dimension_presets;
      if (Array.isArray(dp)) sessionContext.dimension_presets = dp as DimensionPresetItem[];
    }

    const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
    const synthPayload = buildSynthesizePayload({
      sessionId,
      transcript: finalTranscript as TranscriptItem[],
      memos: enrichedMemos,
      evidence,
      stats: mergedStats,
      events: [],
      bindings: memoBindings,
      rubric,
      sessionContext,
      freeFormNotes,
      historical: [],
      stages: contextStages.length > 0 ? contextStages : configStages,
      locale,
      nameAliases: configNameAliases,
      statsObservations: tier2StatsObservations,
    });

    const synthResult = await ctx.invokeInferenceSynthesizeReport(synthPayload as unknown);
    if (synthResult.warnings.length > 0) {
      tier2Warnings.push(...synthResult.warnings);
    }

    let finalPerPerson = tier1Result.per_person;
    let finalOverall = tier1Result.overall;
    let reportSource: ReportQualityMeta["report_source"] = "llm_synthesized";
    let reportModel: string | null = null;

    const synthData = synthResult.data;
    const candidatePerPerson = Array.isArray(synthData?.per_person)
      ? (synthData.per_person as PersonFeedbackItem[])
      : [];

    if (candidatePerPerson.length > 0) {
      const { sanitized, strippedCount } = ctx.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
      if (strippedCount > 0) {
        tier2Warnings.push(`tier2 sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
      }
      const validation = ctx.validateClaimEvidenceRefs({
        evidence,
        per_person: sanitized
      } as ResultV2);
      if (validation.valid) {
        finalPerPerson = sanitized;
        finalOverall = (synthData?.overall ?? tier1Result.overall) as OverallFeedback;
        const candidateQuality = synthData?.quality && typeof synthData.quality === "object"
          ? (synthData.quality as Partial<ReportQualityMeta>)
          : null;
        reportSource = (candidateQuality?.report_source as typeof reportSource) ?? "llm_synthesized";
        reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
        evidence = backfillSupportingUtterances(evidence, finalPerPerson);
      } else {
        tier2Warnings.push("tier2 LLM report had invalid evidence refs, keeping tier1 report content");
        reportSource = tier1Result.quality.report_source ?? "memo_first";
      }
    } else {
      tier2Warnings.push("tier2 LLM returned empty per_person, keeping tier1 report");
      reportSource = tier1Result.quality.report_source ?? "memo_first";
    }

    await updateTier2Status({
      status: "persisting",
      progress: 90
    });

    // ── Stage 5: Persist Tier 2 result ───────────────────────────────
    const tier2FinalizedAt = currentIsoTs();
    const tier2Quality: ReportQualityMeta = {
      ...tier1Result.quality,
      generated_at: tier2FinalizedAt,
      report_source: reportSource,
      report_model: reportModel,
      report_degraded: false
    };
    const tier2ResultV2: ResultV2 = {
      ...tier1Result,
      transcript: finalTranscript,
      stats: mergedStats,
      evidence,
      overall: finalOverall,
      per_person: finalPerPerson,
      quality: tier2Quality,
      session: {
        ...tier1Result.session,
        finalized_at: tier2FinalizedAt
      },
      trace: {
        ...tier1Result.trace,
        generated_at: tier2FinalizedAt,
        report_pipeline: {
          mode: "llm_core_synthesis",
          source: reportSource as "llm_synthesized",
          llm_attempted: true,
          llm_success: candidatePerPerson.length > 0,
          llm_elapsed_ms: null,
          blocking_reason: null
        }
      }
    };

    await env.RESULT_BUCKET.put(resultKey, JSON.stringify(tier2ResultV2), {
      httpMetadata: { contentType: "application/json" }
    });

    // D1: update session metadata with Tier 2 refined results
    if (env.DB) {
      persistSessionToD1(env.DB, sessionId, tier2ResultV2, resultKey).catch(err => {
        log("warn", "tier2: D1 persist failed (non-blocking)", {
          component: "tier2",
          session_id: sessionId,
          error: getErrorMessage(err)
        });
      });
    }

    // Update feedback cache
    const cache = await ctx.loadFeedbackCache(sessionId);
    cache.updated_at = tier2FinalizedAt;
    cache.report = tier2ResultV2;
    cache.person_summary_cache = tier2ResultV2.per_person;
    cache.overall_summary_cache = tier2ResultV2.overall;
    cache.evidence_index_cache = ctx.buildEvidenceIndex(tier2ResultV2.per_person);
    cache.quality = tier2ResultV2.quality;
    cache.report_source = reportSource ?? "llm_synthesized";
    cache.ready = true;
    await ctx.storeFeedbackCache(cache);

    await updateTier2Status({
      status: "succeeded",
      completed_at: tier2FinalizedAt,
      report_version: "tier2_refined",
      progress: 100,
      warnings: tier2Warnings
    });

    log("info", "tier2: completed", { component: "tier2", session_id: sessionId });
  } catch (err) {
    const message = getErrorMessage(err);
    log("error", "tier2: failed", { component: "tier2", session_id: sessionId, error: message });
    await updateTier2Status({
      status: "failed",
      completed_at: currentIsoTs(),
      error: message,
      progress: 100
    });
  }
}
