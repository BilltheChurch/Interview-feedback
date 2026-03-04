/**
 * finalize-orchestrator.ts — Tier 1 finalization job for MeetingSessionDO.
 *
 * Extracted from index.ts to reduce file size. Contains the 9-stage finalization
 * pipeline: freeze → drain → replay → reconcile → stats → events → report → persist.
 *
 * Pattern: standalone async function with explicit FinalizeJobContext rather than `this`.
 */

import {
  attachEvidenceToMemos,
  buildEvidence,
  buildMemoFirstReport,
  buildMultiEvidence,
  buildResultV2,
  buildSynthesizePayload,
  collectEnrichedContext,
  computeSpeakerStats,
  computeUnknownRatio,
  enforceQualityGates,
  enrichEvidencePack,
  extractMemoNames,
  generateStatsObservations,
  addStageMetadata,
  memoAssistedBinding,
  backfillSupportingUtterances,
  validatePersonFeedbackEvidence
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { emptySpeakerLogs, mergeSpeakerLogs } from "./speaker_logs";
import type { InferenceBackendTimelineItem } from "./inference_client";
import { buildReconciledTranscript, resolveStudentBinding } from "./reconcile";
import { globalCluster, mapClustersToRoster } from "./global-cluster";
import type { CachedEmbedding, GlobalClusterResult, CaptionEvent } from "./providers/types";
import type { RosterParticipant } from "./global-cluster";
import { EmbeddingCache } from "./embedding-cache";
import { LocalWhisperASRProvider } from "./providers/asr-local-whisper";
import { ACSCaptionASRProvider } from "./providers/asr-acs-caption";
import { ACSCaptionDiarizationProvider } from "./providers/diarization-acs-caption";
import { persistSessionToD1 } from "./d1-helpers";
import type {
  CheckpointRequestPayload,
  CheckpointResult,
  FinalizeV2Status,
  FinalizeStageCheckpoint,
  MemoItem,
  MemoSpeakerBinding,
  MergeCheckpointsRequestPayload,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SpeakerStatItem,
  SpeakerLogs,
  SpeakerMapItem,
  SynthesizeRequestPayload,
  Tier2Status,
  CaptionSource,
  DimensionPresetItem,
  OverallFeedback,
  ImprovementReport,
  SessionContextMeta,
  SessionPhase,
} from "./types_v2";
import { incrementalV1Enabled } from "./config";
import type {
  StreamRole,
  AudioPayload,
  SessionState,
  IngestState,
  AsrState,
  UtteranceRaw,
  UtteranceMerged,
  SpeakerEvent,
  AsrReplayCursor,
  AsrRunResult,
  HistoryIndexItem,
  InferenceEnrollRequest,
  InferenceEnrollResponse,
  InferenceRegenerateClaimRequest,
  InferenceRegenerateClaimResponse,
  FeedbackCache,
  CaptureState,
} from "./config";
import type { Env } from "./config";
import type { DependencyHealthSnapshot } from "./inference_client";
import {
  log,
  getErrorMessage,
  getSessionLocale,
  normalizeSessionState,
  calcTranscriptDurationMs,
  parseBool,
  parseTimeoutMs,
  resultObjectKeyV2,
  historyObjectKey,
  chunkObjectKey,
  defaultCaptureByStream,
  INFERENCE_MAX_AUDIO_SECONDS,
  STORAGE_KEY_STATE,
  STORAGE_KEY_UPDATED_AT,
  STORAGE_KEY_FINALIZED_AT,
  STORAGE_KEY_RESULT_KEY_V2,
  STORAGE_KEY_CAPTION_SOURCE,
  STORAGE_KEY_CAPTION_BUFFER,
  STORAGE_KEY_TIER2_ALARM_TAG,
  identitySourceFromBindingSource,
  ACCEPTED_REPORT_SOURCES,
  FEEDBACK_TOTAL_BUDGET_MS,
  FEEDBACK_ASSEMBLE_BUDGET_MS,
  FEEDBACK_EVENTS_BUDGET_MS,
  FEEDBACK_REPORT_BUDGET_MS,
  FEEDBACK_VALIDATE_BUDGET_MS,
  mergeUtterances,
  DRAIN_TIMEOUT_CAP_MS,
} from "./config";
import { buildFinalizePayloadV1 } from "./incremental_v1";
import type { RecomputeSegment } from "./incremental_v1";

// ── Context sub-interfaces ────────────────────────────────────────────────

/** Core DO state and environment. */
export interface FinalizeCoreContext {
  doCtx: DurableObjectState;
  env: Env;
  currentIsoTs: () => string;
}

/** Mutable caption field accessors and audio-related objects. */
export interface FinalizeAudioContext {
  getCaptionSource: () => CaptionSource;
  setCaptionSource: (source: CaptionSource) => void;
  getCaptionBuffer: () => CaptionEvent[];
  setCaptionBuffer: (buffer: CaptionEvent[]) => void;
  embeddingCache: EmbeddingCache;
  localWhisperProvider: LocalWhisperASRProvider | null;
  maybeRunAsrWindows: (sessionId: string, streamRole: StreamRole, force?: boolean, maxWindows?: number) => Promise<AsrRunResult>;
  drainRealtimeQueue: (sessionId: string, streamRole: StreamRole) => Promise<void>;
  replayGapFromR2: (sessionId: string, streamRole: StreamRole) => Promise<void>;
  closeRealtimeAsrSession: (streamRole: StreamRole, reason: string, waitForDrain: boolean, scheduleAlarm: boolean) => Promise<void>;
  refreshAsrStreamMetrics: (sessionId: string, streamRole: StreamRole) => Promise<void>;
  extractEmbeddingsForTurns: (sessionId: string, speakerLogs: SpeakerLogs, streamRole?: "students" | "teacher") => Promise<{ extracted: number; skipped: number; failed: number }>;
  getAsrProvider: () => "funASR" | "local-whisper";
  checkpointIntervalMs: () => number;
}

/** DO storage helpers for session data. */
export interface FinalizeStorageContext {
  loadIngestByStream: (sessionId: string) => Promise<Record<StreamRole, IngestState>>;
  loadAsrByStream: () => Promise<Record<StreamRole, AsrState>>;
  storeAsrByStream: (state: Record<StreamRole, AsrState>) => Promise<void>;
  loadUtterancesRawByStream: () => Promise<Record<StreamRole, UtteranceRaw[]>>;
  storeUtterancesRawByStream: (state: Record<StreamRole, UtteranceRaw[]>) => Promise<void>;
  loadUtterancesMergedByStream: () => Promise<Record<StreamRole, UtteranceMerged[]>>;
  storeUtterancesMergedByStream: (state: Record<StreamRole, UtteranceMerged[]>) => Promise<void>;
  loadSpeakerEvents: () => Promise<SpeakerEvent[]>;
  loadSpeakerLogs: () => Promise<SpeakerLogs>;
  storeSpeakerLogs: (logs: SpeakerLogs) => Promise<void>;
  loadMemos: () => Promise<MemoItem[]>;
  storeMemos: (memos: MemoItem[]) => Promise<void>;
  loadFeedbackCache: (sessionId: string) => Promise<FeedbackCache>;
  storeFeedbackCache: (cache: FeedbackCache) => Promise<void>;
  loadFinalizeV2Status: () => Promise<FinalizeV2Status | null>;
  storeFinalizeV2Status: (status: FinalizeV2Status) => Promise<void>;
  loadFinalizeStageCheckpoint: () => Promise<FinalizeStageCheckpoint | null>;
  saveFinalizeStageCheckpoint: (jobId: string, completedStage: FinalizeV2Status["stage"], stageData: Record<string, unknown>) => Promise<void>;
  clearFinalizeStageCheckpoint: () => Promise<void>;
  loadCheckpoints: () => Promise<CheckpointResult[]>;
  storeCheckpoints: (checkpoints: CheckpointResult[]) => Promise<void>;
  loadLastCheckpointAt: () => Promise<number>;
  storeLastCheckpointAt: (ms: number) => Promise<void>;
  storeTier2Status: (status: Tier2Status) => Promise<void>;
  appendSpeakerEvent: (event: SpeakerEvent) => Promise<void>;
}

/** Finalization lifecycle control. */
export interface FinalizeLifecycleContext {
  updateFinalizeV2Status: (jobId: string, patch: Partial<FinalizeV2Status>) => Promise<FinalizeV2Status | null>;
  setFinalizeLock: (locked: boolean) => Promise<void>;
  ensureFinalizeJobActive: (jobId: string) => Promise<void>;
  isFinalizeTerminal: (status: FinalizeV2Status["status"]) => boolean;
  finalizeTimeoutMs: () => number;
  setSessionPhase: (target: SessionPhase) => Promise<SessionPhase>;
  tier2Enabled: () => boolean;
  tier2AutoTrigger: () => boolean;
}

/** Inference backend call wrappers. */
export interface FinalizeInferenceContext {
  invokeInferenceAnalysisEvents: (payload: Record<string, unknown>) => Promise<{ events: Record<string, unknown>[]; backend_used: string; degraded: boolean; warnings: string[]; timeline: InferenceBackendTimelineItem[]; fallback_reason: string | null }>;
  invokeInferenceAnalysisReport: (payload: Record<string, unknown>) => Promise<{ data: Record<string, unknown>; backend_used: string; degraded: boolean; warnings: string[]; timeline: InferenceBackendTimelineItem[] }>;
  invokeInferenceSynthesizeReport: (payload: SynthesizeRequestPayload) => Promise<{ data: Record<string, unknown>; backend_used: string; degraded: boolean; warnings: string[]; timeline: InferenceBackendTimelineItem[] }>;
  invokeInferenceCheckpoint: (payload: CheckpointRequestPayload) => Promise<{ data: CheckpointResult; backend_used: string; degraded: boolean; warnings: string[]; timeline: InferenceBackendTimelineItem[] }>;
  invokeInferenceMergeCheckpoints: (payload: MergeCheckpointsRequestPayload) => Promise<{ data: Record<string, unknown>; backend_used: string; degraded: boolean; warnings: string[]; timeline: InferenceBackendTimelineItem[] }>;
}

/** Feedback quality, report assembly, and speaker analysis helpers. */
export interface FinalizeFeedbackContext {
  sanitizeClaimEvidenceRefs: (perPerson: PersonFeedbackItem[], evidence: ResultV2["evidence"]) => { sanitized: PersonFeedbackItem[]; strippedCount: number };
  validateClaimEvidenceRefs: (report: ResultV2) => { valid: boolean; claimCount: number; invalidCount: number; needsEvidenceCount: number; failures: string[] };
  evaluateFeedbackQualityGates: (params: { unknownRatio: number; ingestP95Ms: number | null; claimValidationFailures: string[] }) => { passed: boolean; failures: string[] };
  mergeStatsWithRoster: (stats: SpeakerStatItem[], state: SessionState) => SpeakerStatItem[];
  buildEvidenceIndex: (perPerson: PersonFeedbackItem[]) => Record<string, string[]>;
  buildQualityMetrics: (transcript: TranscriptItem[], captureByStream: Record<StreamRole, CaptureState>) => { unknown_ratio: number; students_utterance_count: number; students_unknown_count: number; echo_suppressed_chunks: number; echo_suppression_recent_rate: number; echo_leak_rate: number; suppression_false_positive_rate: number | undefined };
  speechBackendMode: (state: SessionState, dependencyHealth: DependencyHealthSnapshot) => string;
  deriveSpeakerLogsFromTranscript: (nowIso: string, transcript: TranscriptItem[], state: SessionState, existing: SpeakerLogs, source?: "cloud" | "edge") => SpeakerLogs;
  buildEdgeSpeakerLogsForFinalize: (nowIso: string, existing: SpeakerLogs, state: SessionState) => SpeakerLogs;
  runIncrementalJob: (sessionId: string) => Promise<void>;
  runIncrementalFinalize: (sessionId: string, memos: MemoItem[], stats: SpeakerStatItem[], evidence: ResultV2["evidence"], locale: string, nameAliases: Record<string, string[]>) => Promise<boolean>;
  loadIncrementalStatus: () => Promise<import("./types_v2").IncrementalStatus>;
  triggerImprovementGeneration: (sessionId: string, resultV2: ResultV2, transcript: TranscriptItem[], resultV2Key: string) => Promise<void>;
}

/**
 * Full context for runFinalizeV2Job — composed from all sub-interfaces.
 * Use the sub-interfaces directly when only a subset is needed (e.g. ImprovementContext).
 */
export type FinalizeJobContext =
  & FinalizeCoreContext
  & FinalizeAudioContext
  & FinalizeStorageContext
  & FinalizeLifecycleContext
  & FinalizeInferenceContext
  & FinalizeFeedbackContext;

/**
 * Minimal context for triggerImprovementGenerationImpl.
 * Avoids the unsafe `as FinalizeJobContext` cast at the call site.
 */
export interface ImprovementContext extends FinalizeCoreContext {
  loadFeedbackCache: (sessionId: string) => Promise<FeedbackCache>;
  storeFeedbackCache: (cache: FeedbackCache) => Promise<void>;
}

export async function runFinalizeV2Job(
  sessionId: string,
  jobId: string,
  metadata: Record<string, unknown>,
  ctx: FinalizeJobContext,
  mode: 'full' | 'report-only' = 'full'
): Promise<void> {
  const finalizeWarnings: string[] = [];
  const backendTimeline: InferenceBackendTimelineItem[] = [];
  let finalizeBackendUsed: FinalizeV2Status["backend_used"] = "primary";
  let finalizeDegraded = false;

  // Global timeout guard — abort all operations if finalization exceeds budget
  const globalTimeoutMs = ctx.finalizeTimeoutMs();
  const abortController = new AbortController();
  const globalTimer = setTimeout(() => {
    abortController.abort(new Error(`Finalization exceeded global timeout of ${globalTimeoutMs}ms`));
  }, globalTimeoutMs);

  // Rehydrate captionSource from DO storage in case DO was evicted
  if (ctx.getCaptionSource() === "none") {
    const persisted = await ctx.doCtx.storage.get<string>(STORAGE_KEY_CAPTION_SOURCE);
    if (persisted === "acs-teams") ctx.setCaptionSource(persisted);
  }

  const startedAt = ctx.currentIsoTs();
  await ctx.updateFinalizeV2Status(jobId, {
    status: "running",
    stage: "freeze",
    progress: 5,
    started_at: startedAt,
    warnings: [],
    degraded: false,
    backend_used: "primary"
  });
  await ctx.setFinalizeLock(true);

  try {
    await ctx.ensureFinalizeJobActive(jobId);
    const timeoutMs = ctx.finalizeTimeoutMs();
    const ingestByStream = await ctx.loadIngestByStream(sessionId);
    const cutoff = {
      mixed: ingestByStream.mixed.last_seq,
      teacher: ingestByStream.teacher.last_seq,
      students: ingestByStream.students.last_seq
    };

    // Rehydrate captionSource from DO storage if still default (DO was evicted)
    if (ctx.getCaptionSource() === "none") {
      const persisted = await ctx.doCtx.storage.get<string>(STORAGE_KEY_CAPTION_SOURCE);
      if (persisted === "acs-teams") ctx.setCaptionSource(persisted);
    }
    // Rehydrate captionBuffer from DO storage if empty (DO was evicted or re-generate)
    if (ctx.getCaptionSource() === "acs-teams" && ctx.getCaptionBuffer().length === 0) {
      const stored = await ctx.doCtx.storage.get<CaptionEvent[]>(STORAGE_KEY_CAPTION_BUFFER);
      if (Array.isArray(stored) && stored.length > 0) {
        ctx.setCaptionBuffer(stored);
        log("info", "finalize-v2: restored captions from DO storage", { component: "finalize-v2", caption_count: stored.length });
      }
    }

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    // ── report-only mode: skip audio stages, reload existing transcript from R2 ──
    if (mode === 'report-only') {
      await ctx.updateFinalizeV2Status(jobId, {
        status: "running",
        stage: "reconcile",
        progress: 42,
        started_at: startedAt,
        warnings: [],
        degraded: false,
        backend_used: "primary"
      });
      await ctx.setFinalizeLock(true);

      try {
        // Load existing ResultV2 from R2
        const existingKey = resultObjectKeyV2(sessionId);
        const existingObj = await ctx.env.RESULT_BUCKET.get(existingKey);
        if (!existingObj) {
          throw new Error("report-only: no existing ResultV2 in R2");
        }
        const existingResult = JSON.parse(await existingObj.text()) as ResultV2;

        // Extract previously computed data
        const transcript = existingResult.transcript;
        const speakerLogs = existingResult.speaker_logs;
        const stats = existingResult.stats;
        const state = normalizeSessionState(await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const memos = await ctx.loadMemos();
        const locale = getSessionLocale(state, ctx.env);

        // Merge any new metadata memos
        if (Array.isArray((metadata as Record<string, unknown>)?.memos)) {
          const incomingMemos = (metadata as Record<string, unknown>).memos as Array<Record<string, unknown>>;
          const existingIds = new Set(memos.map((m) => m.memo_id));
          for (const raw of incomingMemos) {
            const memoId = typeof raw.memo_id === "string" ? raw.memo_id : `m_meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
            if (existingIds.has(memoId)) continue;
            memos.push({
              memo_id: memoId,
              created_at_ms: typeof raw.created_at_ms === "number" ? raw.created_at_ms : Date.now(),
              author_role: "teacher",
              type: (["observation", "evidence", "question", "decision", "score"].includes(raw.type as string) ? raw.type : "observation") as MemoItem["type"],
              tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
              text: typeof raw.text === "string" ? raw.text : "",
              stage: typeof raw.stage === "string" ? raw.stage : undefined,
              stage_index: typeof raw.stage_index === "number" ? raw.stage_index : undefined,
            });
            existingIds.add(memoId);
          }
          await ctx.storeMemos(memos);
        }

        // Re-run events → report → persist (reuse transcript + stats)
        // Jump to events stage
        await ctx.updateFinalizeV2Status(jobId, { stage: "events", progress: 55 });
        await ctx.ensureFinalizeJobActive(jobId);

        const knownSpeakers = stats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
        const memoBindings = extractMemoNames(memos, knownSpeakers);
        const configStages: string[] = (state.config as Record<string, unknown>)?.stages as string[] ?? [];
        const enrichedMemos = addStageMetadata(memos, configStages);
        let evidence = buildMultiEvidence({ memos: enrichedMemos, transcript, bindings: memoBindings });
        const enrichedEvidence = enrichEvidencePack(transcript, stats);
        evidence = [...evidence, ...enrichedEvidence];

        const legacyEvidence = buildEvidence({ memos, transcript });
        const memosWithEvidence = attachEvidenceToMemos(memos, legacyEvidence);

        const eventsPayload = {
          session_id: sessionId,
          transcript,
          memos: memosWithEvidence,
          stats,
          locale
        };
        const eventsResult = await ctx.invokeInferenceAnalysisEvents(eventsPayload);
        const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
        if (eventsResult.warnings.length > 0) finalizeWarnings.push(...eventsResult.warnings);
        if (eventsResult.degraded) finalizeDegraded = true;
        finalizeBackendUsed = (eventsResult.backend_used === "local" ? "local" : eventsResult.backend_used) as FinalizeV2Status["backend_used"];

        // Report stage
        await ctx.updateFinalizeV2Status(jobId, { stage: "report", progress: 75 });
        await ctx.ensureFinalizeJobActive(jobId);

        const audioDurationMs = calcTranscriptDurationMs(transcript);
        const statsObservations = generateStatsObservations(stats, audioDurationMs);
        const memoFirstReport = buildMemoFirstReport({ transcript, memos: memosWithEvidence, evidence: legacyEvidence, stats });
        let finalOverall = memoFirstReport.overall;
        let finalPerPerson = memoFirstReport.per_person;
        let reportSource: "memo_first" | "llm_enhanced" | "llm_failed" | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback" = "memo_first";
        let reportModel: string | null = null;
        let reportError: string | null = null;
        let reportBlockingReason: string | null = null;
        let pipelineMode: "memo_first_with_llm_polish" | "llm_core_synthesis" = "memo_first_with_llm_polish";

        // Try LLM synthesis
        const storedCheckpoints = await ctx.loadCheckpoints();
        try {
          const fullConfig = (state.config ?? {}) as Record<string, unknown>;
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

          // Augment sessionContext with dimension presets from config
          if (sessionContext) {
            const it = fullConfig.interview_type;
            if (typeof it === "string" && it) sessionContext.interview_type = it;
            const dp = fullConfig.dimension_presets;
            if (Array.isArray(dp)) sessionContext.dimension_presets = dp as DimensionPresetItem[];
          }

          const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
          const synthPayload = buildSynthesizePayload({
            sessionId,
            transcript,
            memos: enrichedMemos,
            evidence,
            stats,
            events: analysisEvents.map((evt: Record<string, unknown>) => ({
              event_id: String(evt.event_id ?? ""),
              event_type: String(evt.event_type ?? ""),
              actor: evt.actor != null ? String(evt.actor) : null,
              target: evt.target != null ? String(evt.target) : null,
              time_range_ms: Array.isArray(evt.time_range_ms) ? (evt.time_range_ms as number[]) : [],
              utterance_ids: Array.isArray(evt.utterance_ids) ? (evt.utterance_ids as string[]) : [],
              quote: evt.quote != null ? String(evt.quote) : null,
              confidence: typeof evt.confidence === "number" ? evt.confidence : 0.5,
              rationale: evt.rationale != null ? String(evt.rationale) : null,
            })),
            bindings: memoBindings,
            rubric,
            sessionContext,
            freeFormNotes,
            historical: [],
            stages: contextStages.length > 0 ? contextStages : configStages,
            locale,
            nameAliases: configNameAliases,
            statsObservations,
          });

          const synthResult = await ctx.invokeInferenceSynthesizeReport(synthPayload);
          const synthData = synthResult.data;
          if (synthResult.warnings.length > 0) finalizeWarnings.push(...synthResult.warnings);
          if (synthResult.degraded) finalizeDegraded = true;

          const candidatePerPerson = Array.isArray(synthData?.per_person) ? (synthData.per_person as PersonFeedbackItem[]) : [];
          if (candidatePerPerson.length > 0) {
            const { sanitized, strippedCount } = ctx.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
            if (strippedCount > 0) finalizeWarnings.push(`sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
            const validation = ctx.validateClaimEvidenceRefs({ evidence, per_person: sanitized } as ResultV2);
            if (validation.valid) {
              finalPerPerson = sanitized;
              finalOverall = synthData?.overall ?? finalOverall;
              reportSource = "llm_synthesized";
              pipelineMode = "llm_core_synthesis";
              evidence = backfillSupportingUtterances(evidence, finalPerPerson);
            } else {
              reportSource = "memo_first_fallback";
              reportBlockingReason = validation.failures[0] || "invalid evidence refs";
            }
          }
        } catch (synthErr) {
          reportSource = "memo_first_fallback";
          reportError = getErrorMessage(synthErr);
          finalizeWarnings.push(`report-only synthesis failed: ${getErrorMessage(synthErr)}`);
        }

        if (!ACCEPTED_REPORT_SOURCES.has(reportSource)) {
          evidence = legacyEvidence;
        }

        // Persist stage
        await ctx.updateFinalizeV2Status(jobId, { stage: "persist", progress: 92 });
        await ctx.ensureFinalizeJobActive(jobId);
        const finalizedAt = ctx.currentIsoTs();

        const memoFirstValidation = validatePersonFeedbackEvidence(finalPerPerson);
        const finalStrictValidation = ctx.validateClaimEvidenceRefs({ evidence, per_person: finalPerPerson } as ResultV2);
        const synthQualityGate = enforceQualityGates({
          perPerson: finalPerPerson,
          unknownRatio: computeUnknownRatio(transcript),
        });

        const captureByStream = (normalizeSessionState(await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE))).capture_by_stream ?? defaultCaptureByStream();
        const qualityMetrics = ctx.buildQualityMetrics(transcript, captureByStream);
        const quality: ReportQualityMeta = {
          ...memoFirstValidation.quality,
          generated_at: finalizedAt,
          build_ms: 0,
          validation_ms: 0,
          claim_count: finalStrictValidation.claimCount,
          invalid_claim_count: finalStrictValidation.invalidCount,
          needs_evidence_count: finalStrictValidation.needsEvidenceCount,
          report_source: reportSource,
          report_model: reportModel,
          report_degraded: !ACCEPTED_REPORT_SOURCES.has(reportSource),
          report_error: reportError
        };

        const confidenceLevel = existingResult.session.confidence_level ?? "high";
        const tentative = confidenceLevel === "low" || !ctx.evaluateFeedbackQualityGates({
          unknownRatio: qualityMetrics.unknown_ratio,
          ingestP95Ms: null,
          claimValidationFailures: [
            ...(finalStrictValidation.failures ?? []),
            ...synthQualityGate.failures,
            ...(ACCEPTED_REPORT_SOURCES.has(reportSource) ? [] : [reportBlockingReason || "llm report unavailable"])
          ]
        }).passed;

        const resultV2 = buildResultV2({
          sessionId,
          finalizedAt,
          tentative,
          confidenceLevel,
          unresolvedClusterCount: existingResult.session.unresolved_cluster_count ?? 0,
          captionSource: ctx.getCaptionSource(),
          diarizationBackend: existingResult.session.diarization_backend ?? "cloud",
          transcript,
          speakerLogs,
          stats,
          memos,
          evidence,
          overall: finalOverall,
          perPerson: finalPerPerson,
          quality,
          finalizeJobId: jobId,
          modelVersions: existingResult.trace?.model_versions ?? {},
          thresholds: existingResult.trace?.thresholds ?? {},
          backendTimeline: [],
          qualityGateSnapshot: existingResult.trace?.quality_gate_snapshot,
          reportPipeline: {
            mode: pipelineMode,
            source: reportSource,
            llm_attempted: true,
            llm_success: reportSource === "llm_synthesized",
            llm_elapsed_ms: 0,
            blocking_reason: reportBlockingReason
          },
          qualityGateFailures: []
        });

        const resultV2Key = resultObjectKeyV2(sessionId);
        await ctx.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
          httpMetadata: { contentType: "application/json" }
        });
        await ctx.doCtx.storage.put(STORAGE_KEY_RESULT_KEY_V2, resultV2Key);
        await ctx.doCtx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
        await ctx.doCtx.storage.put(STORAGE_KEY_UPDATED_AT, finalizedAt);

        const cache = await ctx.loadFeedbackCache(sessionId);
        cache.updated_at = finalizedAt;
        cache.report = resultV2;
        cache.person_summary_cache = resultV2.per_person;
        cache.overall_summary_cache = resultV2.overall;
        cache.evidence_index_cache = ctx.buildEvidenceIndex(resultV2.per_person);
        cache.quality = resultV2.quality;
        cache.report_source = reportSource;
        cache.blocking_reason = reportBlockingReason;
        cache.quality_gate_passed = ACCEPTED_REPORT_SOURCES.has(reportSource)
          && finalStrictValidation.needsEvidenceCount === 0;
        cache.ready = cache.quality_gate_passed && !tentative;
        await ctx.storeFeedbackCache(cache);

        await ctx.updateFinalizeV2Status(jobId, {
          status: "succeeded",
          stage: "persist",
          progress: 100,
          finished_at: finalizedAt,
          warnings: finalizeWarnings,
          degraded: finalizeDegraded,
          backend_used: finalizeBackendUsed
        });

        log("info", "finalize-v2: report-only completed", { component: "finalize-v2", session_id: sessionId });

        // ── Async: generate improvement suggestions (non-blocking) ──
        ctx.triggerImprovementGeneration(sessionId, resultV2, resultV2.transcript, resultV2Key).catch(err2 => {
          log("warn", "finalize-v2: improvements generation failed (non-blocking)", { component: "finalize-v2", session_id: sessionId, error: getErrorMessage(err2) });
        });
      } catch (err) {
        const errMsg = getErrorMessage(err) || "unknown error";
        log("error", "finalize-v2: report-only failed", { component: "finalize-v2", session_id: sessionId, error: errMsg });
        await ctx.updateFinalizeV2Status(jobId, {
          status: "failed",
          errors: [errMsg],
          finished_at: ctx.currentIsoTs()
        });
      } finally {
        await ctx.setFinalizeLock(false);
      }
      return; // exit early — do not run full pipeline
    }

    // ── Caption mode: skip audio-dependent stages ──
    const useCaptions = ctx.getCaptionSource() === 'acs-teams' && ctx.getCaptionBuffer().length > 0;

    // GUARD: If captionSource is acs-teams but captionBuffer is empty (DO evicted + storage lost),
    // force report-only mode to avoid falling through to local_asr which would timeout.
    // At this point mode is 'full' (report-only already returned above), so we redirect.
    if (ctx.getCaptionSource() === 'acs-teams' && !useCaptions) {
      log("warn", "finalize-v2: captionSource=acs-teams but captionBuffer empty, forcing report-only mode", { component: "finalize-v2", session_id: sessionId });
      await ctx.setFinalizeLock(false);
      return runFinalizeV2Job(sessionId, jobId, metadata, ctx, 'report-only');
    }

    if (!useCaptions) {
    // ── Drain ASR queues (non-fatal) ──
    // Drain is best-effort: if DashScope ASR is unreachable, we continue with
    // whatever transcript data we already have. This prevents external service
    // outages from blocking the entire finalization pipeline.
    await ctx.updateFinalizeV2Status(jobId, { stage: "drain", progress: 18 });
    await ctx.ensureFinalizeJobActive(jobId);
    const drainTimeoutMs = Math.min(timeoutMs, DRAIN_TIMEOUT_CAP_MS); // cap drain at 30s
    const drainWithTimeout = async (streamRole: StreamRole): Promise<void> => {
      await Promise.race([
        ctx.drainRealtimeQueue(sessionId, streamRole),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error(`drain timeout stream=${streamRole}`)), drainTimeoutMs);
        })
      ]);
    };
    try {
      await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);
    } catch (drainErr) {
      log("warn", "finalize-v2: drain failed (non-fatal), continuing", { component: "finalize-v2", session_id: sessionId, error: getErrorMessage(drainErr) });
      finalizeWarnings.push(`drain degraded: ${getErrorMessage(drainErr)}`);
      finalizeDegraded = true;
    }

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    await ctx.updateFinalizeV2Status(jobId, { stage: "replay_gap", progress: 30 });
    await ctx.ensureFinalizeJobActive(jobId);
    try {
      await Promise.all([ctx.replayGapFromR2(sessionId, "teacher"), ctx.replayGapFromR2(sessionId, "students")]);
      await Promise.all([drainWithTimeout("teacher"), drainWithTimeout("students")]);
    } catch (replayErr) {
      log("warn", "finalize-v2: replay/drain failed (non-fatal), continuing", { component: "finalize-v2", session_id: sessionId, error: getErrorMessage(replayErr) });
      finalizeWarnings.push(`replay degraded: ${getErrorMessage(replayErr)}`);
      finalizeDegraded = true;
    }

    // Force-close ASR sessions and clear queues to prevent orphaned drain loops
    await ctx.closeRealtimeAsrSession("teacher", "finalize-v2", true, false);
    await ctx.closeRealtimeAsrSession("students", "finalize-v2", true, false);
    await ctx.refreshAsrStreamMetrics(sessionId, "teacher");
    await ctx.refreshAsrStreamMetrics(sessionId, "students");
    } // end if (!useCaptions) — drain/replay/close

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    // ── Windowed ASR for local-whisper (drain/replay only applies to FunASR realtime) ──
    // When using local-whisper, audio is NOT streamed to a realtime ASR WebSocket during
    // recording. Instead, we must run windowed transcription on all stored audio now.
    if (!useCaptions && ctx.getAsrProvider() === "local-whisper") {
      await ctx.updateFinalizeV2Status(jobId, { stage: "local_asr", progress: 25 });
      await ctx.ensureFinalizeJobActive(jobId);
      try {
        // Log diagnostic info before running windowed ASR
        const diagIngest = await ctx.loadIngestByStream(sessionId);
        const diagAsr = await ctx.loadAsrByStream();
        log("info", "finalize-v2: local-whisper pre-check", { component: "finalize-v2", session_id: sessionId, teacher_last_seq: diagIngest.teacher.last_seq, students_last_seq: diagIngest.students.last_seq, asr_enabled: diagAsr.students.enabled, window_seconds: diagAsr.students.window_seconds });
        log("info", "finalize-v2: ASR provider info", { component: "finalize-v2", session_id: sessionId, asr_provider: ctx.env.ASR_PROVIDER, has_local_whisper: !!ctx.localWhisperProvider, get_asr_provider: ctx.getAsrProvider() });

        // Process each stream sequentially, in small batches (BATCH_SIZE windows)
        // with heartbeat updates between batches. This prevents the DO from being
        // evicted during long ASR processing (each window takes ~10s).
        const BATCH_SIZE = 5;
        const MAX_CONSECUTIVE_FAILURES = 5;
        let totalGenerated = 0;

        for (const role of ["teacher", "students"] as const) {
          const ingest = role === "teacher" ? diagIngest.teacher : diagIngest.students;
          if (ingest.last_seq <= 0) {
              log("info", "finalize-v2: local-whisper skip (no audio)", { sessionId, action: "local_asr", streamRole: role, lastSeq: ingest.last_seq });
            continue;
          }

          const estimatedWindows = Math.floor(ingest.last_seq / (diagAsr[role].hop_seconds || 10));
          log("info", "finalize-v2: local-whisper starting", { sessionId, action: "local_asr", streamRole: role, estimatedWindows });
          let roleGenerated = 0;
          let roleFailures = 0;

          while (true) {
            // Update heartbeat and progress before each batch
            const progressPct = estimatedWindows > 0
              ? Math.min(45, 25 + Math.round((roleGenerated / estimatedWindows) * 20))
              : 25;
            await ctx.updateFinalizeV2Status(jobId, { stage: "local_asr", progress: progressPct });
            await ctx.ensureFinalizeJobActive(jobId);

            // Reset failures before each batch so backoff guard doesn't block
            const asrByStream = await ctx.loadAsrByStream();
            asrByStream[role].consecutive_failures = 0;
            asrByStream[role].next_retry_after_ms = 0;
            await ctx.storeAsrByStream(asrByStream);

            const result = await ctx.maybeRunAsrWindows(sessionId, role, true, BATCH_SIZE);

            if (result.generated > 0) {
              roleGenerated += result.generated;
              totalGenerated += result.generated;
              roleFailures = 0;
              log("info", "finalize-v2: local-whisper batch complete", { component: "finalize-v2", session_id: sessionId, stream_role: role, generated: result.generated, role_total: roleGenerated, estimated: estimatedWindows, last_seq: result.last_window_end_seq });
            } else if (result.last_error) {
              roleFailures += 1;
              log("warn", "finalize-v2: local-whisper batch error", { component: "finalize-v2", session_id: sessionId, stream_role: role, failures: roleFailures, max_failures: MAX_CONSECUTIVE_FAILURES, error: result.last_error });
              if (roleFailures >= MAX_CONSECUTIVE_FAILURES) {
                log("warn", "finalize-v2: local-whisper too many failures, stopping", { component: "finalize-v2", session_id: sessionId, stream_role: role, failures: roleFailures });
                finalizeWarnings.push(`local-whisper ${role}: stopped after ${roleFailures} consecutive failures`);
                break;
              }
              await new Promise((r) => setTimeout(r, 3000));
            } else {
              // No error and no generated = all windows done for this stream
              log("info", "finalize-v2: local-whisper stream complete", { component: "finalize-v2", session_id: sessionId, stream_role: role, windows: roleGenerated });
              break;
            }
          }
        }

        log("info", "finalize-v2: local-whisper completed", { component: "finalize-v2", total_windows: totalGenerated });
        if (totalGenerated === 0) {
          finalizeWarnings.push("local-whisper produced 0 utterances");
        }
      } catch (localAsrErr) {
        log("warn", "finalize-v2: local-whisper ASR failed (non-fatal)", { component: "finalize-v2", error: getErrorMessage(localAsrErr) });
        finalizeWarnings.push(`local-whisper degraded: ${getErrorMessage(localAsrErr)}`);
        finalizeDegraded = true;
      }
    }

    // ── Merge finalize metadata into storage (memos, free_form_notes) ──
    // Desktop may send memos/notes in finalize metadata as a convenience.
    // Merge them into DO storage so the pipeline can read them uniformly.
    if (Array.isArray((metadata as Record<string, unknown>)?.memos)) {
      const incomingMemos = (metadata as Record<string, unknown>).memos as Array<Record<string, unknown>>;
      const existingMemos = await ctx.loadMemos();
      const existingIds = new Set(existingMemos.map((m) => m.memo_id));
      for (const raw of incomingMemos) {
        const memoId = typeof raw.memo_id === "string" ? raw.memo_id : `m_meta_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        if (existingIds.has(memoId)) continue;
        existingMemos.push({
          memo_id: memoId,
          created_at_ms: typeof raw.created_at_ms === "number" ? raw.created_at_ms : Date.now(),
          author_role: "teacher",
          type: (["observation", "evidence", "question", "decision", "score"].includes(raw.type as string) ? raw.type : "observation") as MemoItem["type"],
          tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
          text: typeof raw.text === "string" ? raw.text : "",
          stage: typeof raw.stage === "string" ? raw.stage : undefined,
          stage_index: typeof raw.stage_index === "number" ? raw.stage_index : undefined,
        });
        existingIds.add(memoId);
      }
      await ctx.storeMemos(existingMemos);
    }
    if (typeof (metadata as Record<string, unknown>)?.free_form_notes === "string") {
      const preState = normalizeSessionState(await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const cfg = { ...(preState.config ?? {}) } as Record<string, unknown>;
      cfg.free_form_notes = (metadata as Record<string, unknown>).free_form_notes;
      preState.config = cfg;
      await ctx.doCtx.storage.put(STORAGE_KEY_STATE, preState);
    }

    // ── Global clustering stage ──
    // If edge diarization is active, extract any missing embeddings from R2
    // audio and run global agglomerative clustering to produce consistent
    // speaker IDs across the entire session.
    // Caption mode skips clustering: Teams provides speaker identity directly.
    let globalClusterResult: GlobalClusterResult | null = null;
    let clusterRosterMapping: Map<string, string> | null = null;
    if (!useCaptions) {
    await ctx.updateFinalizeV2Status(jobId, { stage: "cluster", progress: 36 });
    await ctx.ensureFinalizeJobActive(jobId);
    {
      const preState = normalizeSessionState(await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const preDiarizationBackend = preState.config?.diarization_backend === "edge" ? "edge" : "cloud";
      if (preDiarizationBackend === "edge") {
        try {
          // Extract missing embeddings for any turns not yet in the cache
          const preSpeakerLogs = await ctx.loadSpeakerLogs();
          if (ctx.embeddingCache.size === 0 && preSpeakerLogs.turns.length > 0) {
            await ctx.extractEmbeddingsForTurns(sessionId, preSpeakerLogs, "students");
          }

          const embeddings = ctx.embeddingCache.getAllEmbeddings();
          if (embeddings.length >= 2) {
            globalClusterResult = globalCluster(embeddings, {
              distance_threshold: 0.3,
              linkage: "average",
              min_cluster_size: 1
            });

            // Build roster participants with enrollment embeddings for mapping
            const rosterParticipants: RosterParticipant[] = (preState.roster ?? []).map((r) => {
              const profile = (preState.participant_profiles ?? []).find(
                (p) => p.name === r.name
              );
              return {
                name: r.name,
                enrollment_embedding: profile?.centroid?.length
                  ? new Float32Array(profile.centroid)
                  : undefined
              };
            });

            clusterRosterMapping = mapClustersToRoster(globalClusterResult, rosterParticipants, 0.65);
            log("info", "finalize-v2: global clustering complete", { sessionId, action: "cluster", embeddingCount: embeddings.length, clusterCount: globalClusterResult.clusters.size, confidence: globalClusterResult.confidence });
          } else if (embeddings.length > 0) {
            log("info", "finalize-v2: skipping clustering (too few embeddings)", { sessionId, action: "cluster", embeddingCount: embeddings.length });
          }
        } catch (clusterErr) {
          log("warn", "finalize-v2: clustering failed (non-fatal)", { sessionId, action: "cluster", error: getErrorMessage(clusterErr) });
          finalizeWarnings.push(`clustering degraded: ${getErrorMessage(clusterErr)}`);
          finalizeDegraded = true;
        }
      }
    }
    } // end if (!useCaptions) — clustering

    await ctx.updateFinalizeV2Status(jobId, { stage: "reconcile", progress: 42 });
    await ctx.ensureFinalizeJobActive(jobId);

    let transcript: TranscriptItem[];
    let state: SessionState;
    let memos: MemoItem[];
    let locale: string;
    let diarizationBackend: "cloud" | "edge";
    let speakerLogsStored: SpeakerLogs;
    let confidenceLevel: "high" | "medium" | "low";
    let tentative: boolean;
    let speakerLogs: SpeakerLogs;
    let unresolvedClusterCount: number;
    let asrByStream: Record<StreamRole, AsrState>;

    if (useCaptions) {
      // ── Caption mode: build transcript from captionBuffer ──
      const captionAsr = new ACSCaptionASRProvider();
      const captionDia = new ACSCaptionDiarizationProvider();
      const utterances = captionAsr.convertToUtterances(ctx.getCaptionBuffer());
      const resolved = captionDia.resolveCaptions(ctx.getCaptionBuffer());
      const speakerMap = captionDia.getSpeakerMap();

      state = normalizeSessionState(await ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE));
      memos = await ctx.loadMemos();
      speakerLogsStored = await ctx.loadSpeakerLogs();
      locale = getSessionLocale(state, ctx.env);
      diarizationBackend = "cloud"; // caption mode doesn't use edge diarization

      // Build transcript from caption utterances
      transcript = utterances.map((u, i) => ({
        utterance_id: u.id,
        stream_role: "students" as const, // captions are from remote participants
        cluster_id: resolved[i]?.speaker_id ?? null,
        speaker_name: resolved[i]?.speaker_name ?? null,
        decision: "auto" as const,
        text: u.text,
        start_ms: u.start_ms,
        end_ms: u.end_ms,
        duration_ms: u.end_ms - u.start_ms,
      }));

      // Update state with caption speaker bindings
      for (const [displayName, speakerId] of Object.entries(speakerMap)) {
        state.bindings[speakerId] = displayName;
        state.cluster_binding_meta[speakerId] = {
          participant_name: displayName,
          source: "name_extract",
          confidence: 0.95,
          locked: true,
          updated_at: new Date().toISOString(),
        };
      }

      // Caption mode: all speakers are identified by Teams, so confidence is always high
      confidenceLevel = "high";
      tentative = false;
      unresolvedClusterCount = 0;
      asrByStream = await ctx.loadAsrByStream();

      // Build speaker logs from caption transcript
      const cloudBase = speakerLogsStored.source === "cloud" ? speakerLogsStored : emptySpeakerLogs(ctx.currentIsoTs());
      speakerLogs = ctx.deriveSpeakerLogsFromTranscript(
        ctx.currentIsoTs(),
        transcript,
        state,
        cloudBase,
        "cloud"
      );
      await ctx.storeSpeakerLogs(speakerLogs);

      log("info", "finalize-v2: caption mode transcript built", { sessionId, action: "reconcile", utteranceCount: utterances.length, speakerCount: Object.keys(speakerMap).length });
    } else {
      // ── Original audio-based reconciliation path ──
      const [stateRaw, events, rawByStream, mergedByStream, memosLoaded, speakerLogsLoaded, asrByStreamLoaded] = await Promise.all([
        ctx.doCtx.storage.get<SessionState>(STORAGE_KEY_STATE),
        ctx.loadSpeakerEvents(),
        ctx.loadUtterancesRawByStream(),
        ctx.loadUtterancesMergedByStream(),
        ctx.loadMemos(),
        ctx.loadSpeakerLogs(),
        ctx.loadAsrByStream()
      ]);
      state = normalizeSessionState(stateRaw);
      memos = memosLoaded;
      speakerLogsStored = speakerLogsLoaded;
      asrByStream = asrByStreamLoaded;
      locale = getSessionLocale(state, ctx.env);
      // When caption source is set to acs-teams (even if buffer is empty due to
      // ACS join failure), force cloud diarization — edge diarization requires
      // edge speaker-logs which are not collected in caption mode.
      diarizationBackend = ctx.getCaptionSource() === 'acs-teams'
        ? "cloud"
        : (state.config?.diarization_backend === "edge" ? "edge" : "cloud");

      const cutoffUtterances = [...rawByStream.teacher, ...rawByStream.students]
        .filter((item) => item.end_seq <= cutoff[item.stream_role]);
      transcript = buildReconciledTranscript({
        utterances: cutoffUtterances,
        events,
        speakerLogs: speakerLogsStored,
        state,
        diarizationBackend,
        roster: (state.roster ?? []).flatMap((r) => [r.name, ...(r.aliases ?? [])]),
        globalClusterResult,
        clusterRosterMapping,
        cachedEmbeddings: ctx.embeddingCache.getAllEmbeddings()
      });

      mergedByStream.teacher = mergeUtterances(rawByStream.teacher);
      mergedByStream.students = mergeUtterances(rawByStream.students);
      await ctx.storeUtterancesMergedByStream(mergedByStream);

      // ── Memo-assisted binding: resolve unidentified clusters using teacher notes ──
      const rosterNames = (state.roster ?? []).map(r => r.name).filter(Boolean);
      const memoBindResult = memoAssistedBinding({
        clusters: state.clusters.map(c => ({ cluster_id: c.cluster_id, turn_ids: [] })),
        bindings: state.bindings,
        bindingMeta: state.cluster_binding_meta,
        transcript,
        memos,
        roster: rosterNames,
      });
      for (const [clusterId, name] of Object.entries(memoBindResult.newBindings)) {
        state.bindings[clusterId] = name;
        state.cluster_binding_meta[clusterId] = {
          participant_name: name,
          source: "name_extract",
          confidence: 0.7,
          locked: false,
          updated_at: new Date().toISOString(),
        };
      }

      unresolvedClusterCount = state.clusters.filter((cluster) => {
        const bound = state.bindings[cluster.cluster_id];
        const meta = state.cluster_binding_meta[cluster.cluster_id];
        return !bound || !meta || !meta.locked;
      }).length;
      const totalClusters = state.clusters.length;
      const unresolvedRatio = totalClusters > 0 ? unresolvedClusterCount / totalClusters : 0;
      confidenceLevel =
        unresolvedRatio === 0 ? "high" :
        unresolvedRatio <= 0.25 ? "medium" : "low";
      tentative = confidenceLevel === "low";

      const hasStudentTranscript = transcript.some((item) => item.stream_role === "students");
      if (diarizationBackend === "edge") {
        const edgeLogsUsable = !hasStudentTranscript
          || (speakerLogsStored.source === "edge" && speakerLogsStored.turns.length > 0);
        if (edgeLogsUsable) {
          speakerLogs = ctx.buildEdgeSpeakerLogsForFinalize(ctx.currentIsoTs(), speakerLogsStored, state);
        } else {
          // Fallback to cloud diarization when edge speaker-logs are unavailable
          finalizeWarnings.push(`diarization fallback: edge speaker-logs unavailable (source=${speakerLogsStored.source}, turns=${speakerLogsStored.turns.length}), using cloud`);
          diarizationBackend = "cloud";
          const cloudBase = speakerLogsStored.source === "cloud" ? speakerLogsStored : emptySpeakerLogs(ctx.currentIsoTs());
          speakerLogs = ctx.deriveSpeakerLogsFromTranscript(
            ctx.currentIsoTs(),
            transcript,
            state,
            cloudBase,
            "cloud"
          );
        }
      } else {
        const cloudBase = speakerLogsStored.source === "cloud" ? speakerLogsStored : emptySpeakerLogs(ctx.currentIsoTs());
        speakerLogs = ctx.deriveSpeakerLogsFromTranscript(
          ctx.currentIsoTs(),
          transcript,
          state,
          cloudBase,
          "cloud"
        );
      }
      await ctx.storeSpeakerLogs(speakerLogs);
    } // end if/else useCaptions reconcile

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    // E5: Save stage checkpoint after reconcile (most expensive data-prep stage)
    await ctx.saveFinalizeStageCheckpoint(jobId, "reconcile", {
      transcript_count: transcript.length,
      locale,
      diarization_backend: diarizationBackend
    });

    await ctx.updateFinalizeV2Status(jobId, { stage: "stats", progress: 56 });
    const stats = ctx.mergeStatsWithRoster(computeSpeakerStats(transcript), state);

    // ── NEW PIPELINE: Extract names, build multi-evidence, stage metadata ──
    const knownSpeakers = stats.map((s) => s.speaker_name ?? s.speaker_key).filter(Boolean);
    const memoBindings = extractMemoNames(memos, knownSpeakers);
    const configStages: string[] = (state.config as Record<string, unknown>)?.stages as string[] ?? [];
    const enrichedMemos = addStageMetadata(memos, configStages);
    let evidence = buildMultiEvidence({ memos: enrichedMemos, transcript, bindings: memoBindings });

    // ── Enrich evidence pack with transcript quotes, stats summaries, interaction patterns ──
    const enrichedEvidence = enrichEvidencePack(transcript, stats);
    evidence = [...evidence, ...enrichedEvidence];

    // ── Generate stats observations for LLM context ──
    const audioDurationMs = calcTranscriptDurationMs(transcript);
    const statsObservations = generateStatsObservations(stats, audioDurationMs);

    // Keep legacy evidence + memo-first as fallback baseline
    const legacyEvidence = buildEvidence({ memos, transcript });
    const memosWithEvidence = attachEvidenceToMemos(memos, legacyEvidence);
    const memoFirstStart = Date.now();
    const memoFirstReport = buildMemoFirstReport({
      transcript,
      memos: memosWithEvidence,
      evidence: legacyEvidence,
      stats
    });
    const memoFirstBuildMs = Date.now() - memoFirstStart;
    const validationStart = Date.now();
    const memoFirstStrictValidation = ctx.validateClaimEvidenceRefs({
      evidence: legacyEvidence,
      per_person: memoFirstReport.per_person
    } as ResultV2);
    const memoFirstValidation = validatePersonFeedbackEvidence(memoFirstReport.per_person);
    const validationMs = Date.now() - validationStart;
    if (!memoFirstValidation.valid || !memoFirstStrictValidation.valid) {
      // Non-fatal: memo-first baseline has invalid evidence refs (common when drain
      // was degraded). Continue to LLM synthesis which may produce valid refs.
      log("warn", "finalize-v2: memo-first evidence validation failed (non-fatal)", { sessionId, action: "report", claimCount: memoFirstStrictValidation.claimCount, invalidCount: memoFirstStrictValidation.invalidCount });
      finalizeWarnings.push(`memo-first evidence invalid: ${memoFirstStrictValidation.invalidCount}/${memoFirstStrictValidation.claimCount} claims`);
      finalizeDegraded = true;
    }

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    await ctx.updateFinalizeV2Status(jobId, { stage: "events", progress: 70 });
    await ctx.ensureFinalizeJobActive(jobId);
    const eventsPayload = {
      session_id: sessionId,
      transcript,
      memos: memosWithEvidence,
      stats,
      locale
    };
    const eventsResult = await ctx.invokeInferenceAnalysisEvents(eventsPayload);
    const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
    backendTimeline.push(...eventsResult.timeline);
    if (eventsResult.warnings.length > 0) {
      finalizeWarnings.push(...eventsResult.warnings);
    }
    if (eventsResult.degraded) {
      finalizeDegraded = true;
    }
    finalizeBackendUsed = (eventsResult.backend_used === "local" ? "local" : eventsResult.backend_used) as FinalizeV2Status["backend_used"];
    if (eventsResult.fallback_reason) {
      finalizeWarnings.push(`events fallback: ${eventsResult.fallback_reason}`);
    }
    await ctx.updateFinalizeV2Status(jobId, {
      warnings: finalizeWarnings,
      degraded: finalizeDegraded,
      backend_used: finalizeBackendUsed
    });

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    // E5: Save stage checkpoint after events (before expensive LLM report generation)
    await ctx.saveFinalizeStageCheckpoint(jobId, "events", {
      events_count: analysisEvents.length,
      backend_used: finalizeBackendUsed,
      degraded: finalizeDegraded
    });

    await ctx.updateFinalizeV2Status(jobId, { stage: "report", progress: 84 });
    await ctx.ensureFinalizeJobActive(jobId);
    const reportStart = Date.now();
    let finalOverall = memoFirstReport.overall;
    let finalPerPerson = memoFirstReport.per_person;
    let reportSource: "memo_first" | "llm_enhanced" | "llm_failed"
      | "llm_synthesized" | "llm_synthesized_truncated" | "memo_first_fallback" = "memo_first";
    let reportModel: string | null = null;
    let reportError: string | null = null;
    let reportBlockingReason: string | null = null;
    let reportTimeline: InferenceBackendTimelineItem[] = [];
    let llmAttempted = false;
    let llmSuccess = false;
    let llmElapsedMs: number | null = null;
    let pipelineMode: "memo_first_with_llm_polish" | "llm_core_synthesis" = "memo_first_with_llm_polish";

    // ── LLM-Core Synthesis Pipeline (with checkpoint merge support) ──
    const storedCheckpoints = await ctx.loadCheckpoints();
    const useCheckpointMerge = storedCheckpoints.length > 0;
    try {
      llmAttempted = true;
      const fullConfig = (state.config ?? {}) as Record<string, unknown>;
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


      // Augment sessionContext with dimension presets from config
      if (sessionContext) {
        const it = fullConfig.interview_type;
        if (typeof it === "string" && it) sessionContext.interview_type = it;
        const dp = fullConfig.dimension_presets;
        if (Array.isArray(dp)) sessionContext.dimension_presets = dp as DimensionPresetItem[];
      }
      let synthData: Record<string, unknown>;
      const synthStart = Date.now();

      if (useCheckpointMerge) {
        // ── Checkpoint merge path: merge pre-computed checkpoint summaries ──
        log("info", "finalize: using checkpoint merge", { sessionId, action: "report", checkpointCount: storedCheckpoints.length });
        const mergePayload: MergeCheckpointsRequestPayload = {
          session_id: sessionId,
          checkpoints: storedCheckpoints,
          final_stats: stats,
          final_memos: enrichedMemos,
          evidence: evidence.map((e) => {
            let sk = e.speaker?.person_id ?? e.speaker?.display_name ?? e.speaker?.cluster_id ?? null;
            if ((!sk || /^c\d+$/.test(sk) || sk === "unknown") && e.quote) {
              const quoteLower = e.quote.toLowerCase();
              for (const stat of stats) {
                const name = stat.speaker_name?.trim();
                if (name && name !== "unknown" && name !== "teacher" && quoteLower.includes(name.toLowerCase())) {
                  sk = name;
                  break;
                }
              }
            }
            return { ...e, speaker_key: sk };
          }),
          locale,
        };
        const mergeResult = await ctx.invokeInferenceMergeCheckpoints(mergePayload);
        llmElapsedMs = Date.now() - synthStart;
        reportTimeline = mergeResult.timeline;
        synthData = mergeResult.data;
        if (mergeResult.warnings.length > 0) {
          finalizeWarnings.push(...mergeResult.warnings);
        }
        if (mergeResult.degraded) {
          finalizeDegraded = true;
        }
      } else {
        // ── Direct synthesis path: short interviews without checkpoints ──
        const configNameAliases = (fullConfig.name_aliases ?? {}) as Record<string, string[]>;
        const synthPayload = buildSynthesizePayload({
          sessionId,
          transcript,
          memos: enrichedMemos,
          evidence,
          stats,
          events: analysisEvents.map((evt: Record<string, unknown>) => ({
            event_id: String(evt.event_id ?? ""),
            event_type: String(evt.event_type ?? ""),
            actor: evt.actor != null ? String(evt.actor) : null,
            target: evt.target != null ? String(evt.target) : null,
            time_range_ms: Array.isArray(evt.time_range_ms) ? (evt.time_range_ms as number[]) : [],
            utterance_ids: Array.isArray(evt.utterance_ids) ? (evt.utterance_ids as string[]) : [],
            quote: evt.quote != null ? String(evt.quote) : null,
            confidence: typeof evt.confidence === "number" ? evt.confidence : 0.5,
            rationale: evt.rationale != null ? String(evt.rationale) : null,
          })),
          bindings: memoBindings,
          rubric,
          sessionContext,
          freeFormNotes,
          historical: [],
          stages: contextStages.length > 0 ? contextStages : configStages,
          locale,
          nameAliases: configNameAliases,
          statsObservations,
        });

        const synthResult = await ctx.invokeInferenceSynthesizeReport(synthPayload);
        llmElapsedMs = Date.now() - synthStart;
        reportTimeline = synthResult.timeline;
        synthData = synthResult.data;
        if (synthResult.warnings.length > 0) {
          finalizeWarnings.push(...synthResult.warnings);
        }
        if (synthResult.degraded) {
          finalizeDegraded = true;
        }
      }

      const candidatePerPerson = Array.isArray(synthData?.per_person) ? (synthData.per_person as PersonFeedbackItem[]) : [];
      const candidateOverall = (synthData?.overall ?? memoFirstReport.overall) as unknown;
      const candidateQuality =
        synthData?.quality && typeof synthData.quality === "object" ? (synthData.quality as Partial<ReportQualityMeta>) : null;

      if (candidatePerPerson.length > 0) {
        // Strip claims with empty/invalid evidence_refs before validation
        const { sanitized: sanitizedPerPerson, strippedCount } = ctx.sanitizeClaimEvidenceRefs(candidatePerPerson, evidence);
        if (strippedCount > 0) {
          finalizeWarnings.push(`sanitized ${strippedCount} claims with empty/invalid evidence_refs`);
        }
        const candidateValidation = ctx.validateClaimEvidenceRefs({
          evidence,
          per_person: sanitizedPerPerson
        } as ResultV2);
        if (candidateValidation.valid) {
          finalPerPerson = sanitizedPerPerson;
          finalOverall = candidateOverall;
          llmSuccess = true;
          pipelineMode = "llm_core_synthesis";
          reportSource = (candidateQuality?.report_source as typeof reportSource) ?? "llm_synthesized";
          reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
          reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
          // Stage 2 LLM fine-matching: backfill supporting_utterances into evidence
          evidence = backfillSupportingUtterances(evidence, finalPerPerson);
        } else {
          reportSource = "memo_first_fallback";
          reportBlockingReason = candidateValidation.failures[0] || "analysis/synthesize invalid evidence refs";
        }
      } else {
        reportSource = "memo_first_fallback";
        reportBlockingReason = "analysis/synthesize returned empty per_person";
      }
    } catch (synthError) {
      // Synthesis failed — try legacy analysis/report as secondary fallback
      try {
        const reportResult = await ctx.invokeInferenceAnalysisReport({
          session_id: sessionId,
          transcript,
          memos: memosWithEvidence,
          stats,
          evidence: legacyEvidence,
          events: analysisEvents,
          locale
        });
        reportTimeline = reportResult.timeline;
        if (reportResult.warnings.length > 0) {
          finalizeWarnings.push(...reportResult.warnings);
        }
        if (reportResult.degraded) {
          finalizeDegraded = true;
        }
        const payload = reportResult.data;
        const candidatePerPerson = Array.isArray(payload?.per_person) ? (payload.per_person as PersonFeedbackItem[]) : [];
        const candidateOverall = (payload?.overall ?? memoFirstReport.overall) as unknown;
        const candidateQuality =
          payload?.quality && typeof payload.quality === "object" ? (payload.quality as Partial<ReportQualityMeta>) : null;
        if (candidatePerPerson.length > 0) {
          const candidateValidation = ctx.validateClaimEvidenceRefs({
            evidence: legacyEvidence,
            per_person: candidatePerPerson
          } as ResultV2);
          if (candidateValidation.valid) {
            finalPerPerson = candidatePerPerson;
            finalOverall = candidateOverall;
            reportSource = "llm_enhanced";
            if (candidateQuality?.report_source === "memo_first") {
              reportSource = "memo_first";
            }
            if (candidateQuality?.report_source === "llm_failed") {
              reportSource = "llm_failed";
            }
            reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
            reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
          } else {
            reportSource = "memo_first_fallback";
            reportBlockingReason = candidateValidation.failures[0] || "analysis/report invalid evidence refs";
          }
        } else {
          reportSource = "memo_first_fallback";
          reportBlockingReason = "analysis/report returned empty per_person";
        }
      } catch (reportError2) {
        reportSource = "memo_first_fallback";
        reportError = getErrorMessage(synthError);
        reportBlockingReason = `analysis/synthesize failed: ${getErrorMessage(synthError)}, analysis/report fallback also failed: ${getErrorMessage(reportError2)}`;
        finalizeWarnings.push(reportBlockingReason);
      }
    }
    const reportMs = Date.now() - reportStart;
    backendTimeline.push(...reportTimeline);

    // ── Evidence namespace alignment ──
    // When report comes from legacy or memo_first fallback, the claim evidence_refs
    // reference legacy evidence IDs. Switch the evidence pack to match.
    if (reportSource === 'memo_first_fallback' || reportSource === 'memo_first' || reportSource === 'llm_enhanced' || reportSource === 'llm_failed') {
      evidence = legacyEvidence;
    }

    // ── Quality gate enforcement (new) ──
    const synthQualityGate = enforceQualityGates({
      perPerson: finalPerPerson,
      unknownRatio: computeUnknownRatio(transcript),
    });

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    // E5: Save stage checkpoint after report (LLM call complete, only persist remaining)
    await ctx.saveFinalizeStageCheckpoint(jobId, "report", {
      report_source: reportSource,
      report_model: reportModel,
      pipeline_mode: pipelineMode
    });

    await ctx.updateFinalizeV2Status(jobId, { stage: "persist", progress: 95 });
    await ctx.ensureFinalizeJobActive(jobId);
    const finalizedAt = ctx.currentIsoTs();
    const thresholdMeta: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(metadata ?? {})) {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") {
        thresholdMeta[key] = value;
      }
    }
    const captureByStream = state.capture_by_stream ?? defaultCaptureByStream();
    const qualityMetrics = ctx.buildQualityMetrics(transcript, captureByStream);
    const ingestP95Ms =
      typeof asrByStream.students.ingest_to_utterance_p95_ms === "number"
        ? asrByStream.students.ingest_to_utterance_p95_ms
        : null;
    const finalStrictValidation = ctx.validateClaimEvidenceRefs({
      evidence,
      per_person: finalPerPerson
    } as ResultV2);
    const qualityGateEvaluation = ctx.evaluateFeedbackQualityGates({
      unknownRatio: qualityMetrics.unknown_ratio,
      ingestP95Ms,
      claimValidationFailures: [
        ...(finalStrictValidation.failures ?? []),
        ...synthQualityGate.failures,
        ...(ACCEPTED_REPORT_SOURCES.has(reportSource) ? [] : [reportBlockingReason || "llm report unavailable"])
      ]
    });
    const finalTentative = confidenceLevel === "low" || !qualityGateEvaluation.passed;
    const quality: ReportQualityMeta = {
      ...memoFirstValidation.quality,
      generated_at: finalizedAt,
      build_ms: memoFirstBuildMs + reportMs,
      validation_ms: validationMs,
      claim_count: finalStrictValidation.claimCount,
      invalid_claim_count: finalStrictValidation.invalidCount,
      needs_evidence_count: finalStrictValidation.needsEvidenceCount,
      report_source: reportSource,
      report_model: reportModel,
      report_degraded: !ACCEPTED_REPORT_SOURCES.has(reportSource),
      report_error: reportError
    };
    const qualityGateSnapshot = {
      finalize_success_target: 0.995,
      students_unknown_ratio_target: 0.25,
      sv_top1_target: 0.9,
      echo_reduction_target: 0.8,
      observed_unknown_ratio: qualityMetrics.unknown_ratio,
      observed_students_turns: qualityMetrics.students_utterance_count,
      observed_students_unknown: qualityMetrics.students_unknown_count,
      observed_echo_suppressed_chunks: qualityMetrics.echo_suppressed_chunks,
      observed_echo_recent_rate: qualityMetrics.echo_suppression_recent_rate,
      observed_echo_leak_rate: qualityMetrics.echo_leak_rate,
      observed_suppression_false_positive_rate: qualityMetrics.suppression_false_positive_rate
    };
    const resultV2 = buildResultV2({
      sessionId,
      finalizedAt,
      tentative: finalTentative,
      confidenceLevel,
      unresolvedClusterCount,
      diarizationBackend,
      captionSource: ctx.getCaptionSource(),
      transcript,
      speakerLogs,
      stats,
      memos,
      evidence,
      overall: finalOverall,
      perPerson: finalPerPerson,
      quality,
      finalizeJobId: jobId,
      modelVersions: {
        asr: asrByStream.students.model,
        analysis_events_path: ctx.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
        analysis_report_path: ctx.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
        analysis_synthesize_path: ctx.env.INFERENCE_SYNTHESIZE_PATH ?? "/analysis/synthesize",
        summary_mode: pipelineMode
      },
      thresholds: {
        sv_t_low: 0.45,
        sv_t_high: 0.70,
        tentative: finalTentative,
        unresolved_cluster_count: unresolvedClusterCount,
        diarization_backend: diarizationBackend,
        finalize_timeout_ms: timeoutMs,
        feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
        feedback_events_budget_ms: FEEDBACK_EVENTS_BUDGET_MS,
        feedback_report_budget_ms: FEEDBACK_REPORT_BUDGET_MS,
        feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
        feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        ...thresholdMeta
      },
      backendTimeline,
      qualityGateSnapshot,
      reportPipeline: {
        mode: pipelineMode,
        source: reportSource,
        llm_attempted: llmAttempted,
        llm_success: llmSuccess,
        llm_elapsed_ms: llmElapsedMs ?? reportMs,
        blocking_reason: reportBlockingReason
      },
      qualityGateFailures: qualityGateEvaluation.failures
    });

    const resultV2Key = resultObjectKeyV2(sessionId);
    await ctx.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
      httpMetadata: { contentType: "application/json" }
    });
    const historyItem: HistoryIndexItem = {
      session_id: sessionId,
      finalized_at: finalizedAt,
      tentative: Boolean(resultV2.session.tentative),
      unresolved_cluster_count: Number(resultV2.session.unresolved_cluster_count || 0),
      ready: Boolean(
        ACCEPTED_REPORT_SOURCES.has(resultV2.quality.report_source ?? "")
        && resultV2.quality.needs_evidence_count === 0
      ),
      needs_evidence_count: Number(resultV2.quality.needs_evidence_count || 0),
      report_source: resultV2.quality.report_source ?? "memo_first"
    };
    const historyKey = historyObjectKey(sessionId, Date.parse(finalizedAt));
    await ctx.env.RESULT_BUCKET.put(historyKey, JSON.stringify(historyItem), {
      httpMetadata: { contentType: "application/json" }
    });
    await ctx.doCtx.storage.put(STORAGE_KEY_RESULT_KEY_V2, resultV2Key);
    await ctx.doCtx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
    await ctx.doCtx.storage.put(STORAGE_KEY_UPDATED_AT, finalizedAt);
    const cache = await ctx.loadFeedbackCache(sessionId);
    cache.updated_at = finalizedAt;
    cache.report = resultV2;
    cache.person_summary_cache = resultV2.per_person;
    cache.overall_summary_cache = resultV2.overall;
    cache.evidence_index_cache = ctx.buildEvidenceIndex(resultV2.per_person);
    cache.quality = resultV2.quality;
    cache.timings = {
      assemble_ms: memoFirstBuildMs,
      events_ms: 0,
      report_ms: reportMs,
      validation_ms: validationMs,
      persist_ms: 0,
      total_ms: 0
    };
    cache.report_source = resultV2.quality.report_source ?? "memo_first";
    cache.quality_gate_passed =
      ACCEPTED_REPORT_SOURCES.has(cache.report_source)
      && resultV2.quality.needs_evidence_count === 0;
    cache.blocking_reason = cache.quality_gate_passed
      ? null
      : (resultV2.trace.quality_gate_failures?.[0] ?? "feedback quality gate failed");
    cache.ready = cache.quality_gate_passed;
    await ctx.storeFeedbackCache(cache);

    if (abortController.signal.aborted) {
      throw new Error("Finalization aborted: global timeout exceeded");
    }

    await ctx.updateFinalizeV2Status(jobId, {
      status: "succeeded",
      stage: "persist",
      progress: 100,
      finished_at: finalizedAt,
      errors: [],
      warnings: finalizeWarnings,
      degraded: finalizeDegraded,
      backend_used: finalizeBackendUsed
    });
    // E6: Transition to finalized phase
    await ctx.setSessionPhase("finalized");
    // E5: Clear stage checkpoint on success — no longer needed
    await ctx.clearFinalizeStageCheckpoint();

    // ── D1: persist session metadata + dimension scores (non-blocking) ──
    if (ctx.env.DB) {
      persistSessionToD1(ctx.env.DB, sessionId, resultV2, resultV2Key).catch(err => {
        log("warn", "finalize-v2: D1 persist failed (non-blocking)", { component: "finalize-v2", session_id: sessionId, error: getErrorMessage(err) });
      });
    }

    // ── Async: generate improvement suggestions (non-blocking) ──
    ctx.triggerImprovementGeneration(sessionId, resultV2, transcript, resultV2Key).catch(err => {
      log("warn", "finalize-v2: improvements generation failed (non-blocking)", { component: "finalize-v2", session_id: sessionId, error: getErrorMessage(err) });
    });

    // ── Incremental finalize: if V1 increments were processed during recording, use them ──
    let incrementalFinalizeSucceeded = false;
    const incrementalStatusForFinalize = await ctx.loadIncrementalStatus();
    if (incrementalV1Enabled(ctx.env) && incrementalStatusForFinalize.increments_completed > 0) {
      try {
        // ── 消灭大尾巴 — 检查未处理的尾部音频 ──
        {
          const ingestForTail = await ctx.loadIngestByStream(sessionId);
          const totalAudioMs = ingestForTail.mixed.received_chunks * 1000;
          const lastProcessedMs = incrementalStatusForFinalize.last_processed_ms;
          const tailGapMs = totalAudioMs - lastProcessedMs;

          if (tailGapMs > 30_000) {
            log("info", "incremental-v1: tail gap detected, running tail chunk", { sessionId, action: "incremental", tailGapMs, totalAudioMs, lastProcessedMs });
            // 运行一次额外的 process-chunk 来覆盖尾部音频
            try {
              await ctx.runIncrementalJob(sessionId);
            } catch (tailErr) {
              log("warn", "incremental-v1: tail chunk failed (non-fatal)", { sessionId, action: "incremental", error: getErrorMessage(tailErr) });
            }
          }
        }

        const finalizeNameAliases = ((state.config ?? {}) as Record<string, unknown>).name_aliases as Record<string, string[]> | undefined;
        incrementalFinalizeSucceeded = await ctx.runIncrementalFinalize(
          sessionId,
          memos,
          stats,
          evidence,
          locale,
          finalizeNameAliases ?? {}
        );
        if (incrementalFinalizeSucceeded) {
          log("info", "finalize-v2: incremental finalize used as primary, skipping tier2", { component: "finalize-v2", session_id: sessionId });
        } else {
          log("warn", "finalize-v2: incremental finalize failed, falling back to tier2", { component: "finalize-v2", session_id: sessionId });
        }
      } catch (incFinalizeErr) {
        log("warn", "finalize-v2: incremental finalize threw (non-fatal)", { component: "finalize-v2", error: getErrorMessage(incFinalizeErr) });
      }
    }

    // ── Tier 2 background trigger ──
    // After Tier 1 succeeds, check if Tier 2 batch re-processing is enabled.
    // Skip Tier 2 if incremental finalize already succeeded.
    // If so, schedule a DO alarm to run the Tier 2 job asynchronously.
    if (!incrementalFinalizeSucceeded && ctx.tier2Enabled() && ctx.tier2AutoTrigger()) {
      try {
        const tier2: Tier2Status = {
          enabled: true,
          status: "pending",
          started_at: null,
          completed_at: null,
          error: null,
          report_version: "tier1_instant",
          progress: 0,
          warnings: []
        };
        await ctx.storeTier2Status(tier2);
        // Schedule alarm for 2 seconds from now to start Tier 2
        const tag = `tier2_${sessionId}_${Date.now()}`;
        await ctx.doCtx.storage.put(STORAGE_KEY_TIER2_ALARM_TAG, tag);
        await ctx.doCtx.storage.setAlarm(Date.now() + 2_000);
        log("info", "finalize-v2: tier2 scheduled", { sessionId, action: "tier2" });
      } catch (tier2ScheduleErr) {
        log("warn", "finalize-v2: failed to schedule tier2 (non-fatal)", { sessionId, action: "tier2", error: getErrorMessage(tier2ScheduleErr) });
      }
    }
  } catch (error) {
    const message = getErrorMessage(error);
    const current = await ctx.loadFinalizeV2Status();
    if (current && current.job_id === jobId && !ctx.isFinalizeTerminal(current.status)) {
      await ctx.updateFinalizeV2Status(jobId, {
        status: "failed",
        stage: "persist",
        progress: 100,
        finished_at: ctx.currentIsoTs(),
        errors: [...current.errors, message],
        warnings: [...current.warnings, ...finalizeWarnings],
        degraded: true,
        backend_used: current.backend_used
      });
    }
  } finally {
    clearTimeout(globalTimer);
    await ctx.setFinalizeLock(false);
  }
}


// ── Improvement generation (async, non-blocking) ─────────────────────────

export async function triggerImprovementGenerationImpl(
  sessionId: string,
  resultV2: ResultV2,
  transcript: Array<{ utterance_id: string; speaker_name?: string | null; text: string; start_ms: number; end_ms: number; duration_ms: number }>,
  resultV2Key: string,
  ctx: ImprovementContext
): Promise<void> {
  const inferenceBase = (ctx.env.INFERENCE_BASE_URL ?? "").trim() || "http://127.0.0.1:8000";
  const apiKey = (ctx.env.INFERENCE_API_KEY ?? "").trim();

  const sessionContext = (await ctx.doCtx.storage.get("session_context")) as SessionContextMeta | undefined;
  const dimensionPresets = sessionContext?.dimension_presets ?? [];

  const reportJson = JSON.stringify({
    overall: resultV2.overall,
    per_person: resultV2.per_person,
    evidence: resultV2.evidence,
  });

  const body = JSON.stringify({
    session_id: sessionId,
    report_json: reportJson,
    transcript: transcript.slice(0, 50).map(u => ({
      utterance_id: u.utterance_id,
      speaker_name: u.speaker_name ?? "Unknown",
      text: u.text,
      start_ms: u.start_ms,
      end_ms: u.end_ms,
      duration_ms: u.duration_ms,
    })),
    interview_language: "en",
    dimension_presets: dimensionPresets.map(d => ({
      key: d.key,
      label_zh: d.label_zh,
      description: d.description,
    })),
  });

  const resp = await fetch(`${inferenceBase}/analysis/improvements`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(120_000),
  });

  if (!resp.ok) {
    throw new Error(`improvements API returned ${resp.status}`);
  }

  const data = await resp.json() as { improvements: ImprovementReport };

  // Merge improvements into resultV2 and re-persist
  resultV2.improvements = data.improvements;
  await ctx.env.RESULT_BUCKET.put(resultV2Key, JSON.stringify(resultV2), {
    httpMetadata: { contentType: "application/json" },
  });

  // Update feedback cache
  const cache = await ctx.loadFeedbackCache(sessionId);
  if (cache.report) {
    (cache.report as ResultV2).improvements = data.improvements;
    await ctx.storeFeedbackCache(cache);
  }

  log("info", "finalize-v2: improvements generated", { component: "finalize-v2", session_id: sessionId });
}