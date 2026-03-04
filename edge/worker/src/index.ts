import { DurableObject } from "cloudflare:workers";
import { runFunAsrDashScope as runFunAsrDashScopeFn } from "./dashscope-asr";
import {
  buildMultiEvidence,
  buildReportExportMarkdown,
  buildReportExportText,
  computeSpeakerStats,
  validatePersonFeedbackEvidence
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { filterMemos, nextMemoId, parseMemoPayload } from "./memos";
import { mergeSpeakerLogs, parseSpeakerLogsPayload } from "./speaker_logs";
import {
  InferenceFailoverClient,
  type DependencyHealthSnapshot,
  type InferenceBackendTimelineItem,
  type InferenceEndpointKey
} from "./inference_client";
import {
  decodeBase64ToBytes,
  bytesToBase64,
  concatUint8Arrays,
  pcm16ToWavBytes,
  buildDocxBytesFromText,
  TARGET_SAMPLE_RATE,
  TARGET_CHANNELS,
  ONE_SECOND_PCM_BYTES
} from "./audio-utils";
import {
  buildReconciledTranscript,
  resolveStudentBinding
} from "./reconcile";
import { EmbeddingCache } from "./embedding-cache";
import type { CaptionEvent } from "./providers/types";
import { LocalWhisperASRProvider } from "./providers/asr-local-whisper";
import type {
  CheckpointRequestPayload,
  CheckpointResult,
  FinalizeV2Status,
  FinalizeStageCheckpoint,
  IncrementalStatus,
  IncrementalSpeakerProfile,
  SessionPhase,
  StoredUtterance,
  MemoItem,
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
  OverallFeedback
} from "./types_v2";
import {
  shouldScheduleIncremental,
} from "./incremental";

import {
  runIncrementalJob as runIncrementalJobFn,
  runIncrementalFinalize as runIncrementalFinalizeFn,
  type IncrementalContext,
  type IncrementalFinalizeContext
} from "./incremental-processor";

import {
  loadIngestByStream as loadIngestByStreamFn,
  storeIngestByStream as storeIngestByStreamFn,
  loadAsrByStream as loadAsrByStreamFn,
  storeAsrByStream as storeAsrByStreamFn,
  loadUtterancesRawByStream as loadUtterancesRawByStreamFn,
  storeUtterancesRawByStream as storeUtterancesRawByStreamFn,
  loadUtterancesMergedByStream as loadUtterancesMergedByStreamFn,
  storeUtterancesMergedByStream as storeUtterancesMergedByStreamFn,
  loadSpeakerEvents as loadSpeakerEventsFn,
  storeSpeakerEvents as storeSpeakerEventsFn,
  appendSpeakerEvent as appendSpeakerEventFn,
  storeDependencyHealth as storeDependencyHealthFn,
  loadDependencyHealth as loadDependencyHealthFn,
  loadAsrCursorByStream as loadAsrCursorByStreamFn,
  patchAsrCursor as patchAsrCursorFn,
  loadMemos as loadMemosFn,
  storeMemos as storeMemosFn,
  loadSpeakerLogs as loadSpeakerLogsFn,
  storeSpeakerLogs as storeSpeakerLogsFn,
  loadFeedbackCache as loadFeedbackCacheFn,
  storeFeedbackCache as storeFeedbackCacheFn,
  loadFinalizeV2Status as loadFinalizeV2StatusFn,
  storeFinalizeV2Status as storeFinalizeV2StatusFn,
  setFinalizeLock as setFinalizeLockFn,
  isFinalizeLocked as isFinalizeLockedFn,
  loadSessionPhase as loadSessionPhaseFn,
  setSessionPhase as setSessionPhaseFn,
  resetSessionPhase as resetSessionPhaseFn,
  loadFinalizeStageCheckpoint as loadFinalizeStageCheckpointFn,
  saveFinalizeStageCheckpoint as saveFinalizeStageCheckpointFn,
  clearFinalizeStageCheckpoint as clearFinalizeStageCheckpointFn,
  defaultTier2Status as defaultTier2StatusFn,
  loadTier2Status as loadTier2StatusFn,
  storeTier2Status as storeTier2StatusFn,
  updateTier2Status as updateTier2StatusFn,
  loadIncrementalStatus as loadIncrementalStatusFn,
  storeIncrementalStatus as storeIncrementalStatusFn,
  updateIncrementalStatus as updateIncrementalStatusFn,
  scheduleIncrementalAlarm as scheduleIncrementalAlarmFn,
  loadCheckpoints as loadCheckpointsFn,
  storeCheckpoints as storeCheckpointsFn,
  loadLastCheckpointAt as loadLastCheckpointAtFn,
  storeLastCheckpointAt as storeLastCheckpointAtFn
} from "./session-manager";
import {
  type WsHandlerContext,
  handleWebSocketUpgrade
} from "./websocket-handler";

import { handleWorkerFetch } from "./router";
import {
  runTier2Job as runTier2JobFn,
  tier2Enabled as tier2EnabledFn,
  tier2AutoTrigger as tier2AutoTriggerFn,
  tier2BatchEndpoint as tier2BatchEndpointFn,
  isTier2Terminal as isTier2TerminalFn,
  type Tier2Context
} from "./tier2-processor";
import {
  runFinalizeV2Job as runFinalizeV2JobFn,
  triggerImprovementGenerationImpl,
  type FinalizeJobContext,
} from "./finalize-orchestrator";
import {
  maybeRefreshFeedbackCache as maybeRefreshFeedbackCacheFn,
  type FeedbackCacheRefreshContext,
} from "./feedback-cache-refresh";
import {
  callInferenceWithFailover as callInferenceWithFailoverFn,
  invokeInferenceResolve as invokeInferenceResolveFn,
  invokeInferenceEnroll as invokeInferenceEnrollFn,
  invokeInferenceAnalysisEvents as invokeInferenceAnalysisEventsFn,
  invokeInferenceAnalysisReport as invokeInferenceAnalysisReportFn,
  invokeInferenceSynthesizeReport as invokeInferenceSynthesizeReportFn,
  invokeInferenceCheckpoint as invokeInferenceCheckpointFn,
  invokeInferenceMergeCheckpoints as invokeInferenceMergeCheckpointsFn,
  invokeInferenceRegenerateClaim as invokeInferenceRegenerateClaimFn,
  invokeInferenceExtractEmbedding as invokeInferenceExtractEmbeddingFn,
  type InferenceCallContext
} from "./inference-helpers";
import {
  currentRealtimeWsState as currentRealtimeWsStateFn,
  refreshAsrStreamMetrics as refreshAsrStreamMetricsFn,
  closeRealtimeAsrSession as closeRealtimeAsrSessionFn,
  hydrateRuntimeFromCursor as hydrateRuntimeFromCursorFn,
  enqueueRealtimeChunk as enqueueRealtimeChunkFn,
  replayGapFromR2 as replayGapFromR2Fn,
  loadChunkRange as loadChunkRangeFn,
  getAsrProvider as getAsrProviderFn,
  autoResolveStudentsUtterance as autoResolveStudentsUtteranceFn,
  maybeAutoEnrollStudentsUtterance as maybeAutoEnrollStudentsUtteranceFn,
  appendTeacherSpeakerEvent as appendTeacherSpeakerEventFn,
  emitRealtimeUtterance as emitRealtimeUtteranceFn,
  handleRealtimeAsrMessage as handleRealtimeAsrMessageFn,
  ensureRealtimeAsrConnected as ensureRealtimeAsrConnectedFn,
  drainRealtimeQueue as drainRealtimeQueueFn,
  maybeRunAsrWindows as maybeRunAsrWindowsFn,
  type RealtimeAsrContext,
} from "./realtime-asr-processor";

import {
  buildEvidenceIndex as buildEvidenceIndexFn,
  findClaimInReport as findClaimInReportFn,
  downWeightClaimConfidenceByEvidence as downWeightClaimConfidenceByEvidenceFn,
  sanitizeClaimEvidenceRefs as sanitizeClaimEvidenceRefsFn,
  validateClaimEvidenceRefs as validateClaimEvidenceRefsFn,
  evaluateFeedbackQualityGates as evaluateFeedbackQualityGatesFn,
  mergeStatsWithRoster as mergeStatsWithRosterFn,
  confidenceBucketFromEvidence as confidenceBucketFromEvidenceFn,
  echoLeakRate as echoLeakRateFn,
  suppressionFalsePositiveRate as suppressionFalsePositiveRateFn,
  buildQualityMetrics as buildQualityMetricsFn,
  speechBackendMode as speechBackendModeFn
} from "./feedback-helpers";
import {
  resolveTeacherIdentity as resolveTeacherIdentityFn,
  deriveSpeakerLogsFromTranscript as deriveSpeakerLogsFromTranscriptFn,
  buildEdgeSpeakerLogsForFinalize as buildEdgeSpeakerLogsForFinalizeFn,
  deriveMixedCaptureState as deriveMixedCaptureStateFn
} from "./speaker-helpers";
import {
  scoreNumber as scoreNumberFn,
  participantProgressFromProfiles as participantProgressFromProfilesFn,
  refreshEnrollmentMode as refreshEnrollmentModeFn,
  rosterNameByCandidate as rosterNameByCandidateFn,
  inferParticipantFromText as inferParticipantFromTextFn,
  updateUnassignedEnrollmentByCluster as updateUnassignedEnrollmentByClusterFn
} from "./enrollment-helpers";
import {
  isAsrEnabled as isAsrEnabledFn,
  asrRealtimeEnabled as asrRealtimeEnabledFn,
  asrDebugEnabled as asrDebugEnabledFn,
  buildDefaultAsrState as buildDefaultAsrStateFn,
  sanitizeAsrState as sanitizeAsrStateFn,
  defaultAsrByStream as defaultAsrByStreamFn,
  emptyAsrCursorByStream as emptyAsrCursorByStreamFn,
  buildRealtimeRuntime as buildRealtimeRuntimeFn,
  sendWsJson as sendWsJsonFn,
  sendWsError as sendWsErrorFn
} from "./asr-helpers";
import {
  incrementalV1Enabled,
  type StreamRole,
  STREAM_ROLES,
  type AudioPayload,
  type RosterEntry,
  type ResolveRequest,
  type ClusterState,
  type ParticipantProfile,
  type BindingMeta,
  type EnrollmentParticipantProgress,
  type EnrollmentUnassignedProgress,
  type EnrollmentState,
  type SessionState,
  type SessionConfigRequest,
  type CaptureState,
  type ResolveEvidence,
  type ResolveResponse,
  type SpeakerEvent,
  type EnrollmentStartRequest,
  type ClusterMapRequest,
  type InferenceEnrollRequest,
  type InferenceEnrollResponse,
  type FinalizeRequest,
  type FeedbackRegenerateClaimRequest,
  type FeedbackClaimEvidenceRequest,
  type InferenceRegenerateClaimRequest,
  type InferenceRegenerateClaimResponse,
  type FeedbackExportRequest,
  type IngestState,
  type UtteranceRaw,
  type UtteranceMerged,
  type FeedbackTimings,
  type FeedbackCache,
  type QualityMetrics,
  type HistoryIndexItem,
  type AsrState,
  type AsrRunResult,
  type AsrReplayCursor,
  type AsrQueueChunk,
  type AsrRealtimeRuntime,
  type AudioChunkFrame,
  type Env,
  DEFAULT_STATE,
  emptyReportQualityMeta,
  emptyFeedbackCache,
  SESSION_ROUTE_REGEX,
  SESSION_ENROLL_ROUTE_REGEX,
  SESSION_FINALIZE_STATUS_ROUTE_REGEX,
  SESSION_TIER2_STATUS_ROUTE_REGEX,
  SESSION_INCREMENTAL_STATUS_ROUTE_REGEX,
  SESSION_HISTORY_ROUTE_REGEX,
  WS_INGEST_ROUTE_REGEX,
  WS_INGEST_ROLE_ROUTE_REGEX,
  STORAGE_KEY_STATE,
  STORAGE_KEY_UPDATED_AT,
  STORAGE_KEY_FINALIZED_AT,
  STORAGE_KEY_RESULT_KEY,
  STORAGE_KEY_RESULT_KEY_V2,
  STORAGE_KEY_FINALIZE_V2_STATUS,
  STORAGE_KEY_FINALIZE_LOCK,
  STORAGE_KEY_TIER2_ALARM_TAG,
  STORAGE_KEY_INCREMENTAL_STATUS,
  STORAGE_KEY_INCREMENTAL_ALARM_TAG,
  STORAGE_KEY_MEMOS,
  STORAGE_KEY_SPEAKER_LOGS,
  STORAGE_KEY_ASR_CURSOR_BY_STREAM,
  STORAGE_KEY_FEEDBACK_CACHE,
  STORAGE_KEY_DEPENDENCY_HEALTH,
  STORAGE_KEY_INGEST_STATE,
  STORAGE_KEY_ASR_STATE,
  STORAGE_KEY_UTTERANCES_RAW,
  STORAGE_KEY_INGEST_BY_STREAM,
  STORAGE_KEY_ASR_BY_STREAM,
  STORAGE_KEY_UTTERANCES_RAW_BY_STREAM,
  STORAGE_KEY_UTTERANCES_MERGED_BY_STREAM,
  STORAGE_KEY_CHECKPOINTS,
  STORAGE_KEY_LAST_CHECKPOINT_AT,
  STORAGE_KEY_CAPTION_SOURCE,
  STORAGE_KEY_CAPTION_BUFFER,
  TARGET_FORMAT,
  INFERENCE_MAX_AUDIO_SECONDS,
  FEEDBACK_TOTAL_BUDGET_MS,
  HISTORY_PREFIX,
  HISTORY_MAX_LIMIT,
  HISTORY_REVERSE_EPOCH_MAX,
  R2_LIST_LIMIT,
  ACCEPTED_REPORT_SOURCES,
  getErrorMessage,
  calcTranscriptDurationMs,
  jsonResponse,
  badRequest,
  normalizeBaseUrl,
  safeSessionId,
  safeObjectSegment,
  parseStreamRole,
  resultObjectKey,
  resultObjectKeyV2,
  historyObjectKey,
  chunkObjectKey,
  readJson,
  parseTimeoutMs,
  parsePositiveInt,
  parseBool,
  getSessionLocale,
  isWebSocketRequest,
  sleep,
  levenshteinDistance,
  toWebSocketHandshakeUrl,
  extractFirstString,
  extractBooleanByKeys,
  extractNumberByKeys,
  extractNameFromText,
  parseRosterEntries,
  normalizeTextForMerge,
  tokenizeForMerge,
  tokenOverlapSuffixPrefix,
  computeTokenJaccard,
  stitchTextByTokenOverlap,
  mergeUtterances,
  quantile,
  parseChunkFrame,
  parseCaptureStatusPayload,
  identitySourceFromBindingSource,
  buildIngestState,
  ingestStatusPayload,
  valueAsString,
  buildDefaultCaptureState,
  buildDefaultEnrollmentState,
  defaultCaptureByStream,
  sanitizeCaptureState,
  normalizeSessionState,
  emptyIngestByStream,
  emptyUtterancesRawByStream,
  emptyUtterancesMergedByStream,
  log,
  DEFAULT_DATA_RETENTION_DAYS,
  STORAGE_KEY_SESSION_PHASE,
  transitionSessionPhase
} from "./config";


export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleWorkerFetch(request, env);
  }
};


export class MeetingSessionDO extends DurableObject<Env> {
  private mutationQueue: Promise<void> = Promise.resolve();
  private asrProcessingByStream: Record<StreamRole, boolean> = {
    mixed: false,
    teacher: false,
    students: false
  };
  private asrRealtimeByStream: Record<StreamRole, AsrRealtimeRuntime>;
  private inferenceClient: InferenceFailoverClient;
  private localWhisperProvider: LocalWhisperASRProvider | null = null;
  /** Embedding cache for global speaker clustering at finalization. */
  readonly embeddingCache: EmbeddingCache = new EmbeddingCache();
  /** Buffer for ACS Teams caption events. Public to satisfy WsHandlerContext. */
  captionBuffer: CaptionEvent[] = [];
  private captionFlushPending = 0;        // count of un-flushed captions
  private captionFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly CAPTION_FLUSH_BATCH = 10;
  private readonly CAPTION_FLUSH_INTERVAL_MS = 5_000;
  private readonly CAPTION_BUFFER_MAX = 2000;
  /** Caption data source for this session. Public to satisfy WsHandlerContext. */
  captionSource: CaptionSource = 'none';
  /** Session start time in epoch ms, set on first "hello". 0 = not yet initialized.
   *  NOTE: In-memory only — does not survive DO eviction. Acceptable for active sessions.
   *  Public to satisfy WsHandlerContext. */
  sessionStartMs: number = 0;

  /** Get the caption buffer for finalization. */
  getCaptionBuffer(): CaptionEvent[] {
    return this.captionBuffer;
  }

  /** Flush captionBuffer to DO storage (batched: 10 items or 5s, whichever first). */
  private flushCaptionBuffer(): void {
    if (this.captionFlushTimer) {
      clearTimeout(this.captionFlushTimer);
      this.captionFlushTimer = null;
    }
    const toStore = this.captionBuffer.length > this.CAPTION_BUFFER_MAX
      ? this.captionBuffer.slice(-this.CAPTION_BUFFER_MAX)
      : this.captionBuffer;
    this.ctx.storage.put(STORAGE_KEY_CAPTION_BUFFER, toStore).catch((err) => {
      log("warn", "caption-persist flush failed", { component: "caption-persist", error: getErrorMessage(err) });
    });
    this.captionFlushPending = 0;
  }

  /** Schedule a batched flush: immediately if batch size reached, else after interval. */
  scheduleCaptionFlush(): void {
    this.captionFlushPending++;
    if (this.captionFlushPending >= this.CAPTION_FLUSH_BATCH) {
      this.flushCaptionBuffer();
      return;
    }
    if (!this.captionFlushTimer) {
      this.captionFlushTimer = setTimeout(() => {
        this.captionFlushTimer = null;
        this.flushCaptionBuffer();
      }, this.CAPTION_FLUSH_INTERVAL_MS);
    }
  }

  /** Get the current caption source mode. */
  getCaptionSource(): CaptionSource {
    return this.captionSource;
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.asrRealtimeByStream = {
      mixed: this.buildRealtimeRuntime("mixed"),
      teacher: this.buildRealtimeRuntime("teacher"),
      students: this.buildRealtimeRuntime("students")
    };
    const primaryBaseUrl = normalizeBaseUrl((env.INFERENCE_BASE_URL_PRIMARY ?? env.INFERENCE_BASE_URL ?? "").trim());
    if (!primaryBaseUrl) {
      throw new Error("INFERENCE_BASE_URL or INFERENCE_BASE_URL_PRIMARY must be configured");
    }
    const secondaryRaw = normalizeBaseUrl((env.INFERENCE_BASE_URL_SECONDARY ?? "").trim());
    this.inferenceClient = new InferenceFailoverClient({
      primaryBaseUrl,
      secondaryBaseUrl: secondaryRaw || null,
      failoverEnabled: parseBool(env.INFERENCE_FAILOVER_ENABLED, true),
      apiKey: (env.INFERENCE_API_KEY ?? "").trim() || undefined,
      timeoutMs: parseTimeoutMs(env.INFERENCE_TIMEOUT_MS),
      retryMax: Math.max(0, Math.min(5, parsePositiveInt(env.INFERENCE_RETRY_MAX, 2))),
      retryBackoffMs: Math.max(50, parsePositiveInt(env.INFERENCE_RETRY_BACKOFF_MS, 180)),
      circuitOpenMs: Math.max(1_000, parsePositiveInt(env.INFERENCE_CIRCUIT_OPEN_MS, 15_000)),
      now: () => this.currentIsoTs()
    });
  }

  async alarm(): Promise<void> {
    await this.enqueueMutation(async () => {
      // Check if this alarm is for incremental processing (during recording)
      const incrementalTag = await this.ctx.storage.get<string>(STORAGE_KEY_INCREMENTAL_ALARM_TAG);
      if (incrementalTag) {
        await this.ctx.storage.delete(STORAGE_KEY_INCREMENTAL_ALARM_TAG);
        const incrementalStatus = await this.loadIncrementalStatus();
        if (incrementalStatus.status === "recording" || incrementalStatus.status === "idle") {
          const sessionId = await this.resolveSessionIdForIncremental();
          if (sessionId) {
            // Run non-fatally: a failed increment should not crash the alarm handler
            await this.runIncrementalJob(sessionId).catch((err) => {
              log("warn", "incremental: alarm job failed (non-fatal)", { component: "incremental", error: getErrorMessage(err) });
            });
          }
          return; // Incremental alarm handled; do not run stuck-finalize or cleanup
        }
      }

      // Check if this alarm is for Tier 2 background processing
      const tier2Tag = await this.ctx.storage.get<string>(STORAGE_KEY_TIER2_ALARM_TAG);
      if (tier2Tag) {
        await this.ctx.storage.delete(STORAGE_KEY_TIER2_ALARM_TAG);
        const tier2Status = await this.loadTier2Status();
        if (tier2Status.status === "pending") {
          const sessionId = await this.resolveSessionId();
          await this.runTier2Job(sessionId);
          return; // Don't run other alarm tasks after tier2
        }
      }
      await this.failStuckFinalizeIfNeeded("alarm");
      await this.cleanupExpiredData();
    });
  }

  /** Resolve session ID when DO has not yet been finalized (during recording). */
  private async resolveSessionIdForIncremental(): Promise<string | null> {
    // Try the finalized result key first
    const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (resultKey) {
      const match = resultKey.match(/sessions\/([^/]+)\//);
      if (match) return match[1];
    }
    // Fall back to the incremental status started_at tag stored by scheduleIncrementalAlarm
    const tag = await this.ctx.storage.get<string>("incremental_session_id");
    return typeof tag === "string" && tag ? tag : null;
  }

  private async resolveSessionId(): Promise<string> {
    // Derive session ID from the stored result key (set during Tier 1 finalization)
    const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (resultKey) {
      const match = resultKey.match(/sessions\/([^/]+)\//);
      if (match) return match[1];
    }
    return "unknown-session";
  }

  private async cleanupExpiredData(): Promise<void> {
    const finalizedAt = await this.ctx.storage.get<string>(STORAGE_KEY_FINALIZED_AT);
    if (!finalizedAt) return;

    const ageMs = Date.now() - new Date(finalizedAt).getTime();
    const audioRetentionMs = (Number(this.env.AUDIO_RETENTION_HOURS) || 72) * 3600 * 1000;
    const dataRetentionMs = DEFAULT_DATA_RETENTION_DAYS * 24 * 3600 * 1000;

    const resultKey = await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2);
    if (!resultKey) return;
    const sessionPrefix = resultKey.replace(/\/result_v2\.json$/, "");

    // Phase 1: Delete audio chunks after AUDIO_RETENTION_HOURS
    if (ageMs > audioRetentionMs) {
      const sessionId = sessionPrefix.replace(/^sessions\//, "");
      const chunksPrefix = `chunks/${sessionId}/`;
      let cursor: string | undefined;
      let deletedCount = 0;
      do {
        const listing = await this.env.RESULT_BUCKET.list({ prefix: chunksPrefix, cursor, limit: R2_LIST_LIMIT });
        if (listing.objects.length > 0) {
          await Promise.all(listing.objects.map((obj) => this.env.RESULT_BUCKET.delete(obj.key)));
          deletedCount += listing.objects.length;
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);
      if (deletedCount > 0) {
        log("info", "cleanup: deleted expired audio chunks", { component: "cleanup", deleted_count: deletedCount, prefix: chunksPrefix });
      }
    }

    // Phase 2: Full GDPR purge after DATA_RETENTION_DAYS (30 days default)
    if (ageMs > dataRetentionMs) {
      let r2Count = 0;
      let cursor: string | undefined;
      do {
        const listing = await this.env.RESULT_BUCKET.list({ prefix: `${sessionPrefix}/`, cursor, limit: R2_LIST_LIMIT });
        if (listing.objects.length > 0) {
          await Promise.all(listing.objects.map((obj) => this.env.RESULT_BUCKET.delete(obj.key)));
          r2Count += listing.objects.length;
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);

      const safeId = sessionPrefix.replace(/^sessions\//, "");
      const historySuffix = `_${safeId}.json`;
      cursor = undefined;
      do {
        const listing = await this.env.RESULT_BUCKET.list({ prefix: HISTORY_PREFIX, cursor, limit: R2_LIST_LIMIT });
        const matching = listing.objects.filter((obj) => obj.key.endsWith(historySuffix));
        if (matching.length > 0) {
          await Promise.all(matching.map((obj) => this.env.RESULT_BUCKET.delete(obj.key)));
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);

      // E6: Transition to archived before wipe (for audit log purposes)
      await this.setSessionPhase("archived");
      await this.ctx.storage.deleteAll();
      log("info", "cleanup: GDPR retention expired, all session data purged", {
        component: "cleanup", session_prefix: sessionPrefix, r2_objects: r2Count, retention_days: DEFAULT_DATA_RETENTION_DAYS
      });
    }
  }

  asrRealtimeEnabled(): boolean {
    return asrRealtimeEnabledFn(this.env);
  }

  async enqueueMutation<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(fn);
    this.mutationQueue = run.then(
      () => undefined,
      (err) => {
        log("error", "enqueueMutation: queued operation failed", { component: "mutation-queue", error: getErrorMessage(err) });
        return undefined;
      }
    );
    return run;
  }

  private asrDebugEnabled(): boolean {
    return asrDebugEnabledFn(this.env);
  }

  private resolveAudioWindowSeconds(): number {
    const configured = parsePositiveInt(this.env.INFERENCE_RESOLVE_AUDIO_WINDOW_SECONDS, 6);
    return Math.max(1, Math.min(INFERENCE_MAX_AUDIO_SECONDS, configured));
  }

  private currentIsoTs(): string {
    return new Date().toISOString();
  }

  private memosEnabled(): boolean {
    return parseBool(this.env.MEMOS_ENABLED, true);
  }

  private finalizeV2Enabled(): boolean {
    return parseBool(this.env.FINALIZE_V2_ENABLED, false);
  }

  private finalizeTimeoutMs(): number {
    return parseTimeoutMs(this.env.FINALIZE_TIMEOUT_MS ?? "180000");
  }

  private finalizeWatchdogMs(): number {
    const configured = Number(this.env.FINALIZE_WATCHDOG_MS ?? "");
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }
    return Math.max(this.finalizeTimeoutMs() + 120_000, 240_000);
  }

  private diarizationBackendDefault(): "cloud" | "edge" {
    const val = this.env.DIARIZATION_BACKEND_DEFAULT;
    return val === "edge" || val === "local" ? "edge" : "cloud";
  }

  private scoreNumber(value: number | null | undefined): number {
    return scoreNumberFn(value);
  }

  private participantProgressFromProfiles(state: SessionState): Record<string, EnrollmentParticipantProgress> {
    return participantProgressFromProfilesFn(state);
  }

  private refreshEnrollmentMode(state: SessionState): void {
    refreshEnrollmentModeFn(state, this.currentIsoTs());
  }

  private rosterNameByCandidate(state: SessionState, candidate: string | null): string | null {
    return rosterNameByCandidateFn(state, candidate);
  }

  private inferParticipantFromText(state: SessionState, asrText: string): string | null {
    return inferParticipantFromTextFn(state, asrText);
  }

  private updateUnassignedEnrollmentByCluster(
    state: SessionState,
    clusterId: string | null | undefined,
    durationSeconds: number
  ): void {
    updateUnassignedEnrollmentByClusterFn(state, clusterId, durationSeconds, this.currentIsoTs());
  }

  private get inferenceCallCtx(): InferenceCallContext {
    return {
      inferenceClient: this.inferenceClient,
      env: this.env,
      storeDependencyHealth: (h) => this.storeDependencyHealth(h),
    };
  }

  private async callInferenceWithFailover<T>(params: {
    endpoint: InferenceEndpointKey;
    path: string;
    body: unknown;
    timeoutMs?: number;
  }) {
    return callInferenceWithFailoverFn<T>(this.inferenceCallCtx, params);
  }

  private async callInferenceEnroll(
    sessionId: string,
    participantName: string,
    audio: AudioPayload,
    state: SessionState
  ) {
    return invokeInferenceEnrollFn(this.inferenceCallCtx, sessionId, participantName, audio, state);
  }

  /**
   * Extract speaker embeddings for edge diarization turns and populate the cache.
   *
   * For each speaker turn with sufficient duration (>500ms), loads the corresponding
   * PCM audio from R2, calls the inference service's /sv/extract_embedding endpoint,
   * and stores the result in the EmbeddingCache for global clustering at finalization.
   *
   * Skips segments already in the cache (idempotent). Non-critical: failures are
   * logged but do not block the pipeline.
   */
  async extractEmbeddingsForTurns(
    sessionId: string,
    speakerLogs: SpeakerLogs,
    streamRole: "students" | "teacher" = "students"
  ): Promise<{ extracted: number; skipped: number; failed: number }> {
    const turns = speakerLogs.turns.filter(
      (t) => t.stream_role === streamRole
    );
    let extracted = 0;
    let skipped = 0;
    let failed = 0;

    for (const turn of turns) {
      const durationMs = turn.end_ms - turn.start_ms;
      if (durationMs < 500) { skipped++; continue; }

      const segmentId = `${streamRole}_${turn.turn_id}`;
      if (this.embeddingCache.getEmbedding(segmentId)) { skipped++; continue; }

      try {
        // Determine which R2 chunks cover this turn's time range
        const startSeq = Math.max(0, Math.floor(turn.start_ms / 1000));
        const endSeq = Math.ceil(turn.end_ms / 1000);
        const chunks = await this.loadChunkRange(sessionId, streamRole, startSeq, endSeq);
        if (chunks.length === 0) { skipped++; continue; }

        const pcmData = concatUint8Arrays(chunks);
        const wavBytes = pcm16ToWavBytes(pcmData, TARGET_SAMPLE_RATE, TARGET_CHANNELS);
        const audioPayload: AudioPayload = {
          content_b64: bytesToBase64(wavBytes),
          format: "wav",
          sample_rate: TARGET_SAMPLE_RATE,
          channels: TARGET_CHANNELS
        };

        const embeddingData = await invokeInferenceExtractEmbeddingFn(this.inferenceCallCtx, sessionId, audioPayload);

        const embedding = new Float32Array(embeddingData.embedding);
        const added = this.embeddingCache.addEmbedding({
          segment_id: segmentId,
          embedding,
          start_ms: turn.start_ms,
          end_ms: turn.end_ms,
          window_cluster_id: turn.cluster_id,
          stream_role: streamRole
        });
        if (added) { extracted++; } else { skipped++; }
      } catch {
        failed++;
      }
    }

    return { extracted, skipped, failed };
  }

  private buildRealtimeRuntime(streamRole: StreamRole): AsrRealtimeRuntime {
    return buildRealtimeRuntimeFn(streamRole);
  }

  sendWsJson(socket: WebSocket, payload: unknown): void {
    sendWsJsonFn(socket, payload);
  }

  sendWsError(socket: WebSocket, detail: string): void {
    sendWsErrorFn(socket, detail);
  }

  private asrEnabled(): boolean {
    return isAsrEnabledFn(this.env);
  }

  private buildDefaultAsrState(): AsrState {
    return buildDefaultAsrStateFn(this.env);
  }

  private sanitizeAsrState(current: AsrState): AsrState {
    return sanitizeAsrStateFn(current, this.env);
  }

  private defaultAsrByStream(): Record<StreamRole, AsrState> {
    return defaultAsrByStreamFn(this.env);
  }

  async loadIngestByStream(sessionId: string): Promise<Record<StreamRole, IngestState>> {
    return loadIngestByStreamFn(this.ctx.storage, sessionId);
  }

  private async storeIngestByStream(state: Record<StreamRole, IngestState>): Promise<void> {
    return storeIngestByStreamFn(this.ctx.storage, state);
  }

  private async loadAsrByStream(): Promise<Record<StreamRole, AsrState>> {
    return loadAsrByStreamFn(this.ctx.storage, this.env);
  }

  private async storeAsrByStream(state: Record<StreamRole, AsrState>): Promise<void> {
    return storeAsrByStreamFn(this.ctx.storage, state);
  }

  private async loadUtterancesRawByStream(): Promise<Record<StreamRole, UtteranceRaw[]>> {
    return loadUtterancesRawByStreamFn(this.ctx.storage);
  }

  private async storeUtterancesRawByStream(state: Record<StreamRole, UtteranceRaw[]>): Promise<void> {
    return storeUtterancesRawByStreamFn(this.ctx.storage, state);
  }

  private async loadUtterancesMergedByStream(): Promise<Record<StreamRole, UtteranceMerged[]>> {
    return loadUtterancesMergedByStreamFn(this.ctx.storage);
  }

  private async storeUtterancesMergedByStream(state: Record<StreamRole, UtteranceMerged[]>): Promise<void> {
    return storeUtterancesMergedByStreamFn(this.ctx.storage, state);
  }

  private async loadSpeakerEvents(): Promise<SpeakerEvent[]> {
    return loadSpeakerEventsFn(this.ctx.storage);
  }

  private async storeDependencyHealth(health: DependencyHealthSnapshot): Promise<void> {
    return storeDependencyHealthFn(this.ctx.storage, health);
  }

  private async loadDependencyHealth(): Promise<DependencyHealthSnapshot> {
    return loadDependencyHealthFn(this.ctx.storage, this.inferenceClient.snapshot());
  }

  private confidenceBucketFromEvidence(evidence: ResolveEvidence | null | undefined): "high" | "medium" | "low" | "unknown" {
    return confidenceBucketFromEvidenceFn(evidence);
  }

  private echoLeakRate(transcript: TranscriptItem[]): number {
    return echoLeakRateFn(transcript);
  }

  private suppressionFalsePositiveRate(
    transcript: TranscriptItem[],
    captureByStream: Record<StreamRole, CaptureState>
  ): number {
    return suppressionFalsePositiveRateFn(transcript, captureByStream);
  }

  private buildQualityMetrics(
    transcript: TranscriptItem[],
    captureByStream: Record<StreamRole, CaptureState>
  ): QualityMetrics {
    return buildQualityMetricsFn(transcript, captureByStream);
  }

  private speechBackendMode(
    state: SessionState,
    dependencyHealth: DependencyHealthSnapshot
  ): "cloud-primary" | "cloud-secondary" | "edge-sidecar" | "hybrid" {
    return speechBackendModeFn(state, dependencyHealth);
  }

  private async appendSpeakerEvent(event: SpeakerEvent): Promise<void> {
    return appendSpeakerEventFn(this.ctx.storage, event);
  }

  private async storeSpeakerEvents(events: SpeakerEvent[]): Promise<void> {
    return storeSpeakerEventsFn(this.ctx.storage, events);
  }

  private emptyAsrCursorByStream(): Record<StreamRole, AsrReplayCursor> {
    return emptyAsrCursorByStreamFn(this.currentIsoTs());
  }

  private async loadAsrCursorByStream(): Promise<Record<StreamRole, AsrReplayCursor>> {
    return loadAsrCursorByStreamFn(this.ctx.storage, this.currentIsoTs());
  }

  private async patchAsrCursor(streamRole: StreamRole, patch: Partial<AsrReplayCursor>): Promise<void> {
    return patchAsrCursorFn(this.ctx.storage, streamRole, patch, this.currentIsoTs());
  }

  private async loadMemos(): Promise<MemoItem[]> {
    return loadMemosFn(this.ctx.storage);
  }

  private async storeMemos(memos: MemoItem[]): Promise<void> {
    return storeMemosFn(this.ctx.storage, memos);
  }

  private async loadSpeakerLogs(): Promise<SpeakerLogs> {
    return loadSpeakerLogsFn(this.ctx.storage, this.currentIsoTs());
  }

  private async storeSpeakerLogs(logs: SpeakerLogs): Promise<void> {
    return storeSpeakerLogsFn(this.ctx.storage, logs);
  }

  private async loadFeedbackCache(sessionId: string): Promise<FeedbackCache> {
    return loadFeedbackCacheFn(this.ctx.storage, sessionId, this.currentIsoTs());
  }

  private async storeFeedbackCache(cache: FeedbackCache): Promise<void> {
    return storeFeedbackCacheFn(this.ctx.storage, cache);
  }

  private resolveStudentBindingForFeedback(
    state: SessionState,
    clusterId: string | null,
    eventSpeakerName: string | null,
    eventDecision: "auto" | "confirm" | "unknown" | null,
    speakerMapByCluster: Map<string, SpeakerMapItem> = new Map()
  ): { speaker_name: string | null; decision: "auto" | "confirm" | "unknown" | null } {
    return resolveStudentBinding(state, clusterId, eventSpeakerName, eventDecision, speakerMapByCluster);
  }

  private buildTranscriptForFeedback(
    state: SessionState,
    rawByStream: Record<StreamRole, UtteranceRaw[]>,
    events: SpeakerEvent[],
    speakerLogsStored: SpeakerLogs,
    diarizationBackend: "cloud" | "edge"
  ): TranscriptItem[] {
    return buildReconciledTranscript({
      utterances: [...rawByStream.teacher, ...rawByStream.students],
      events,
      speakerLogs: speakerLogsStored,
      state,
      diarizationBackend,
      roster: (state.roster ?? []).flatMap((r) => [r.name, ...(r.aliases ?? [])])
    });
  }

  private buildEvidenceIndex(perPerson: PersonFeedbackItem[]): Record<string, string[]> {
    return buildEvidenceIndexFn(perPerson);
  }

  private findClaimInReport(
    report: ResultV2,
    params: {
      personKey: string;
      dimension: "leadership" | "collaboration" | "logic" | "structure" | "initiative";
      claimType: "strengths" | "risks" | "actions";
      claimId?: string;
    }
  ): { person: PersonFeedbackItem; claim: PersonFeedbackItem["dimensions"][number]["strengths"][number] } | null {
    return findClaimInReportFn(report, params);
  }

  private downWeightClaimConfidenceByEvidence(
    claim: PersonFeedbackItem["dimensions"][number]["strengths"][number],
    evidenceById: Map<string, ResultV2["evidence"][number]>
  ): void {
    downWeightClaimConfidenceByEvidenceFn(claim, evidenceById);
  }

  private sanitizeClaimEvidenceRefs(
    perPerson: PersonFeedbackItem[],
    evidence: ResultV2["evidence"]
  ): { sanitized: PersonFeedbackItem[]; strippedCount: number } {
    return sanitizeClaimEvidenceRefsFn(perPerson, evidence);
  }

  private validateClaimEvidenceRefs(
    report: ResultV2
  ): { valid: boolean; claimCount: number; invalidCount: number; needsEvidenceCount: number; failures: string[] } {
    return validateClaimEvidenceRefsFn(report);
  }

  private evaluateFeedbackQualityGates(params: {
    unknownRatio: number;
    ingestP95Ms: number | null;
    claimValidationFailures: string[];
  }): { passed: boolean; failures: string[] } {
    return evaluateFeedbackQualityGatesFn(params);
  }

  private mergeStatsWithRoster(stats: SpeakerStatItem[], state: SessionState): SpeakerStatItem[] {
    return mergeStatsWithRosterFn(stats, state);
  }

  private async maybeRefreshFeedbackCache(sessionId: string, force = false): Promise<FeedbackCache> {
    const refreshCtx: FeedbackCacheRefreshContext = {
      env: this.env,
      storage: this.ctx.storage,
      captionSource: this.captionSource,
      setCaptionSource: (s) => { this.captionSource = s; },
      loadFeedbackCache: (sid) => this.loadFeedbackCache(sid),
      storeFeedbackCache: (c) => this.storeFeedbackCache(c),
      loadFinalizeV2Status: () => this.loadFinalizeV2Status(),
      loadSpeakerEvents: () => this.loadSpeakerEvents(),
      loadUtterancesRawByStream: () => this.loadUtterancesRawByStream(),
      loadMemos: () => this.loadMemos(),
      loadSpeakerLogs: () => this.loadSpeakerLogs(),
      loadAsrByStream: () => this.loadAsrByStream(),
      currentIsoTs: () => this.currentIsoTs(),
      invokeInferenceAnalysisEvents: (p) => this.invokeInferenceAnalysisEvents(p),
      invokeInferenceAnalysisReport: (p) => this.invokeInferenceAnalysisReport(p),
      deriveSpeakerLogsFromTranscript: (...args) => this.deriveSpeakerLogsFromTranscript(...args),
      buildEdgeSpeakerLogsForFinalize: (...args) => this.buildEdgeSpeakerLogsForFinalize(...args),
    };
    return maybeRefreshFeedbackCacheFn(refreshCtx, sessionId, force);
  }

  private async loadFinalizeV2Status(): Promise<FinalizeV2Status | null> {
    return loadFinalizeV2StatusFn(this.ctx.storage, this.currentIsoTs());
  }

  private async storeFinalizeV2Status(status: FinalizeV2Status): Promise<void> {
    const normalized = await storeFinalizeV2StatusFn(this.ctx.storage, status, this.currentIsoTs());
    await this.scheduleFinalizeWatchdog(normalized);
  }

  private async setFinalizeLock(locked: boolean): Promise<void> {
    return setFinalizeLockFn(this.ctx.storage, locked);
  }

  private async isFinalizeLocked(): Promise<boolean> {
    return isFinalizeLockedFn(this.ctx.storage);
  }

  private isFinalizeTerminal(status: FinalizeV2Status["status"]): boolean {
    return status === "failed" || status === "succeeded";
  }

  private finalizeStatusHeartbeatMs(status: FinalizeV2Status): number {
    const heartbeat = Date.parse(status.heartbeat_at ?? status.started_at);
    if (Number.isFinite(heartbeat)) return heartbeat;
    const started = Date.parse(status.started_at);
    return Number.isFinite(started) ? started : Date.now();
  }

  private async clearFinalizeWatchdogAlarm(): Promise<void> {
    try {
      await this.ctx.storage.deleteAlarm();
    } catch {
      // Best-effort cleanup; some runtimes may throw if no alarm exists.
    }
  }

  private async scheduleFinalizeWatchdog(status: FinalizeV2Status): Promise<void> {
    if (status.status === "queued" || status.status === "running") {
      const heartbeatMs = this.finalizeStatusHeartbeatMs(status);
      await this.ctx.storage.setAlarm(heartbeatMs + this.finalizeWatchdogMs());
      return;
    }
    await this.clearFinalizeWatchdogAlarm();
  }

  private async failStuckFinalizeIfNeeded(reason: string): Promise<FinalizeV2Status | null> {
    const current = await this.loadFinalizeV2Status();
    if (!current || this.isFinalizeTerminal(current.status)) {
      if (current && this.isFinalizeTerminal(current.status)) {
        await this.clearFinalizeWatchdogAlarm();
      }
      return current;
    }
    const heartbeatMs = this.finalizeStatusHeartbeatMs(current);
    const elapsedMs = Date.now() - heartbeatMs;
    const thresholdMs = this.finalizeWatchdogMs();
    if (elapsedMs <= thresholdMs) {
      await this.scheduleFinalizeWatchdog(current);
      return current;
    }

    const nowIso = this.currentIsoTs();
    const next: FinalizeV2Status = {
      ...current,
      status: "failed",
      heartbeat_at: nowIso,
      finished_at: nowIso,
      errors: [...current.errors, `watchdog timeout: stage=${current.stage} elapsed_ms=${elapsedMs} reason=${reason}`]
    };
    await this.storeFinalizeV2Status(next);
    await this.setFinalizeLock(false);
    await Promise.all([
      this.closeRealtimeAsrSession("teacher", "finalize-watchdog", false, true),
      this.closeRealtimeAsrSession("students", "finalize-watchdog", false, true)
    ]);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, nowIso);
    return next;
  }

  private async ensureFinalizeJobActive(jobId: string): Promise<void> {
    const current = await this.loadFinalizeV2Status();
    if (!current || current.job_id !== jobId) {
      throw new Error(`finalize job ${jobId} is no longer current`);
    }
    if (this.isFinalizeTerminal(current.status)) {
      throw new Error(`finalize job ${jobId} already ${current.status}`);
    }
  }

  // ── Session Phase State Machine (E6) ────────────────────────────────
  private async loadSessionPhase(): Promise<SessionPhase> {
    return loadSessionPhaseFn(this.ctx.storage);
  }

  async setSessionPhase(target: SessionPhase): Promise<SessionPhase> {
    return setSessionPhaseFn(this.ctx.storage, target);
  }

  /** Force-set session phase (bypass validation, used for GDPR purge reset). */
  private async resetSessionPhase(phase: SessionPhase): Promise<void> {
    return resetSessionPhaseFn(this.ctx.storage, phase);
  }

  // ── Finalize Stage Checkpoint (E5) ──────────────────────────────────
  private async loadFinalizeStageCheckpoint(): Promise<FinalizeStageCheckpoint | null> {
    return loadFinalizeStageCheckpointFn(this.ctx.storage);
  }

  private async saveFinalizeStageCheckpoint(
    jobId: string,
    completedStage: FinalizeV2Status["stage"],
    stageData: Record<string, unknown>
  ): Promise<void> {
    return saveFinalizeStageCheckpointFn(this.ctx.storage, jobId, completedStage, stageData);
  }

  private async clearFinalizeStageCheckpoint(): Promise<void> {
    return clearFinalizeStageCheckpointFn(this.ctx.storage);
  }

  private get realtimeAsrCtx(): RealtimeAsrContext {
    return {
      env: this.env,
      doCtx: this.ctx,
      asrProcessingByStream: this.asrProcessingByStream,
      asrRealtimeByStream: this.asrRealtimeByStream,
      getLocalWhisperProvider: () => this.localWhisperProvider,
      setLocalWhisperProvider: (p) => { this.localWhisperProvider = p; },
      inferenceCallCtx: this.inferenceCallCtx,
      asrRealtimeEnabled: () => this.asrRealtimeEnabled(),
      asrDebugEnabled: () => this.asrDebugEnabled(),
      resolveAudioWindowSeconds: () => this.resolveAudioWindowSeconds(),
      currentIsoTs: () => this.currentIsoTs(),
      loadAsrByStream: () => this.loadAsrByStream(),
      storeAsrByStream: (s) => this.storeAsrByStream(s),
      loadAsrCursorByStream: () => this.loadAsrCursorByStream(),
      patchAsrCursor: (r, p) => this.patchAsrCursor(r, p),
      loadIngestByStream: (id) => this.loadIngestByStream(id),
      loadUtterancesRawByStream: () => this.loadUtterancesRawByStream(),
      storeUtterancesRawByStream: (s) => this.storeUtterancesRawByStream(s),
      loadUtterancesMergedByStream: () => this.loadUtterancesMergedByStream(),
      storeUtterancesMergedByStream: (s) => this.storeUtterancesMergedByStream(s),
      appendSpeakerEvent: (e) => this.appendSpeakerEvent(e),
      maybeScheduleCheckpoint: (id, ms, r) => this.maybeScheduleCheckpoint(id, ms, r),
      confidenceBucketFromEvidence: (e) => this.confidenceBucketFromEvidence(e),
      inferParticipantFromText: (s, t) => this.inferParticipantFromText(s, t),
      rosterNameByCandidate: (s, c) => this.rosterNameByCandidate(s, c),
      updateUnassignedEnrollmentByCluster: (s, c, d) => this.updateUnassignedEnrollmentByCluster(s, c, d),
      participantProgressFromProfiles: (s) => this.participantProgressFromProfiles(s),
      refreshEnrollmentMode: (s) => this.refreshEnrollmentMode(s),
    };
  }

  private currentRealtimeWsState(runtime: AsrRealtimeRuntime): "disconnected" | "connecting" | "running" | "error" {
    return currentRealtimeWsStateFn(runtime);
  }

  async refreshAsrStreamMetrics(sessionId: string, streamRole: StreamRole, patch: Partial<AsrState> = {}): Promise<void> {
    return refreshAsrStreamMetricsFn(sessionId, streamRole, this.realtimeAsrCtx, patch);
  }

  async closeRealtimeAsrSession(streamRole: StreamRole, reason: string, clearQueue = false, gracefulFinish = true): Promise<void> {
    return closeRealtimeAsrSessionFn(streamRole, reason, this.realtimeAsrCtx, clearQueue, gracefulFinish);
  }

  private async hydrateRuntimeFromCursor(streamRole: StreamRole): Promise<void> {
    return hydrateRuntimeFromCursorFn(streamRole, this.realtimeAsrCtx);
  }

  private async enqueueRealtimeChunk(sessionId: string, streamRole: StreamRole, seq: number, timestampMs: number, bytes: Uint8Array): Promise<void> {
    return enqueueRealtimeChunkFn(sessionId, streamRole, seq, timestampMs, bytes, this.realtimeAsrCtx);
  }

  private async replayGapFromR2(sessionId: string, streamRole: StreamRole): Promise<void> {
    return replayGapFromR2Fn(sessionId, streamRole, this.realtimeAsrCtx);
  }

  private async loadChunkRange(sessionId: string, streamRole: StreamRole, startSeq: number, endSeq: number): Promise<Uint8Array[]> {
    return loadChunkRangeFn(sessionId, streamRole, startSeq, endSeq, this.realtimeAsrCtx);
  }

  private getAsrProvider(): "funASR" | "local-whisper" {
    return getAsrProviderFn(this.realtimeAsrCtx);
  }

  private async autoResolveStudentsUtterance(sessionId: string, utterance: UtteranceRaw, wavBytes: Uint8Array): Promise<{ cluster_id: string; speaker_name: string | null; decision: "auto" | "confirm" | "unknown"; evidence: ResolveEvidence | null } | null> {
    return autoResolveStudentsUtteranceFn(sessionId, utterance, wavBytes, this.realtimeAsrCtx);
  }

  private async maybeAutoEnrollStudentsUtterance(sessionId: string, utterance: UtteranceRaw, wavBytes: Uint8Array, resolved: { cluster_id: string; speaker_name: string | null; decision: "auto" | "confirm" | "unknown"; evidence: ResolveEvidence | null } | null): Promise<void> {
    return maybeAutoEnrollStudentsUtteranceFn(sessionId, utterance, wavBytes, resolved, this.realtimeAsrCtx);
  }

  private resolveTeacherIdentity(state: SessionState, asrText: string): { speakerName: string; identitySource: NonNullable<SpeakerEvent["identity_source"]> } {
    return resolveTeacherIdentityFn(state, asrText);
  }

  private async appendTeacherSpeakerEvent(sessionId: string, utterance: UtteranceRaw): Promise<void> {
    return appendTeacherSpeakerEventFn(sessionId, utterance, this.realtimeAsrCtx);
  }

  private async emitRealtimeUtterance(sessionId: string, streamRole: StreamRole, text: string): Promise<void> {
    return emitRealtimeUtteranceFn(sessionId, streamRole, text, this.realtimeAsrCtx);
  }

  private async handleRealtimeAsrMessage(sessionId: string, streamRole: StreamRole, data: string | ArrayBuffer | ArrayBufferView): Promise<void> {
    return handleRealtimeAsrMessageFn(sessionId, streamRole, data, this.realtimeAsrCtx);
  }

  private async ensureRealtimeAsrConnected(sessionId: string, streamRole: StreamRole): Promise<void> {
    return ensureRealtimeAsrConnectedFn(sessionId, streamRole, this.realtimeAsrCtx);
  }

  private async drainRealtimeQueue(sessionId: string, streamRole: StreamRole): Promise<void> {
    return drainRealtimeQueueFn(sessionId, streamRole, this.realtimeAsrCtx);
  }

  private async runFunAsrDashScope(wavBytes: Uint8Array, model: string) {
    return runFunAsrDashScopeFn(this.env, wavBytes, model);
  }

  private async invokeInferenceResolve(sessionId: string, audio: AudioPayload, asrText: string | null, currentState: SessionState) {
    return invokeInferenceResolveFn(this.inferenceCallCtx, sessionId, audio, asrText, currentState);
  }

  private async maybeRunAsrWindows(sessionId: string, streamRole: StreamRole, force = false, maxWindows = 0): Promise<AsrRunResult> {
    return maybeRunAsrWindowsFn(sessionId, streamRole, this.realtimeAsrCtx, force, maxWindows);
  }

  private async updateFinalizeV2Status(jobId: string, patch: Partial<FinalizeV2Status>): Promise<FinalizeV2Status | null> {
    const current = await this.loadFinalizeV2Status();
    if (!current || current.job_id !== jobId) return null;
    if (this.isFinalizeTerminal(current.status) && patch.status !== current.status) {
      return null;
    }
    const nowIso = this.currentIsoTs();
    const next: FinalizeV2Status = {
      ...current,
      ...patch,
      errors: patch.errors ?? current.errors,
      warnings: patch.warnings ?? current.warnings,
      degraded: patch.degraded ?? current.degraded,
      backend_used: patch.backend_used ?? current.backend_used,
      started_at: current.started_at ?? nowIso,
      heartbeat_at: patch.heartbeat_at ?? nowIso
    };
    await this.storeFinalizeV2Status(next);
    return next;
  }

  private async invokeInferenceAnalysisEvents(payload: Record<string, unknown>) {
    return invokeInferenceAnalysisEventsFn(this.inferenceCallCtx, payload);
  }

  private async invokeInferenceAnalysisReport(payload: Record<string, unknown>) {
    return invokeInferenceAnalysisReportFn(this.inferenceCallCtx, payload);
  }

  private async invokeInferenceSynthesizeReport(payload: SynthesizeRequestPayload) {
    return invokeInferenceSynthesizeReportFn(this.inferenceCallCtx, payload);
  }

  private async invokeInferenceCheckpoint(payload: CheckpointRequestPayload) {
    return invokeInferenceCheckpointFn(this.inferenceCallCtx, payload);
  }

  private async invokeInferenceMergeCheckpoints(payload: MergeCheckpointsRequestPayload) {
    return invokeInferenceMergeCheckpointsFn(this.inferenceCallCtx, payload);
  }

  private async loadCheckpoints(): Promise<CheckpointResult[]> {
    return loadCheckpointsFn(this.ctx.storage);
  }

  private async storeCheckpoints(checkpoints: CheckpointResult[]): Promise<void> {
    return storeCheckpointsFn(this.ctx.storage, checkpoints);
  }

  private async loadLastCheckpointAt(): Promise<number> {
    return loadLastCheckpointAtFn(this.ctx.storage);
  }

  private async storeLastCheckpointAt(ms: number): Promise<void> {
    return storeLastCheckpointAtFn(this.ctx.storage, ms);
  }

  private checkpointIntervalMs(): number {
    return parseInt(this.env.CHECKPOINT_INTERVAL_MS ?? "300000", 10);
  }

  /**
   * Schedule a checkpoint if enough time has elapsed since the last one.
   * Runs asynchronously after each utterance — failures are logged but do not
   * block the ASR pipeline.
   */
  private async maybeScheduleCheckpoint(
    sessionId: string,
    latestUtteranceEndMs: number,
    streamRole: StreamRole
  ): Promise<void> {
    // Only schedule checkpoints for student utterances (the interview content)
    if (streamRole !== "students") return;

    const intervalMs = this.checkpointIntervalMs();
    if (intervalMs <= 0) return; // disabled

    const lastCheckpointAt = await this.loadLastCheckpointAt();
    if (latestUtteranceEndMs - lastCheckpointAt < intervalMs) return;

    try {
      const checkpoints = await this.loadCheckpoints();
      const checkpointIndex = checkpoints.length;

      // Gather recent utterances (since last checkpoint)
      const utterancesByStream = await this.loadUtterancesRawByStream();
      const allUtterances = [
        ...utterancesByStream.teacher,
        ...utterancesByStream.students,
      ].sort((a, b) => a.start_ms - b.start_ms);

      const recentUtterances = allUtterances.filter(
        (u) => u.end_ms > lastCheckpointAt
      );

      if (recentUtterances.length === 0) return;

      // Gather recent memos
      const memos = (await this.ctx.storage.get<MemoItem[]>(STORAGE_KEY_MEMOS)) ?? [];
      const recentMemos = memos.filter(
        (m) => m.created_at_ms > lastCheckpointAt
      );

      // Build stats from recent utterances
      const transcript: TranscriptItem[] = recentUtterances.map((u) => ({
        utterance_id: u.utterance_id,
        stream_role: u.stream_role as TranscriptItem["stream_role"],
        cluster_id: null,
        speaker_name: null,
        decision: null,
        text: u.text,
        start_ms: u.start_ms,
        end_ms: u.end_ms,
        duration_ms: u.duration_ms,
      }));
      const stats = computeSpeakerStats(transcript);

      const locale = (this.env.DEFAULT_LOCALE ?? "zh-CN");

      const payload: CheckpointRequestPayload = {
        session_id: sessionId,
        checkpoint_index: checkpointIndex,
        utterances: transcript.map((t) => ({
          utterance_id: t.utterance_id,
          stream_role: t.stream_role,
          speaker_name: t.speaker_name ?? null,
          cluster_id: t.cluster_id ?? null,
          decision: t.decision ?? null,
          text: t.text,
          start_ms: t.start_ms,
          end_ms: t.end_ms,
          duration_ms: t.duration_ms,
        })),
        memos: recentMemos,
        stats,
        locale,
      };

      const result = await this.invokeInferenceCheckpoint(payload);
      checkpoints.push(result.data);
      await this.storeCheckpoints(checkpoints);
      await this.storeLastCheckpointAt(latestUtteranceEndMs);

      log("info", "checkpoint stored", { sessionId, action: "checkpoint", checkpointIndex, utteranceCount: recentUtterances.length });
    } catch (error) {
      // Checkpoint failures are non-fatal — log and continue
      log("error", "checkpoint failed", { sessionId, action: "checkpoint", error: getErrorMessage(error) });
    }
  }

  private async invokeInferenceRegenerateClaim(payload: InferenceRegenerateClaimRequest) {
    return invokeInferenceRegenerateClaimFn(this.inferenceCallCtx, payload);
  }

  private deriveSpeakerLogsFromTranscript(
    nowIso: string,
    transcript: Array<{
      utterance_id: string;
      stream_role: StreamRole;
      cluster_id?: string | null;
      speaker_name?: string | null;
      text: string;
      start_ms: number;
      end_ms: number;
      duration_ms: number;
      decision?: "auto" | "confirm" | "unknown" | null;
    }>,
    state: SessionState,
    existing: SpeakerLogs,
    source: "cloud" | "edge" = "cloud"
  ): SpeakerLogs {
    return deriveSpeakerLogsFromTranscriptFn(nowIso, transcript, state, existing, source);
  }

  private buildEdgeSpeakerLogsForFinalize(nowIso: string, existing: SpeakerLogs, state: SessionState): SpeakerLogs {
    return buildEdgeSpeakerLogsForFinalizeFn(nowIso, existing, state);
  }

  private async runFinalizeV2Job(
    sessionId: string,
    jobId: string,
    metadata: Record<string, unknown>,
    mode: 'full' | 'report-only' = 'full'
  ): Promise<void> {
    const finalizeCtx: FinalizeJobContext = {
      doCtx: this.ctx,
      env: this.env,
      getCaptionSource: () => this.captionSource,
      setCaptionSource: (source) => { this.captionSource = source; },
      getCaptionBuffer: () => this.captionBuffer,
      setCaptionBuffer: (buffer) => { this.captionBuffer = buffer; },
      embeddingCache: this.embeddingCache,
      localWhisperProvider: this.localWhisperProvider,
      loadIngestByStream: (sid) => this.loadIngestByStream(sid),
      loadAsrByStream: () => this.loadAsrByStream(),
      storeAsrByStream: (state) => this.storeAsrByStream(state),
      loadUtterancesRawByStream: () => this.loadUtterancesRawByStream(),
      storeUtterancesRawByStream: (state) => this.storeUtterancesRawByStream(state),
      loadUtterancesMergedByStream: () => this.loadUtterancesMergedByStream(),
      storeUtterancesMergedByStream: (state) => this.storeUtterancesMergedByStream(state),
      loadSpeakerEvents: () => this.loadSpeakerEvents(),
      loadSpeakerLogs: () => this.loadSpeakerLogs(),
      storeSpeakerLogs: (logs) => this.storeSpeakerLogs(logs),
      loadMemos: () => this.loadMemos(),
      storeMemos: (memos) => this.storeMemos(memos),
      loadFeedbackCache: (sid) => this.loadFeedbackCache(sid),
      storeFeedbackCache: (cache) => this.storeFeedbackCache(cache),
      loadFinalizeV2Status: () => this.loadFinalizeV2Status(),
      storeFinalizeV2Status: (status) => this.storeFinalizeV2Status(status),
      loadFinalizeStageCheckpoint: () => this.loadFinalizeStageCheckpoint(),
      saveFinalizeStageCheckpoint: (jobId, stage, data) => this.saveFinalizeStageCheckpoint(jobId, stage, data),
      clearFinalizeStageCheckpoint: () => this.clearFinalizeStageCheckpoint(),
      loadCheckpoints: () => this.loadCheckpoints(),
      storeCheckpoints: (cps) => this.storeCheckpoints(cps),
      loadLastCheckpointAt: () => this.loadLastCheckpointAt(),
      storeLastCheckpointAt: (ms) => this.storeLastCheckpointAt(ms),
      storeTier2Status: (status) => this.storeTier2Status(status),
      updateFinalizeV2Status: (jid, patch) => this.updateFinalizeV2Status(jid, patch),
      setFinalizeLock: (locked) => this.setFinalizeLock(locked),
      ensureFinalizeJobActive: (jid) => this.ensureFinalizeJobActive(jid),
      isFinalizeTerminal: (status) => this.isFinalizeTerminal(status),
      finalizeTimeoutMs: () => this.finalizeTimeoutMs(),
      setSessionPhase: (target) => this.setSessionPhase(target),
      maybeRunAsrWindows: (sid, role, force, maxW) => this.maybeRunAsrWindows(sid, role, force, maxW),
      drainRealtimeQueue: (sid, role) => this.drainRealtimeQueue(sid, role),
      replayGapFromR2: (sid, role) => this.replayGapFromR2(sid, role),
      closeRealtimeAsrSession: (role, reason, wait, schedule) => this.closeRealtimeAsrSession(role, reason, wait, schedule),
      refreshAsrStreamMetrics: (sid, role) => this.refreshAsrStreamMetrics(sid, role),
      extractEmbeddingsForTurns: (sid, logs, role) => this.extractEmbeddingsForTurns(sid, logs, role),
      getAsrProvider: () => this.getAsrProvider(),
      checkpointIntervalMs: () => this.checkpointIntervalMs(),
      invokeInferenceAnalysisEvents: (payload) => this.invokeInferenceAnalysisEvents(payload),
      invokeInferenceAnalysisReport: (payload) => this.invokeInferenceAnalysisReport(payload),
      invokeInferenceSynthesizeReport: (payload) => this.invokeInferenceSynthesizeReport(payload),
      invokeInferenceCheckpoint: (payload) => this.invokeInferenceCheckpoint(payload),
      invokeInferenceMergeCheckpoints: (payload) => this.invokeInferenceMergeCheckpoints(payload),
      sanitizeClaimEvidenceRefs: (perPerson, evidence) => this.sanitizeClaimEvidenceRefs(perPerson, evidence),
      validateClaimEvidenceRefs: (report) => this.validateClaimEvidenceRefs(report),
      evaluateFeedbackQualityGates: (params) => this.evaluateFeedbackQualityGates(params),
      mergeStatsWithRoster: (stats, state) => this.mergeStatsWithRoster(stats, state),
      buildEvidenceIndex: (perPerson) => this.buildEvidenceIndex(perPerson),
      buildQualityMetrics: (transcript, captureByStream) => this.buildQualityMetrics(transcript, captureByStream),
      speechBackendMode: (state, dependencyHealth) => this.speechBackendMode(state, dependencyHealth),
      deriveSpeakerLogsFromTranscript: (nowIso, transcript, state, existing, source) => this.deriveSpeakerLogsFromTranscript(nowIso, transcript, state, existing, source),
      buildEdgeSpeakerLogsForFinalize: (nowIso, existing, state) => this.buildEdgeSpeakerLogsForFinalize(nowIso, existing, state),
      runIncrementalJob: (sid) => this.runIncrementalJob(sid),
      runIncrementalFinalize: (sid, memos, stats, evidence, locale, aliases) => this.runIncrementalFinalize(sid, memos, stats, evidence, locale, aliases),
      loadIncrementalStatus: () => this.loadIncrementalStatus(),
      triggerImprovementGeneration: (sid, result, transcript, key) => this.triggerImprovementGeneration(sid, result, transcript, key),
      tier2Enabled: () => this.tier2Enabled(),
      tier2AutoTrigger: () => this.tier2AutoTrigger(),
      currentIsoTs: () => this.currentIsoTs(),
      appendSpeakerEvent: (event) => this.appendSpeakerEvent(event),
    };
    await runFinalizeV2JobFn(sessionId, jobId, metadata, finalizeCtx, mode);
  }

  private async triggerImprovementGeneration(
    sessionId: string,
    resultV2: ResultV2,
    transcript: Array<{ utterance_id: string; speaker_name?: string | null; text: string; start_ms: number; end_ms: number; duration_ms: number }>,
    resultV2Key: string
  ): Promise<void> {
    return triggerImprovementGenerationImpl(sessionId, resultV2, transcript, resultV2Key, {
      doCtx: this.ctx,
      env: this.env,
      currentIsoTs: () => this.currentIsoTs(),
      loadFeedbackCache: (sid) => this.loadFeedbackCache(sid),
      storeFeedbackCache: (cache) => this.storeFeedbackCache(cache),
    });
  }

  // ── Tier 2 Status Management ───────────────────────────────────────────

  private tier2Enabled(): boolean {
    return tier2EnabledFn(this.env);
  }

  private tier2AutoTrigger(): boolean {
    return tier2AutoTriggerFn(this.env);
  }

  private tier2BatchEndpoint(): string {
    return tier2BatchEndpointFn(this.env);
  }

  private defaultTier2Status(): Tier2Status {
    return defaultTier2StatusFn(this.tier2Enabled());
  }

  private async loadTier2Status(): Promise<Tier2Status> {
    return loadTier2StatusFn(this.ctx.storage, this.tier2Enabled());
  }

  private async storeTier2Status(status: Tier2Status): Promise<void> {
    return storeTier2StatusFn(this.ctx.storage, status);
  }

  private async updateTier2Status(patch: Partial<Tier2Status>): Promise<Tier2Status> {
    return updateTier2StatusFn(this.ctx.storage, patch, this.tier2Enabled());
  }

  private isTier2Terminal(status: Tier2Status["status"]): boolean {
    return isTier2TerminalFn(status);
  }

  // ── Tier 2 Background Job ────────────────────────────────────────────

  private async runTier2Job(sessionId: string): Promise<void> {
    const tier2 = await this.loadTier2Status();
    if (this.isTier2Terminal(tier2.status)) {
      return;
    }

    const tier2Ctx: Tier2Context = {
      storage: this.ctx.storage,
      env: this.env,
      updateTier2Status: (patch) => this.updateTier2Status(patch),
      loadMemos: () => this.loadMemos(),
      loadFeedbackCache: (sid) => this.loadFeedbackCache(sid),
      storeFeedbackCache: (cache) => this.storeFeedbackCache(cache),
      buildEvidenceIndex: (perPerson) => this.buildEvidenceIndex(perPerson),
      mergeStatsWithRoster: (stats, state) => this.mergeStatsWithRoster(stats, state),
      sanitizeClaimEvidenceRefs: (perPerson, evidence) => this.sanitizeClaimEvidenceRefs(perPerson, evidence),
      validateClaimEvidenceRefs: (report) => this.validateClaimEvidenceRefs(report),
      invokeInferenceSynthesizeReport: (payload) => this.invokeInferenceSynthesizeReport(payload as SynthesizeRequestPayload),
      currentIsoTs: () => this.currentIsoTs(),
    };

    await runTier2JobFn(sessionId, tier2Ctx);
  }

  // ── Incremental Processing ─────────────────────────────────────────────

  private async loadIncrementalStatus(): Promise<IncrementalStatus> {
    return loadIncrementalStatusFn(this.ctx.storage, incrementalV1Enabled(this.env));
  }

  private async storeIncrementalStatus(status: IncrementalStatus): Promise<void> {
    return storeIncrementalStatusFn(this.ctx.storage, status);
  }

  private async updateIncrementalStatus(patch: Partial<IncrementalStatus>): Promise<IncrementalStatus> {
    return updateIncrementalStatusFn(this.ctx.storage, patch, incrementalV1Enabled(this.env));
  }

  /**
   * Schedule a DO alarm for incremental processing 500ms from now.
   * Stores the session ID so the alarm handler can resolve it without a finalized result key.
   * No-op if incremental is disabled or alarm already pending.
   */
  private async scheduleIncrementalAlarm(sessionId: string): Promise<void> {
    return scheduleIncrementalAlarmFn(this.ctx.storage, sessionId);
  }

  /**
   * Main incremental processing job — runs in the alarm handler.
   * Gathers the audio range, POSTs to /incremental/process-chunk, stores results.
   * Non-fatal: logs warning and increments failed count on any error.
   */
  private async runIncrementalJob(sessionId: string): Promise<void> {
    const incrementalCtx: IncrementalContext = {
      storage: this.ctx.storage,
      env: this.env,
      loadIncrementalStatus: () => this.loadIncrementalStatus(),
      updateIncrementalStatus: (patch) => this.updateIncrementalStatus(patch),
      loadIngestByStream: (sid) => this.loadIngestByStream(sid),
      currentIsoTs: () => this.currentIsoTs(),
    };
    await runIncrementalJobFn(sessionId, incrementalCtx);
  }

  /**
   * Call the /incremental/finalize endpoint after recording ends.
   * Returns true if finalization succeeded (caller can skip Tier 2).
   * Returns false on failure (caller should fall back to Tier 2).
   */
  private async runIncrementalFinalize(
    sessionId: string,
    memos: MemoItem[],
    stats: SpeakerStatItem[],
    evidence: Array<import("./types_v2").EvidenceItem>,
    locale: string,
    nameAliases: Record<string, string[]>
  ): Promise<boolean> {
    const finalizeCtx: IncrementalFinalizeContext = {
      storage: this.ctx.storage,
      env: this.env,
      loadIncrementalStatus: () => this.loadIncrementalStatus(),
      updateIncrementalStatus: (patch) => this.updateIncrementalStatus(patch),
      currentIsoTs: () => this.currentIsoTs(),
    };
    return runIncrementalFinalizeFn(sessionId, memos, stats, evidence, locale, nameAliases, finalizeCtx);
  }

  async handleChunkFrame(
    sessionId: string,
    streamRole: StreamRole,
    socket: WebSocket,
    frame: AudioChunkFrame
  ): Promise<void> {
    if (await this.isFinalizeLocked()) {
      await this.failStuckFinalizeIfNeeded("ingest-locked");
    }
    if (await this.isFinalizeLocked()) {
      this.sendWsJson(socket, {
        type: "ack",
        stream_role: streamRole,
        seq: frame.seq,
        status: "frozen"
      });
      return;
    }
    const ingestByStream = await this.loadIngestByStream(sessionId);
    const ingest = ingestByStream[streamRole];

    if (ingest.meeting_id && ingest.meeting_id !== frame.meeting_id) {
      throw new Error(`meeting_id mismatch: expected ${ingest.meeting_id}`);
    }

    if (frame.seq <= ingest.last_seq) {
      ingest.duplicate_chunks += 1;
      ingestByStream[streamRole] = ingest;
      await this.storeIngestByStream(ingestByStream);
      this.sendWsJson(socket, {
        type: "ack",
        stream_role: streamRole,
        seq: frame.seq,
        status: "duplicate",
        last_seq: ingest.last_seq,
        missing_count: ingest.missing_chunks,
        duplicate_count: ingest.duplicate_chunks
      });
      return;
    }

    if (frame.seq > ingest.last_seq + 1) {
      ingest.missing_chunks += frame.seq - ingest.last_seq - 1;
    }

    const bytes = decodeBase64ToBytes(frame.content_b64);
    if (bytes.byteLength !== ONE_SECOND_PCM_BYTES) {
      throw new Error(`chunk byte length must be ${ONE_SECOND_PCM_BYTES}, got ${bytes.byteLength}`);
    }

    const key = chunkObjectKey(sessionId, streamRole, frame.seq);
    await this.env.RESULT_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: "application/octet-stream"
      },
      customMetadata: {
        session_id: sessionId,
        stream_role: streamRole,
        meeting_id: frame.meeting_id,
        seq: String(frame.seq),
        timestamp_ms: String(frame.timestamp_ms),
        sample_rate: String(frame.sample_rate),
        channels: String(frame.channels),
        format: frame.format
      }
    });

    ingest.last_seq = frame.seq;
    ingest.received_chunks += 1;
    ingest.bytes_stored += bytes.byteLength;
    ingestByStream[streamRole] = ingest;
    await this.storeIngestByStream(ingestByStream);
    await this.patchAsrCursor(streamRole, {
      last_ingested_seq: Math.max(frame.seq, ingest.last_seq)
    });

    this.sendWsJson(socket, {
      type: "ack",
      stream_role: streamRole,
      seq: frame.seq,
      status: "stored",
      key,
      last_seq: ingest.last_seq,
      missing_count: ingest.missing_chunks,
      duplicate_count: ingest.duplicate_chunks
    });

    if (this.asrEnabled()) {
      if (this.asrRealtimeEnabled()) {
        this.ctx.waitUntil(
          (async () => {
            await this.enqueueRealtimeChunk(sessionId, streamRole, frame.seq, frame.timestamp_ms, bytes);
            await this.drainRealtimeQueue(sessionId, streamRole);
          })().catch((error) => {
            log("error", "asr realtime enqueue failed", { component: "asr", session_id: sessionId, stream_role: streamRole, error: getErrorMessage(error) });
          })
        );
      } else {
        this.ctx.waitUntil(
          this.maybeRunAsrWindows(sessionId, streamRole, false, 1).catch((error) => {
            log("error", "asr window processing failed", { component: "asr", session_id: sessionId, stream_role: streamRole, error: getErrorMessage(error) });
          })
        );
      }
    }

    // NOTE: feedback cache refresh removed from audio chunk handler.
    // The cache is refreshed on-demand when feedback endpoints are called
    // (feedback-ready, feedback-open, etc.) — NOT on every audio chunk.
    // Previously, ctx.waitUntil races caused hundreds of concurrent
    // events+report LLM calls during recording, exhausting the thread pool
    // and preventing the synthesize call from succeeding at finalization.

    // ── Incremental processing scheduling ──
    // Only check on the "mixed" stream to avoid duplicate scheduling.
    if (incrementalV1Enabled(this.env) && streamRole === "mixed") {
      this.ctx.waitUntil(
        (async () => {
          const incStatus = await this.loadIncrementalStatus();
          const totalAudioMs = ingestByStream.mixed.received_chunks * 1000;
          const decision = shouldScheduleIncremental(this.env, incStatus, totalAudioMs);
          if (decision.schedule) {
            await this.scheduleIncrementalAlarm(sessionId);
          }
        })().catch((err) => {
          log("warn", "incremental: scheduling check failed (non-fatal)", { sessionId, action: "incremental", error: getErrorMessage(err) });
        })
      );
    }
  }

  private deriveMixedCaptureState(captureByStream: Record<StreamRole, CaptureState>): CaptureState["capture_state"] {
    return deriveMixedCaptureStateFn(captureByStream);
  }

  async applyCaptureStatus(
    sessionId: string,
    streamRole: StreamRole,
    patch: Partial<CaptureState>
  ): Promise<CaptureState> {
    const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const capture = state.capture_by_stream ?? defaultCaptureByStream();
    const current = sanitizeCaptureState(capture[streamRole]);
    const next = sanitizeCaptureState({
      ...current,
      ...patch,
      updated_at: new Date().toISOString()
    });
    capture[streamRole] = next;
    capture.mixed = sanitizeCaptureState({
      ...capture.mixed,
      capture_state: this.deriveMixedCaptureState(capture),
      echo_suppressed_chunks: capture.teacher.echo_suppressed_chunks ?? 0,
      echo_suppression_recent_rate: capture.teacher.echo_suppression_recent_rate ?? 0,
      updated_at: new Date().toISOString()
    });
    state.capture_by_stream = capture;
    await this.ctx.storage.put(STORAGE_KEY_STATE, state);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
    return next;
  }

  async updateSessionConfigFromHello(message: Record<string, unknown>): Promise<void> {
    const currentState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
    const config = { ...(currentState.config ?? {}) };

    const interviewer = valueAsString(message.interviewer_name);
    if (interviewer) {
      config.interviewer_name = interviewer;
    }

    const teamsInterviewer = valueAsString(message.teams_interviewer_name);
    if (teamsInterviewer) {
      config.teams_interviewer_name = teamsInterviewer;
    } else if (interviewer) {
      config.teams_interviewer_name = interviewer;
    }
    if (config.diarization_backend !== "edge" && config.diarization_backend !== "cloud") {
      config.diarization_backend = this.diarizationBackendDefault();
    }

    const roster = parseRosterEntries(message.teams_participants);
    if (roster.length > 0) {
      currentState.roster = roster;
    }

    currentState.config = config;
    await this.ctx.storage.put(STORAGE_KEY_STATE, currentState);
    await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
  }

  ingestByStreamPayload(sessionId: string, ingestByStream: Record<StreamRole, IngestState>) {
    return {
      mixed: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
      teacher: ingestStatusPayload(sessionId, "teacher", ingestByStream.teacher),
      students: ingestStatusPayload(sessionId, "students", ingestByStream.students)
    };
  }

  /** Satisfy WsHandlerContext: persist captionSource to storage (fire-and-forget). */
  persistCaptionSource(sessionId: string, src: CaptionSource): void {
    this.ctx.storage.put(STORAGE_KEY_CAPTION_SOURCE, src).catch((err) => {
      log("warn", "caption-persist: captionSource flush failed", { sessionId, action: "caption_persist", error: getErrorMessage(err) });
    });
  }

  private handleWebSocketRequest(
    request: Request,
    sessionId: string,
    connectionRole: StreamRole
  ): Response {
    return handleWebSocketUpgrade(this, request, sessionId, connectionRole, this.env as unknown as Record<string, unknown>);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");
    const sessionId = request.headers.get("x-session-id") ?? "unknown-session";
    const headerRole = request.headers.get("x-stream-role");

    if (action === "ingest-ws" && request.method === "GET") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(headerRole, "mixed");
      } catch (error) {
        log("error", "ingest-ws: stream role parse error", { sessionId, action: "ingest_ws", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      return this.handleWebSocketRequest(request, sessionId, streamRole);
    }

    if (action === "state" && request.method === "GET") {
      const [state, events, updatedAt, ingestByStream, utterancesByStream, asrByStream, memos, finalizeV2Status, speakerLogs, asrCursorByStream, feedbackCache, dependencyHealth, tier2Status] =
        await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.loadSpeakerEvents(),
        this.ctx.storage.get<string>(STORAGE_KEY_UPDATED_AT),
        this.loadIngestByStream(sessionId),
        this.loadUtterancesRawByStream(),
        this.loadAsrByStream(),
        this.loadMemos(),
        this.loadFinalizeV2Status(),
        this.loadSpeakerLogs(),
        this.loadAsrCursorByStream(),
        this.loadFeedbackCache(sessionId),
        this.loadDependencyHealth(),
        this.loadTier2Status()
      ]);

      const utteranceCountByStream = {
        mixed: utterancesByStream.mixed.length,
        teacher: utterancesByStream.teacher.length,
        students: utterancesByStream.students.length
      };
      const normalizedState = normalizeSessionState(state);
      const diarizationBackend = normalizedState.config?.diarization_backend === "edge" ? "edge" : "cloud";
      const metricsTranscript = buildReconciledTranscript({
        utterances: [...utterancesByStream.teacher, ...utterancesByStream.students],
        events,
        speakerLogs,
        state: normalizedState,
        diarizationBackend,
        roster: (normalizedState.roster ?? []).flatMap((r: RosterEntry) => [r.name, ...(r.aliases ?? [])])
      });
      const qualityMetrics = this.buildQualityMetrics(metricsTranscript, normalizedState.capture_by_stream ?? defaultCaptureByStream());
      const speechBackendMode = this.speechBackendMode(normalizedState, dependencyHealth);

      const sessionPhase = await this.loadSessionPhase();

      return jsonResponse({
        session_id: sessionId,
        session_phase: sessionPhase,
        state: normalizedState,
        event_count: events.length,
        updated_at: updatedAt ?? null,
        ingest: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
        ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream),
        capture_by_stream: normalizedState.capture_by_stream,
        enrollment_state: normalizedState.enrollment_state,
        participant_profiles: normalizedState.participant_profiles,
        cluster_binding_meta: normalizedState.cluster_binding_meta,
        asr: asrByStream.mixed,
        asr_by_stream: asrByStream,
        utterance_count: utteranceCountByStream.mixed,
        utterance_count_by_stream: utteranceCountByStream,
        memo_count: memos.length,
        finalize_v2: finalizeV2Status,
        tier2: tier2Status,
        speaker_logs: speakerLogs,
        asr_cursor_by_stream: asrCursorByStream,
        dependency_health: dependencyHealth,
        speech_backend_mode: speechBackendMode,
        quality_metrics: qualityMetrics,
        feedback: {
          ready: feedbackCache.ready,
          updated_at: feedbackCache.updated_at,
          quality: feedbackCache.quality,
          timings: feedbackCache.timings,
          report_source: feedbackCache.report_source,
          blocking_reason: feedbackCache.blocking_reason,
          quality_gate_passed: feedbackCache.quality_gate_passed
        }
      });
    }

    if (action === "config" && request.method === "POST") {
      let payload: SessionConfigRequest;
      try {
        payload = await readJson<SessionConfigRequest>(request);
      } catch (error) {
        log("error", "config: request parse error", { sessionId, action: "config", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const config = { ...(state.config ?? {}) };

        const teamsInterviewerName = valueAsString(payload.teams_interviewer_name);
        if (teamsInterviewerName) {
          config.teams_interviewer_name = teamsInterviewerName;
        }
        const interviewerName = valueAsString(payload.interviewer_name);
        if (interviewerName) {
          config.interviewer_name = interviewerName;
          if (!teamsInterviewerName) {
            config.teams_interviewer_name = interviewerName;
          }
        }
        if (payload.diarization_backend) {
          const db = payload.diarization_backend;
          config.diarization_backend = db === "edge" || db === "local" ? "edge" : "cloud";
        } else if (config.diarization_backend !== "edge" && config.diarization_backend !== "cloud") {
          config.diarization_backend = this.diarizationBackendDefault();
        }
        const mode = valueAsString(payload.mode);
        if (mode === "1v1" || mode === "group") {
          config.mode = mode;
        }
        const templateId = valueAsString(payload.template_id);
        if (templateId) {
          config.template_id = templateId;
        }
        const bookingRef = valueAsString(payload.booking_ref);
        if (bookingRef) {
          config.booking_ref = bookingRef;
        }
        const teamsJoinUrl = valueAsString(payload.teams_join_url);
        if (teamsJoinUrl) {
          config.teams_join_url = teamsJoinUrl;
        }
        if (Array.isArray(payload.stages)) {
          config.stages = payload.stages.filter((s): s is string => typeof s === "string");
        }
        const freeFormNotes = valueAsString(payload.free_form_notes);
        if (freeFormNotes) {
          config.free_form_notes = freeFormNotes;
        }

        const interviewType = valueAsString(payload.interview_type);
        if (interviewType) {
          config.interview_type = interviewType;
        }
        if (Array.isArray(payload.dimension_presets)) {
          config.dimension_presets = payload.dimension_presets;
        }

        const roster = parseRosterEntries(payload.participants ?? payload.teams_participants);
        if (roster.length > 0) {
          state.roster = roster;
          // Extract name_aliases from roster entries that have aliases
          const nameAliases: Record<string, string[]> = {};
          for (const entry of roster) {
            if (entry.aliases && entry.aliases.length > 0) {
              nameAliases[entry.name] = entry.aliases;
            }
          }
          if (Object.keys(nameAliases).length > 0) {
            config.name_aliases = nameAliases;
          }
        }

        state.config = config;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());
        this.ctx.waitUntil(
          this.maybeRefreshFeedbackCache(sessionId, true).catch((error) => {
            log("error", "feedback cache refresh after config failed", { sessionId, action: "config", error: getErrorMessage(error) });
          })
        );

        return jsonResponse({
          session_id: sessionId,
          roster_count: state.roster?.length ?? 0,
          config: state.config,
          roster: state.roster ?? []
        });
      });
    }

    if (action === "enrollment-start" && request.method === "POST") {
      let payload: EnrollmentStartRequest;
      try {
        payload = await readJson<EnrollmentStartRequest>(request);
      } catch (error) {
        log("error", "enrollment-start: request parse error", { sessionId, action: "enrollment_start", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const config = { ...(state.config ?? {}) };
        const teamsInterviewerName = valueAsString(payload.teams_interviewer_name);
        const interviewerName = valueAsString(payload.interviewer_name);
        if (teamsInterviewerName) {
          config.teams_interviewer_name = teamsInterviewerName;
        }
        if (interviewerName) {
          config.interviewer_name = interviewerName;
          if (!teamsInterviewerName) {
            config.teams_interviewer_name = interviewerName;
          }
        }
        state.config = config;

        const roster = parseRosterEntries(payload.participants ?? payload.teams_participants);
        if (roster.length > 0) {
          state.roster = roster;
        }

        const participants: Record<string, EnrollmentParticipantProgress> = {};
        for (const item of state.roster ?? []) {
          const key = item.name.trim().toLowerCase();
          if (!key) continue;
          participants[key] = {
            name: item.name,
            sample_seconds: 0,
            sample_count: 0,
            status: "collecting"
          };
        }

        state.enrollment_state = {
          mode: "collecting",
          started_at: this.currentIsoTs(),
          stopped_at: null,
          participants,
          unassigned_clusters: {},
          updated_at: this.currentIsoTs()
        };
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          enrollment_state: state.enrollment_state,
          roster_count: state.roster?.length ?? 0
        });
      });
    }

    if (action === "enrollment-stop" && request.method === "POST") {
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
        enrollment.mode = "closed";
        enrollment.stopped_at = this.currentIsoTs();
        enrollment.updated_at = this.currentIsoTs();
        state.enrollment_state = enrollment;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          enrollment_state: state.enrollment_state
        });
      });
    }

    if (action === "enrollment-state" && request.method === "GET") {
      const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
      return jsonResponse({
        session_id: sessionId,
        enrollment_state: enrollment,
        participant_profiles: state.participant_profiles
      });
    }

    if (action === "enrollment-profiles" && request.method === "POST") {
      let payload: { participant_profiles: Array<{ name: string; centroid: number[]; sample_count?: number; sample_seconds?: number; status?: string }> };
      try {
        payload = await readJson<typeof payload>(request);
      } catch (error) {
        log("error", "enrollment-profiles: request parse error", { sessionId, action: "enrollment_profiles", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      if (!Array.isArray(payload.participant_profiles) || payload.participant_profiles.length === 0) {
        return badRequest("participant_profiles must be a non-empty array");
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const profiles: ParticipantProfile[] = [];
        for (const p of payload.participant_profiles) {
          if (!p.name || !Array.isArray(p.centroid) || p.centroid.length === 0) continue;
          profiles.push({
            name: p.name,
            email: null,
            centroid: p.centroid,
            sample_count: p.sample_count ?? 1,
            sample_seconds: p.sample_seconds ?? 5,
            status: "ready"
          });
        }
        state.participant_profiles = profiles;
        const enrollment = state.enrollment_state ?? buildDefaultEnrollmentState();
        const participants: Record<string, EnrollmentParticipantProgress> = {};
        for (const profile of profiles) {
          const key = profile.name.trim().toLowerCase();
          if (!key) continue;
          participants[key] = {
            name: profile.name,
            sample_seconds: profile.sample_seconds,
            sample_count: profile.sample_count,
            status: "ready"
          };
        }
        enrollment.mode = "ready";
        enrollment.participants = participants;
        enrollment.updated_at = this.currentIsoTs();
        state.enrollment_state = enrollment;
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        return jsonResponse({
          session_id: sessionId,
          profiles_count: profiles.length,
          enrollment_state: state.enrollment_state
        });
      });
    }

    if (action === "memos" && request.method === "POST") {
      if (!this.memosEnabled()) {
        return jsonResponse({ detail: "memos is disabled" }, 503);
      }
      let payload: Record<string, unknown>;
      try {
        payload = await readJson<Record<string, unknown>>(request);
      } catch (error) {
        log("error", "memos: request parse error", { sessionId, action: "memos", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      return this.enqueueMutation(async () => {
        const nowMs = Date.now();
        const memos = await this.loadMemos();
        const memoId = nextMemoId(memos, nowMs);
        let item: MemoItem;
        try {
          item = parseMemoPayload(payload, { memoId, createdAtMs: nowMs });
        } catch (error) {
          log("error", "memos: payload parse error", { sessionId, action: "memos", error: getErrorMessage(error) });
          return badRequest("Request processing failed");
        }
        memos.push(item);
        await this.storeMemos(memos);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, this.currentIsoTs());
        // NOTE: Do NOT force-refresh feedback cache on every memo POST.
        // Memos are stored in DO and included during finalization.
        // Forcing refresh here wastes LLM tokens (12+ memos = 12+ LLM calls).
        return jsonResponse({
          session_id: sessionId,
          memo: item,
          count: memos.length
        });
      });
    }

    if (action === "memos" && request.method === "GET") {
      const limitRaw = Number(url.searchParams.get("limit") ?? "100");
      const fromMsRaw = Number(url.searchParams.get("from_ms"));
      const toMsRaw = Number(url.searchParams.get("to_ms"));
      const memos = await this.loadMemos();
      const items = filterMemos(memos, {
        limit: Number.isFinite(limitRaw) ? limitRaw : 100,
        fromMs: Number.isFinite(fromMsRaw) ? fromMsRaw : null,
        toMs: Number.isFinite(toMsRaw) ? toMsRaw : null
      });
      return jsonResponse({
        session_id: sessionId,
        count: memos.length,
        items
      });
    }

    if (action === "feedback-ready" && request.method === "GET") {
      const cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      const cacheAgeMs = Math.max(0, Date.now() - Date.parse(cache.updated_at || this.currentIsoTs()));
      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        updated_at: cache.updated_at,
        cache_age_ms: cacheAgeMs,
        budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        timings: cache.timings,
        quality: cache.quality,
        report_source: cache.report_source,
        blocking_reason: cache.blocking_reason,
        quality_gate_passed: cache.quality_gate_passed
      });
    }

    if (action === "feedback-open" && request.method === "POST") {
      const startedAt = Date.now();
      let cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      if (!cache.report) {
        cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      }
      const elapsedMs = Date.now() - startedAt;
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }
      const withinBudget = elapsedMs <= FEEDBACK_TOTAL_BUDGET_MS;
      const openBlockingReason =
        cache.blocking_reason ??
        (withinBudget ? null : `feedback-open exceeded budget: opened_in_ms=${elapsedMs} target<=${FEEDBACK_TOTAL_BUDGET_MS}`);
      const isReady = (cache.ready ?? false) && withinBudget && ACCEPTED_REPORT_SOURCES.has(cache.report_source ?? "");
      // Even when quality gate fails, still return the report if it comes from
      // an accepted LLM source — frontend can display it as degraded/draft
      const hasAcceptedSource = ACCEPTED_REPORT_SOURCES.has(cache.report_source ?? "");
      const shouldReturnReport = isReady || hasAcceptedSource;
      return jsonResponse({
        session_id: sessionId,
        ready: isReady,
        within_budget: withinBudget,
        opened_in_ms: elapsedMs,
        budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
        timings: cache.timings,
        quality: cache.quality,
        report_source: cache.report_source,
        blocking_reason: isReady ? null : openBlockingReason,
        quality_gate_passed: cache.quality_gate_passed,
        report: shouldReturnReport ? cache.report : null
      });
    }

    if (action === "feedback-regenerate-claim" && request.method === "POST") {
      let payload: FeedbackRegenerateClaimRequest;
      try {
        payload = await readJson<FeedbackRegenerateClaimRequest>(request);
      } catch (error) {
        log("error", "feedback-regenerate-claim: request parse error", { sessionId, action: "feedback_regenerate_claim", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      const personKey = String(payload.person_key || "").trim();
      const claimType = payload.claim_type;
      const dimension = payload.dimension;
      if (!personKey || !claimType || !dimension) {
        return badRequest("person_key, dimension and claim_type are required");
      }

      const cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }

      const report = JSON.parse(JSON.stringify(cache.report)) as ResultV2;
      const lookup = this.findClaimInReport(report, {
        personKey,
        dimension,
        claimType,
        claimId: payload.claim_id
      });
      if (!lookup) {
        return jsonResponse({ detail: `person_key not found: ${personKey}` }, 404);
      }
      const targetClaim = lookup.claim;
      const hint = String(payload.text_hint || "").trim();
      const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
      const indexRefs = cache.evidence_index_cache[`${personKey}:${dimension}`] ?? [];
      const allowedEvidenceIds: string[] = [];
      const seen = new Set<string>();
      for (const ref of [...targetClaim.evidence_refs, ...indexRefs]) {
        const id = String(ref || "").trim();
        if (!id || !evidenceById.has(id) || seen.has(id)) continue;
        seen.add(id);
        allowedEvidenceIds.push(id);
      }
      if (allowedEvidenceIds.length === 0) {
        return jsonResponse(
          {
            detail: "claim regeneration requires evidence_refs; add evidence before regenerate",
            person_key: personKey,
            dimension
          },
          422
        );
      }
      const inferenceReq: InferenceRegenerateClaimRequest = {
        session_id: sessionId,
        person_key: personKey,
        display_name: lookup.person.display_name,
        dimension,
        claim_type: claimType,
        claim_id: targetClaim.claim_id,
        claim_text: targetClaim.text,
        text_hint: hint || undefined,
        allowed_evidence_ids: allowedEvidenceIds,
        evidence: report.evidence.map((item) => ({
          evidence_id: item.evidence_id,
          time_range_ms: item.time_range_ms,
          utterance_ids: item.utterance_ids,
          speaker_key:
            (item.speaker?.display_name as string | undefined) ??
            (item.speaker?.person_id as string | undefined) ??
            (item.speaker?.cluster_id as string | undefined) ??
            null,
          quote: item.quote,
          confidence: item.confidence
        })),
        transcript: report.transcript,
        memos: report.memos,
        stats: report.stats,
        locale: getSessionLocale(
          normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE)),
          this.env
        )
      };
      const regenResult = await this.invokeInferenceRegenerateClaim(inferenceReq);
      const regeneratedClaim = regenResult.data?.claim;
      if (!regeneratedClaim) {
        return jsonResponse({ detail: "inference regenerate claim returned empty claim" }, 503);
      }
      const sanitizedRefs = Array.isArray(regeneratedClaim.evidence_refs)
        ? regeneratedClaim.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (sanitizedRefs.length === 0) {
        return jsonResponse({ detail: "regenerated claim has empty evidence refs" }, 422);
      }
      const invalidRefs = sanitizedRefs.filter((ref) => !evidenceById.has(ref));
      if (invalidRefs.length > 0) {
        return jsonResponse({ detail: `regenerated claim references unknown evidence ids: ${invalidRefs.join(",")}` }, 422);
      }
      targetClaim.text = String(regeneratedClaim.text || "").trim() || targetClaim.text;
      targetClaim.evidence_refs = sanitizedRefs.slice(0, 3);
      targetClaim.confidence = Math.min(0.95, Math.max(0.35, Number(regeneratedClaim.confidence || targetClaim.confidence || 0.72)));

      const oldNeedsEvidenceCount = Number(report.quality?.needs_evidence_count || 0);
      const strictValidation = this.validateClaimEvidenceRefs(report);
      const validation = validatePersonFeedbackEvidence(report.per_person);
      if (!strictValidation.valid) {
        return jsonResponse({ detail: strictValidation.failures[0] || "claim validation failed" }, 422);
      }
      if (strictValidation.needsEvidenceCount > oldNeedsEvidenceCount) {
        return jsonResponse(
          {
            detail: "regeneration cannot increase needs_evidence_count",
            before: oldNeedsEvidenceCount,
            after: strictValidation.needsEvidenceCount
          },
          422
        );
      }
      const nowIso = this.currentIsoTs();
      report.quality = {
        ...report.quality,
        ...validation.quality,
        generated_at: nowIso,
        claim_count: strictValidation.claimCount,
        invalid_claim_count: strictValidation.invalidCount,
        needs_evidence_count: strictValidation.needsEvidenceCount,
        validation_ms: validation.quality.validation_ms,
        report_source: "llm_enhanced"
      };
      report.trace = {
        ...report.trace,
        report_pipeline: {
          mode: "memo_first_with_llm_polish",
          source: "llm_enhanced",
          llm_attempted: true,
          llm_success: true,
          llm_elapsed_ms: null,
          blocking_reason: null
        }
      };
      cache.updated_at = nowIso;
      cache.report = report;
      cache.person_summary_cache = report.per_person;
      cache.overall_summary_cache = report.overall;
      cache.quality = report.quality;
      cache.report_source = "llm_enhanced";
      cache.blocking_reason = null;
      cache.quality_gate_passed = cache.quality_gate_passed && strictValidation.valid;
      cache.ready = cache.quality_gate_passed && strictValidation.valid;
      await this.storeFeedbackCache(cache);

      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        quality: cache.quality,
        person: lookup.person
      });
    }

    if (action === "feedback-claim-evidence" && request.method === "POST") {
      let payload: FeedbackClaimEvidenceRequest;
      try {
        payload = await readJson<FeedbackClaimEvidenceRequest>(request);
      } catch (error) {
        log("error", "feedback-claim-evidence: request parse error", { sessionId, action: "feedback_claim_evidence", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      const personKey = String(payload.person_key || "").trim();
      const claimType = payload.claim_type;
      const dimension = payload.dimension;
      const evidenceRefs = Array.isArray(payload.evidence_refs)
        ? payload.evidence_refs.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      if (!personKey || !claimType || !dimension) {
        return badRequest("person_key, dimension and claim_type are required");
      }
      if (evidenceRefs.length === 0) {
        return jsonResponse({ detail: "evidence_refs cannot be empty" }, 422);
      }
      const cache = await this.maybeRefreshFeedbackCache(sessionId, true);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }
      const report = JSON.parse(JSON.stringify(cache.report)) as ResultV2;
      const lookup = this.findClaimInReport(report, {
        personKey,
        dimension,
        claimType,
        claimId: payload.claim_id
      });
      if (!lookup) {
        return jsonResponse({ detail: "claim not found" }, 404);
      }
      const evidenceById = new Map(report.evidence.map((item) => [item.evidence_id, item] as const));
      const unknownRefs = evidenceRefs.filter((ref) => !evidenceById.has(ref));
      if (unknownRefs.length > 0) {
        return jsonResponse({ detail: `unknown evidence ids: ${unknownRefs.slice(0, 5).join(",")}` }, 422);
      }
      const dedupedRefs: string[] = [];
      const seen = new Set<string>();
      for (const ref of evidenceRefs) {
        if (seen.has(ref)) continue;
        seen.add(ref);
        dedupedRefs.push(ref);
      }
      lookup.claim.evidence_refs = dedupedRefs.slice(0, 5);
      this.downWeightClaimConfidenceByEvidence(lookup.claim, evidenceById);

      const strictValidation = this.validateClaimEvidenceRefs(report);
      if (!strictValidation.valid) {
        return jsonResponse({ detail: strictValidation.failures[0] || "claim validation failed" }, 422);
      }
      const validation = validatePersonFeedbackEvidence(report.per_person);
      const nowIso = this.currentIsoTs();
      report.quality = {
        ...report.quality,
        ...validation.quality,
        generated_at: nowIso,
        claim_count: strictValidation.claimCount,
        invalid_claim_count: strictValidation.invalidCount,
        needs_evidence_count: strictValidation.needsEvidenceCount
      };
      cache.updated_at = nowIso;
      cache.report = report;
      cache.person_summary_cache = report.per_person;
      cache.overall_summary_cache = report.overall;
      cache.evidence_index_cache = this.buildEvidenceIndex(report.per_person);
      cache.quality = report.quality;
      cache.blocking_reason = null;
      cache.ready = cache.quality_gate_passed && strictValidation.valid
        && ACCEPTED_REPORT_SOURCES.has(cache.report_source);
      await this.storeFeedbackCache(cache);
      return jsonResponse({
        session_id: sessionId,
        ready: cache.ready,
        quality: cache.quality,
        claim: lookup.claim
      });
    }

    if (action === "export" && request.method === "POST") {
      let payload: FeedbackExportRequest = {};
      try {
        payload = await readJson<FeedbackExportRequest>(request);
      } catch {
        // keep empty payload for default format
      }
      const format = (payload.format ?? "plain_text") as "plain_text" | "markdown" | "docx";
      const fileStem = String(payload.file_name || `${sessionId}-feedback`).trim() || `${sessionId}-feedback`;
      const cache = await this.maybeRefreshFeedbackCache(sessionId, false);
      if (!cache.report) {
        return jsonResponse({ detail: "feedback report not ready" }, 503);
      }

      if (format === "plain_text") {
        const content = buildReportExportText(cache.report);
        return jsonResponse({
          session_id: sessionId,
          format,
          file_name: `${fileStem}.txt`,
          mime_type: "text/plain; charset=utf-8",
          encoding: "utf-8",
          content
        });
      }

      if (format === "markdown") {
        const content = buildReportExportMarkdown(cache.report);
        return jsonResponse({
          session_id: sessionId,
          format,
          file_name: `${fileStem}.md`,
          mime_type: "text/markdown; charset=utf-8",
          encoding: "utf-8",
          content
        });
      }

      const text = buildReportExportText(cache.report);
      const docxBytes = buildDocxBytesFromText(text);
      return jsonResponse({
        session_id: sessionId,
        format: "docx",
        file_name: `${fileStem}.docx`,
        mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        encoding: "base64",
        content: bytesToBase64(docxBytes)
      });
    }

    if (action === "speaker-logs" && request.method === "POST") {
      let payload: Record<string, unknown>;
      try {
        payload = await readJson<Record<string, unknown>>(request);
      } catch (error) {
        log("error", "speaker-logs: request parse error", { sessionId, action: "speaker_logs", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      return this.enqueueMutation(async () => {
        const now = this.currentIsoTs();
        const current = await this.loadSpeakerLogs();
        let parsed: SpeakerLogs;
        try {
          parsed = parseSpeakerLogsPayload(payload, now);
        } catch (error) {
          log("error", "speaker-logs: payload parse error", { sessionId, action: "speaker_logs", error: getErrorMessage(error) });
          return badRequest("Request processing failed");
        }
        const merged = mergeSpeakerLogs(current, parsed);
        await this.storeSpeakerLogs(merged);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);

        // Async embedding extraction — non-blocking background work.
        // Populates the EmbeddingCache for global clustering at finalization.
        if (merged.source === "edge" && merged.turns.length > 0) {
          const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
          if (state.config?.diarization_backend === "edge") {
            this.ctx.waitUntil(
              this.extractEmbeddingsForTurns(sessionId, merged, "students")
                .catch(() => { /* non-critical: clustering works with partial embeddings */ })
            );
          }
        }

        return jsonResponse({
          session_id: sessionId,
          source: merged.source,
          turns: merged.turns.length,
          clusters: merged.clusters.length,
          speaker_map: merged.speaker_map.length,
          embedding_cache_size: this.embeddingCache.size,
          updated_at: merged.updated_at
        });
      });
    }

    if (action === "finalize-status" && request.method === "GET") {
      const status = await this.failStuckFinalizeIfNeeded("status-poll");
      if (!status) {
        return jsonResponse({
          session_id: sessionId,
          status: "idle",
          stage: "idle",
          progress: 0,
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2"
        });
      }
      const jobId = String(url.searchParams.get("job_id") ?? "").trim();
      if (jobId && jobId !== status.job_id) {
        return jsonResponse({ detail: "job_id not found", job_id: jobId }, 404);
      }
      const stageCheckpoint = await this.loadFinalizeStageCheckpoint();
      return jsonResponse({
        session_id: sessionId,
        ...status,
        stage_checkpoint: stageCheckpoint ? {
          completed_stage: stageCheckpoint.completed_stage,
          saved_at: stageCheckpoint.saved_at
        } : null
      });
    }

    if (action === "cluster-map" && request.method === "POST") {
      let payload: ClusterMapRequest;
      try {
        payload = await readJson<ClusterMapRequest>(request);
      } catch (error) {
        log("error", "cluster-map: request parse error", { sessionId, action: "cluster_map", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }
      const streamRole = parseStreamRole(payload.stream_role ?? "students", "students");
      if (streamRole !== "students") {
        return badRequest("cluster-map only supports stream_role=students");
      }
      const clusterId = String(payload.cluster_id ?? "").trim();
      const participantNameRaw = String(payload.participant_name ?? "").trim();
      const mode = payload.mode === "prebind" ? "prebind" : "bind";
      if (!clusterId || !participantNameRaw) {
        return badRequest("cluster_id and participant_name are required");
      }
      return this.enqueueMutation(async () => {
        const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        const participantName = this.rosterNameByCandidate(state, participantNameRaw) ?? participantNameRaw;
        const now = this.currentIsoTs();
        const existingCluster = state.clusters.find((cluster) => cluster.cluster_id === clusterId);
        if (!existingCluster) {
          if (mode !== "prebind") {
            return jsonResponse(
              {
                detail: "cluster_id not found in state.clusters",
                cluster_id: clusterId,
                available_cluster_ids: state.clusters.map((item) => item.cluster_id)
              },
              400
            );
          }
          state.prebind_by_cluster[clusterId] = {
            participant_name: participantName,
            source: "manual_map",
            confidence: 1,
            locked: payload.lock !== false,
            updated_at: now
          };
          await this.ctx.storage.put(STORAGE_KEY_STATE, state);
          await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);
          return jsonResponse({
            session_id: sessionId,
            cluster_id: clusterId,
            participant_name: participantName,
            mode: "prebind",
            binding_locked: payload.lock !== false,
            prebind_meta: state.prebind_by_cluster[clusterId]
          });
        }

        state.bindings[clusterId] = participantName;
        existingCluster.bound_name = participantName;
        delete state.prebind_by_cluster[clusterId];
        state.cluster_binding_meta[clusterId] = {
          participant_name: participantName,
          source: "manual_map",
          confidence: 1,
          locked: payload.lock !== false,
          updated_at: now
        }
        if (state.enrollment_state?.unassigned_clusters?.[clusterId]) {
          delete state.enrollment_state.unassigned_clusters[clusterId];
          state.enrollment_state.updated_at = now;
        }
        await this.ctx.storage.put(STORAGE_KEY_STATE, state);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, now);
        await this.appendSpeakerEvent({
          ts: now,
          stream_role: "students",
          source: "manual_map",
          identity_source: "manual_map",
          utterance_id: null,
          cluster_id: clusterId,
          speaker_name: participantName,
          decision: "auto",
          evidence: null,
          note: `cluster ${clusterId} mapped to ${participantName}`,
          backend: "worker",
          fallback_reason: null,
          confidence_bucket: "high",
          metadata: {
            binding_locked: payload.lock !== false
          }
        });
        return jsonResponse({
          session_id: sessionId,
          cluster_id: clusterId,
          participant_name: participantName,
          mode: "bind",
          binding_locked: payload.lock !== false,
          cluster_binding_meta: state.cluster_binding_meta[clusterId]
        });
      });
    }

    if (action === "unresolved-clusters" && request.method === "GET") {
      const state = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
      const events = await this.loadSpeakerEvents();
      const utterances = await this.loadUtterancesRawByStream();
      const utteranceById = new Map(utterances.students.map((item) => [item.utterance_id, item]));
      const recentStudentEvents = events.filter((item) => item.stream_role === "students");
      const latestByCluster = new Map<string, SpeakerEvent>();
      for (const event of recentStudentEvents) {
        if (!event.cluster_id) continue;
        latestByCluster.set(event.cluster_id, event);
      }
      const items = state.clusters
        .map((cluster) => {
          const meta = state.cluster_binding_meta[cluster.cluster_id];
          const latest = latestByCluster.get(cluster.cluster_id);
          const utterance =
            latest?.utterance_id && utteranceById.has(latest.utterance_id) ? utteranceById.get(latest.utterance_id) : null;
          const unresolved = !state.bindings[cluster.cluster_id] || (meta ? !meta.locked : true);
          return {
            cluster_id: cluster.cluster_id,
            sample_count: cluster.sample_count,
            bound_name: cluster.bound_name ?? null,
            unresolved,
            binding_meta: meta ?? null,
            latest_decision: latest?.decision ?? null,
            latest_text: utterance?.text ?? null,
            latest_ts: latest?.ts ?? null
          };
        })
        .filter((item) => item.unresolved || item.latest_decision === "unknown");
      return jsonResponse({
        session_id: sessionId,
        count: items.length,
        items
      });
    }

    if (action === "events" && request.method === "GET") {
      const streamRoleRaw = url.searchParams.get("stream_role");
      let filteredRole: StreamRole | null = null;
      if (streamRoleRaw) {
        try {
          filteredRole = parseStreamRole(streamRoleRaw, "mixed");
        } catch (error) {
          log("error", "events: stream role parse error", { sessionId, action: "events", error: getErrorMessage(error) });
          return badRequest("Request processing failed");
        }
      }
      const urlLimit = Number(url.searchParams.get("limit") ?? "100");
      const limit = Number.isInteger(urlLimit) && urlLimit > 0 ? Math.min(urlLimit, 2000) : 100;
      const events = await this.loadSpeakerEvents();
      const scoped = filteredRole ? events.filter((item) => item.stream_role === filteredRole) : events;
      const normalizedItems = scoped.slice(-limit).map((item) => ({
        ...item,
        backend: item.backend ?? (item.source === "inference_resolve" ? "primary" : "worker"),
        fallback_reason: item.fallback_reason ?? null,
        confidence_bucket: item.confidence_bucket ?? this.confidenceBucketFromEvidence(item.evidence)
      }));
      return jsonResponse({
        session_id: sessionId,
        stream_role: filteredRole ?? "all",
        count: scoped.length,
        limit,
        items: normalizedItems
      });
    }

    if (action === "utterances" && request.method === "GET") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        log("error", "utterances: stream role parse error", { sessionId, action: "utterances", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      const view = String(url.searchParams.get("view") ?? "raw").trim().toLowerCase();
      if (!["raw", "merged"].includes(view)) {
        return badRequest("view must be raw or merged");
      }

      const urlLimit = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isInteger(urlLimit) && urlLimit > 0 ? Math.min(urlLimit, 1000) : 50;

      if (view === "raw") {
        const raw = await this.loadUtterancesRawByStream();
        const items = raw[streamRole].slice(-limit);
        return jsonResponse({
          session_id: sessionId,
          stream_role: streamRole,
          view,
          count: raw[streamRole].length,
          limit,
          items
        });
      }

      const raw = await this.loadUtterancesRawByStream();
      const merged = await this.loadUtterancesMergedByStream();
      merged[streamRole] = mergeUtterances(raw[streamRole]);
      await this.storeUtterancesMergedByStream(merged);
      const items = merged[streamRole].slice(-limit);
      return jsonResponse({
        session_id: sessionId,
        stream_role: streamRole,
        view,
        count: merged[streamRole].length,
        limit,
        items
      });
    }

    if (action === "asr-run" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        log("error", "asr-run: stream role parse error", { sessionId, action: "asr_run", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      const queryMax = Number(url.searchParams.get("max_windows") ?? "0");
      const maxWindows = Number.isInteger(queryMax) && queryMax > 0 ? queryMax : 0;
      const result = await this.maybeRunAsrWindows(sessionId, streamRole, true, maxWindows);
      return jsonResponse({
        session_id: sessionId,
        stream_role: streamRole,
        ...result
      });
    }

    if (action === "asr-reset" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        log("error", "asr-reset: stream role parse error", { sessionId, action: "asr_reset", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      return this.enqueueMutation(async () => {
        const [asrByStream, rawByStream, mergedByStream, events] = await Promise.all([
          this.loadAsrByStream(),
          this.loadUtterancesRawByStream(),
          this.loadUtterancesMergedByStream(),
          this.loadSpeakerEvents()
        ]);

        const removedRaw = rawByStream[streamRole].length;
        const removedMerged = mergedByStream[streamRole].length;
        const removedEvents = events.filter((item) => item.stream_role === streamRole).length;

        rawByStream[streamRole] = [];
        mergedByStream[streamRole] = [];
        asrByStream[streamRole] = this.buildDefaultAsrState();

        await this.storeUtterancesRawByStream(rawByStream);
        await this.storeUtterancesMergedByStream(mergedByStream);
        await this.storeAsrByStream(asrByStream);
        await this.storeSpeakerEvents(events.filter((item) => item.stream_role !== streamRole));
        await this.closeRealtimeAsrSession(streamRole, "asr-reset", true);
        await this.patchAsrCursor(streamRole, {
          last_ingested_seq: 0,
          last_sent_seq: 0,
          last_emitted_seq: 0
        });

        return jsonResponse({
          session_id: sessionId,
          stream_role: streamRole,
          removed_raw: removedRaw,
          removed_merged: removedMerged,
          removed_events: removedEvents,
          message: "asr state and utterances reset; chunks kept in R2"
        });
      });
    }

    if (action === "tier2-status" && request.method === "GET") {
      const tier2 = await this.loadTier2Status();
      return jsonResponse({
        session_id: sessionId,
        ...tier2
      });
    }

    if (action === "incremental-status" && request.method === "GET") {
      const incrementalStatus = await this.loadIncrementalStatus();
      return jsonResponse({
        session_id: sessionId,
        ...incrementalStatus
      });
    }

    if (action === "result" && request.method === "GET") {
      const version = String(url.searchParams.get("version") ?? "v1").trim().toLowerCase();
      const key =
        version === "v2"
          ? (await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY_V2)) ?? resultObjectKeyV2(sessionId)
          : (await this.ctx.storage.get<string>(STORAGE_KEY_RESULT_KEY)) ?? resultObjectKey(sessionId);
      const object = await this.env.RESULT_BUCKET.get(key);
      if (!object) {
        return jsonResponse({ detail: `result not found for version=${version}` }, 404);
      }
      const content = await object.text();
      return new Response(content, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "x-result-version": version
        }
      });
    }

    if (action === "resolve" && request.method === "POST") {
      let streamRole: StreamRole;
      try {
        streamRole = parseStreamRole(url.searchParams.get("stream_role"), "mixed");
      } catch (error) {
        log("error", "resolve: stream role parse error", { sessionId, action: "resolve", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
      const scopedIdemKey = idempotencyKey ? `${streamRole}:${idempotencyKey}` : "";
      if (scopedIdemKey) {
        const cached = await this.ctx.storage.get<ResolveResponse>(`idempotency:${scopedIdemKey}`);
        if (cached) {
          return jsonResponse(cached, 200, { "x-idempotent-replay": "true" });
        }
      }

      let payload: ResolveRequest;
      try {
        payload = await readJson<ResolveRequest>(request);
      } catch (error) {
        log("error", "resolve: request parse error", { sessionId, action: "resolve", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      if (!payload?.audio?.content_b64 || !payload?.audio?.format) {
        return badRequest("audio.content_b64 and audio.format are required");
      }

      return this.enqueueMutation(async () => {
        const currentState = normalizeSessionState(await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE));
        if (payload.roster && payload.roster.length > 0) {
          currentState.roster = payload.roster;
        }

        let resolved: ResolveResponse;
        let resolveBackend: "primary" | "secondary" = "primary";
        let degraded = false;
        let resolveWarnings: string[] = [];
        let resolveTimeline: InferenceBackendTimelineItem[] = [];
        try {
          const resolveCall = await this.invokeInferenceResolve(sessionId, payload.audio, payload.asr_text ?? null, currentState);
          resolved = resolveCall.resolved;
          resolveBackend = resolveCall.backend;
          degraded = resolveCall.degraded;
          resolveWarnings = resolveCall.warnings;
          resolveTimeline = resolveCall.timeline;
        } catch (error) {
          log("error", "inference resolve failed", { sessionId, action: "resolve", error: getErrorMessage(error) });
          return jsonResponse({ detail: "Speaker resolution temporarily unavailable" }, 502);
        }

        const mergedState = normalizeSessionState({
          ...resolved.updated_state,
          capture_by_stream: currentState.capture_by_stream
        });
        resolved.updated_state = mergedState;
        const boundSpeakerName =
          resolved.speaker_name ??
          mergedState.bindings[resolved.cluster_id] ??
          mergedState.clusters.find((item) => item.cluster_id === resolved.cluster_id)?.bound_name ??
          null;
        resolved.speaker_name = boundSpeakerName;
        await this.ctx.storage.put(STORAGE_KEY_STATE, mergedState);
        await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());

        await this.appendSpeakerEvent({
          ts: new Date().toISOString(),
          stream_role: streamRole,
          source: "inference_resolve",
          identity_source: identitySourceFromBindingSource(resolved.evidence.binding_source),
          utterance_id: null,
          cluster_id: resolved.cluster_id,
          speaker_name: boundSpeakerName,
          decision: resolved.decision,
          evidence: resolved.evidence,
          backend: resolveBackend,
          fallback_reason: degraded ? "inference_failover" : null,
          confidence_bucket: this.confidenceBucketFromEvidence(resolved.evidence),
          metadata: {
            profile_score: resolved.evidence.profile_top_score ?? null,
            profile_margin: resolved.evidence.profile_margin ?? null,
            binding_locked: mergedState.cluster_binding_meta[resolved.cluster_id]?.locked ?? false,
            warnings: resolveWarnings,
            timeline: resolveTimeline
          }
        });

        if (scopedIdemKey) {
          await this.ctx.storage.put(`idempotency:${scopedIdemKey}`, resolved);
        }

        return jsonResponse(resolved);
      });
    }

    if (action === "finalize" && request.method === "POST") {
      let payload: FinalizeRequest = {};
      try {
        payload = await readJson<FinalizeRequest>(request);
      } catch (error) {
        log("error", "finalize: request parse error", { sessionId, action: "finalize", error: getErrorMessage(error) });
        return badRequest("Request processing failed");
      }

      const version = String(url.searchParams.get("version") ?? "v1").trim().toLowerCase();
      if (version === "v2") {
        if (!this.finalizeV2Enabled()) {
          return jsonResponse({ detail: "finalize v2 is disabled" }, 503);
        }
        await this.failStuckFinalizeIfNeeded("enqueue");
        const current = await this.loadFinalizeV2Status();
        if (current && (current.status === "queued" || current.status === "running")) {
          return jsonResponse({
            session_id: sessionId,
            job_id: current.job_id,
            status: current.status,
            stage: current.stage,
            progress: current.progress,
            warnings: current.warnings,
            degraded: current.degraded,
            backend_used: current.backend_used,
            version: "v2"
          });
        }
        const nextStatus: FinalizeV2Status = {
          job_id: `fv2_${crypto.randomUUID()}`,
          status: "queued",
          stage: "freeze",
          progress: 0,
          errors: [],
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2",
          started_at: this.currentIsoTs(),
          heartbeat_at: this.currentIsoTs(),
          finished_at: null
        };
        await this.storeFinalizeV2Status(nextStatus);
        // E6: Transition to finalizing phase
        await this.setSessionPhase("finalizing");
        const mode = (payload as Record<string, unknown>).mode === 'report-only' ? 'report-only' : 'full';
        this.ctx.waitUntil(
          this.enqueueMutation(async () => {
            await this.runFinalizeV2Job(sessionId, nextStatus.job_id, payload.metadata ?? {}, mode);
          })
        );
        return jsonResponse({
          session_id: sessionId,
          job_id: nextStatus.job_id,
          status: "queued",
          warnings: [],
          degraded: false,
          backend_used: "primary",
          version: "v2"
        });
      }

      const [state, events, ingestByStream, rawByStream, mergedByStream, asrByStream] = await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.loadSpeakerEvents(),
        this.loadIngestByStream(sessionId),
        this.loadUtterancesRawByStream(),
        this.loadUtterancesMergedByStream(),
        this.loadAsrByStream()
      ]);
      mergedByStream.mixed = mergeUtterances(rawByStream.mixed);
      mergedByStream.teacher = mergeUtterances(rawByStream.teacher);
      mergedByStream.students = mergeUtterances(rawByStream.students);
      await this.storeUtterancesMergedByStream(mergedByStream);

      const finalizedAt = new Date().toISOString();
      const normalizedState = normalizeSessionState(state);
      const result = {
        session_id: sessionId,
        finalized_at: finalizedAt,
        state: normalizedState,
        events,
        ingest: ingestStatusPayload(sessionId, "mixed", ingestByStream.mixed),
        ingest_by_stream: this.ingestByStreamPayload(sessionId, ingestByStream),
        capture_by_stream: normalizedState.capture_by_stream,
        enrollment_state: normalizedState.enrollment_state,
        participant_profiles: normalizedState.participant_profiles,
        cluster_binding_meta: normalizedState.cluster_binding_meta,
        asr: asrByStream.mixed,
        asr_by_stream: asrByStream,
        utterances_raw: rawByStream.mixed,
        utterances_raw_by_stream: rawByStream,
        utterances_merged_by_stream: mergedByStream,
        metadata: payload.metadata ?? {}
      };

      const key = resultObjectKey(sessionId);
      await this.env.RESULT_BUCKET.put(key, JSON.stringify(result), {
        httpMetadata: {
          contentType: "application/json"
        }
      });

      await this.ctx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
      await this.ctx.storage.put(STORAGE_KEY_RESULT_KEY, key);

      return jsonResponse({
        session_id: sessionId,
        result_key: key,
        event_count: events.length,
        finalized_at: finalizedAt
      });
    }

    // ── GDPR: Purge all session data ──────────────────────────────────
    if (action === "purge-data" && request.method === "DELETE") {
      const startMs = Date.now();
      const summary: Record<string, number> = { do_keys: 0, r2_objects: 0, r2_history: 0 };

      // 1. Delete all R2 objects under sessions/{sessionId}/
      const safeId = safeObjectSegment(sessionId);
      const r2Prefix = `sessions/${safeId}/`;
      let cursor: string | undefined;
      do {
        const listing = await this.env.RESULT_BUCKET.list({ prefix: r2Prefix, cursor, limit: R2_LIST_LIMIT });
        if (listing.objects.length > 0) {
          await Promise.all(listing.objects.map((obj) => this.env.RESULT_BUCKET.delete(obj.key)));
          summary.r2_objects += listing.objects.length;
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);

      // 2. Delete history index entries matching this session
      const historyPrefix = HISTORY_PREFIX;
      const historySuffix = `_${safeId}.json`;
      cursor = undefined;
      do {
        const listing = await this.env.RESULT_BUCKET.list({ prefix: historyPrefix, cursor, limit: R2_LIST_LIMIT });
        const matching = listing.objects.filter((obj) => obj.key.endsWith(historySuffix));
        if (matching.length > 0) {
          await Promise.all(matching.map((obj) => this.env.RESULT_BUCKET.delete(obj.key)));
          summary.r2_history += matching.length;
        }
        cursor = listing.truncated ? (listing.cursor ?? undefined) : undefined;
      } while (cursor);

      // 3. Delete all Durable Object storage (atomic wipe)
      await this.ctx.storage.deleteAll();
      summary.do_keys = 1; // deleteAll() is atomic — count as single wipe operation

      log("info", "gdpr-purge: completed", { component: "gdpr-purge", session_id: sessionId, r2_objects: summary.r2_objects, r2_history: summary.r2_history, elapsed_ms: Date.now() - startMs });

      return jsonResponse({
        session_id: sessionId,
        purged: true,
        summary,
        elapsed_ms: Date.now() - startMs
      });
    }

    return jsonResponse({ detail: "route not found" }, 404);
  }
}
