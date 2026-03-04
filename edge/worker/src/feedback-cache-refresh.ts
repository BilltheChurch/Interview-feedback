/**
 * feedback-cache-refresh.ts — Feedback cache refresh logic.
 *
 * Extracted from MeetingSessionDO to reduce index.ts size.
 * Standalone async function with explicit context rather than `this`.
 */

import {
  attachEvidenceToMemos,
  buildEvidence,
  buildMemoFirstReport,
  buildResultV2,
  computeSpeakerStats,
  validatePersonFeedbackEvidence,
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { buildReconciledTranscript } from "./reconcile";
import {
  normalizeSessionState,
  getSessionLocale,
  defaultCaptureByStream,
  STORAGE_KEY_STATE,
  STORAGE_KEY_CAPTION_SOURCE,
  FEEDBACK_REFRESH_INTERVAL_MS,
  FEEDBACK_TOTAL_BUDGET_MS,
  FEEDBACK_ASSEMBLE_BUDGET_MS,
  FEEDBACK_EVENTS_BUDGET_MS,
  FEEDBACK_REPORT_BUDGET_MS,
  FEEDBACK_VALIDATE_BUDGET_MS,
  FEEDBACK_PERSIST_FETCH_BUDGET_MS,
  DASHSCOPE_DEFAULT_MODEL,
} from "./config";
import type { Env, StreamRole, SessionState, CaptureState, AsrState } from "./config";
import type { UtteranceRaw, SpeakerEvent } from "./config";
import type { FeedbackCache } from "./config";
import type {
  FinalizeV2Status,
  PersonFeedbackItem,
  ReportQualityMeta,
  ResultV2,
  SpeakerStatItem,
  SpeakerLogs,
  MemoItem,
} from "./types_v2";
import type { InferenceBackendTimelineItem } from "./inference_client";
import {
  buildEvidenceIndex,
  buildQualityMetrics,
  evaluateFeedbackQualityGates,
  mergeStatsWithRoster,
  validateClaimEvidenceRefs,
} from "./feedback-helpers";

// ── Context interface ──────────────────────────────────────────────────────

export interface FeedbackCacheRefreshContext {
  env: Env;
  storage: DurableObjectStorage;
  captionSource: "none" | "acs-teams";
  setCaptionSource: (source: "none" | "acs-teams") => void;

  loadFeedbackCache: (sessionId: string) => Promise<FeedbackCache>;
  storeFeedbackCache: (cache: FeedbackCache) => Promise<void>;
  loadFinalizeV2Status: () => Promise<FinalizeV2Status | null>;
  loadSpeakerEvents: () => Promise<SpeakerEvent[]>;
  loadUtterancesRawByStream: () => Promise<Record<StreamRole, UtteranceRaw[]>>;
  loadMemos: () => Promise<MemoItem[]>;
  loadSpeakerLogs: () => Promise<SpeakerLogs>;
  loadAsrByStream: () => Promise<Record<StreamRole, AsrState>>;
  currentIsoTs: () => string;

  invokeInferenceAnalysisEvents: (payload: Record<string, unknown>) => Promise<{
    events: Record<string, unknown>[];
    backend_used: "primary" | "secondary" | "local";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
    fallback_reason: string | null;
  }>;
  invokeInferenceAnalysisReport: (payload: Record<string, unknown>) => Promise<{
    data: Record<string, unknown>;
    backend_used: "primary" | "secondary";
    degraded: boolean;
    warnings: string[];
    timeline: InferenceBackendTimelineItem[];
  }>;

  deriveSpeakerLogsFromTranscript: (nowIso: string, transcript: TranscriptItem[], state: SessionState, existing: SpeakerLogs, source: "cloud" | "edge") => SpeakerLogs;
  buildEdgeSpeakerLogsForFinalize: (nowIso: string, existing: SpeakerLogs, state: SessionState) => SpeakerLogs;
}

// ── Main function ──────────────────────────────────────────────────────────

export async function maybeRefreshFeedbackCache(
  ctx: FeedbackCacheRefreshContext,
  sessionId: string,
  force = false
): Promise<FeedbackCache> {
  const current = await ctx.loadFeedbackCache(sessionId);
  const nowMs = Date.now();
  const updatedMs = Date.parse(current.updated_at);
  if (!force && Number.isFinite(updatedMs) && nowMs - updatedMs < FEEDBACK_REFRESH_INTERVAL_MS) {
    return current;
  }

  // Guard: do not rebuild cache while finalizeV2 is actively running
  const v2Status = await ctx.loadFinalizeV2Status();
  if (v2Status && (v2Status.status === "running" || v2Status.status === "queued")) {
    return current;
  }

  // Rehydrate captionSource from DO storage
  if (ctx.captionSource === "none") {
    const persisted = await ctx.storage.get<string>(STORAGE_KEY_CAPTION_SOURCE);
    if (persisted === "acs-teams") ctx.setCaptionSource("acs-teams");
  }

  // Guard: caption-mode sessions must NEVER use the audio-only rebuild path
  if (ctx.captionSource === "acs-teams") {
    return current;
  }

  const totalStart = Date.now();
  const assembleStart = Date.now();
  const [stateRaw, events, rawByStream, memos, speakerLogsStored, asrByStream] = await Promise.all([
    ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
    ctx.loadSpeakerEvents(),
    ctx.loadUtterancesRawByStream(),
    ctx.loadMemos(),
    ctx.loadSpeakerLogs(),
    ctx.loadAsrByStream(),
  ]);
  const state = normalizeSessionState(stateRaw);
  const diarizationBackend = state.config?.diarization_backend === "edge" ? "edge" : "cloud";
  const transcript = buildReconciledTranscript({
    utterances: [...rawByStream.teacher, ...rawByStream.students],
    events,
    speakerLogs: speakerLogsStored,
    state,
    diarizationBackend,
    roster: (state.roster ?? []).flatMap((r) => [r.name, ...(r.aliases ?? [])]),
  });
  const stats = mergeStatsWithRoster(computeSpeakerStats(transcript), state);
  const evidence = buildEvidence({ memos, transcript });
  const memosWithEvidence = attachEvidenceToMemos(memos, evidence);
  const memoFirst = buildMemoFirstReport({
    transcript,
    memos: memosWithEvidence,
    evidence,
    stats,
  });
  const assembleMs = Date.now() - assembleStart;

  const locale = getSessionLocale(state, ctx.env);
  const eventsStart = Date.now();
  const eventsPayload = {
    session_id: sessionId,
    transcript,
    memos: memosWithEvidence,
    stats,
    locale,
  };
  const eventsResult = await ctx.invokeInferenceAnalysisEvents(eventsPayload);
  const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
  const eventsMs = Date.now() - eventsStart;

  let reportSource: "memo_first" | "llm_enhanced" | "llm_failed" = "memo_first";
  let reportModel: string | null = null;
  let reportError: string | null = null;
  let reportBlockingReason: string | null = null;
  let finalOverall = memoFirst.overall;
  let finalPerPerson = memoFirst.per_person;
  let reportTimeline: InferenceBackendTimelineItem[] = [];
  const reportStart = Date.now();
  try {
    const reportResult = await ctx.invokeInferenceAnalysisReport({
      session_id: sessionId,
      transcript,
      memos: memosWithEvidence,
      stats,
      evidence,
      events: analysisEvents,
      locale,
    });
    reportTimeline = reportResult.timeline;
    const payload = reportResult.data;
    const candidatePerPerson = Array.isArray(payload?.per_person) ? (payload.per_person as PersonFeedbackItem[]) : [];
    const candidateOverall = (payload?.overall ?? memoFirst.overall) as unknown;
    const candidateQuality =
      payload?.quality && typeof payload.quality === "object" ? (payload.quality as Partial<ReportQualityMeta>) : null;
    if (candidatePerPerson.length > 0) {
      const candidateValidation = validateClaimEvidenceRefs({
        evidence,
        per_person: candidatePerPerson,
      } as ResultV2);
      if (candidateValidation.valid) {
        finalPerPerson = candidatePerPerson;
        finalOverall = candidateOverall;
        reportSource = "llm_enhanced";
        const source = String(candidateQuality?.report_source || "").trim();
        if (source === "llm_failed") {
          reportSource = "llm_failed";
        }
        if (source === "memo_first") {
          reportSource = "memo_first";
        }
        reportModel = typeof candidateQuality?.report_model === "string" ? candidateQuality.report_model : null;
        reportError = typeof candidateQuality?.report_error === "string" ? candidateQuality.report_error : null;
      } else {
        reportSource = "llm_failed";
        reportBlockingReason = `analysis/report invalid evidence refs: ${candidateValidation.failures[0] || "unknown"}`;
      }
    } else {
      reportSource = "llm_failed";
      reportBlockingReason = "analysis/report returned empty per_person";
    }
  } catch (error) {
    reportSource = "llm_failed";
    reportError = String((error as Error)?.message ?? error);
    reportBlockingReason = `analysis/report failed: ${reportError}`;
  }
  const reportMs = Date.now() - reportStart;

  const validateStart = Date.now();
  const finalValidation = validateClaimEvidenceRefs({
    evidence,
    per_person: finalPerPerson,
  } as ResultV2);
  const validation = validatePersonFeedbackEvidence(finalPerPerson);
  const validationMs = Date.now() - validateStart;

  const unresolvedClusterCount = state.clusters.filter((cluster) => {
    const bound = state.bindings[cluster.cluster_id];
    const meta = state.cluster_binding_meta[cluster.cluster_id];
    return !bound || !meta || !meta.locked;
  }).length;
  const totalClusters = state.clusters.length;
  const unresolvedRatio = totalClusters > 0 ? unresolvedClusterCount / totalClusters : 0;
  const confidenceLevel: "high" | "medium" | "low" =
    unresolvedRatio === 0 ? "high" :
    unresolvedRatio <= 0.25 ? "medium" : "low";
  const qualityMetrics = buildQualityMetrics(transcript, state.capture_by_stream ?? defaultCaptureByStream());
  const ingestP95Ms =
    typeof asrByStream.students.ingest_to_utterance_p95_ms === "number"
      ? asrByStream.students.ingest_to_utterance_p95_ms
      : null;
  const gateSeedFailures = [...finalValidation.failures];
  if (reportSource !== "llm_enhanced") {
    gateSeedFailures.push(reportBlockingReason || "llm enhanced report unavailable");
  }
  const gateEvaluation = evaluateFeedbackQualityGates({
    unknownRatio: qualityMetrics.unknown_ratio,
    ingestP95Ms,
    claimValidationFailures: gateSeedFailures,
  });
  const tentative = confidenceLevel === "low" || !gateEvaluation.passed;
  const finalizedAt = ctx.currentIsoTs();
  const quality: ReportQualityMeta = {
    ...validation.quality,
    generated_at: finalizedAt,
    build_ms: assembleMs + eventsMs + reportMs,
    validation_ms: validationMs,
    claim_count: finalValidation.claimCount,
    invalid_claim_count: finalValidation.invalidCount,
    needs_evidence_count: finalValidation.needsEvidenceCount,
    report_source: reportSource,
    report_model: reportModel,
    report_degraded: reportSource !== "llm_enhanced",
    report_error: reportError,
  };

  const backendTimeline: InferenceBackendTimelineItem[] = [
    ...eventsResult.timeline,
    ...reportTimeline,
  ];
  const qualityGateSnapshot = {
    finalize_success_target: 0.995,
    students_unknown_ratio_target: 0.25,
    sv_top1_target: 0.90,
    echo_reduction_target: 0.8,
    observed_unknown_ratio: qualityMetrics.unknown_ratio,
    observed_students_turns: qualityMetrics.students_utterance_count,
    observed_students_unknown: qualityMetrics.students_unknown_count,
    observed_echo_suppressed_chunks: qualityMetrics.echo_suppressed_chunks,
    observed_echo_recent_rate: qualityMetrics.echo_suppression_recent_rate,
    observed_echo_leak_rate: qualityMetrics.echo_leak_rate,
    observed_suppression_false_positive_rate: qualityMetrics.suppression_false_positive_rate,
  };

  const result = buildResultV2({
    sessionId,
    finalizedAt,
    tentative,
    confidenceLevel,
    unresolvedClusterCount,
    diarizationBackend,
    captionSource: ctx.captionSource,
    transcript,
    speakerLogs:
      diarizationBackend === "edge"
        ? ctx.buildEdgeSpeakerLogsForFinalize(finalizedAt, speakerLogsStored, state)
        : ctx.deriveSpeakerLogsFromTranscript(finalizedAt, transcript, state, speakerLogsStored, "cloud"),
    stats,
    memos,
    evidence,
    overall: finalOverall,
    perPerson: finalPerPerson,
    quality,
    finalizeJobId: `feedback-open-${crypto.randomUUID()}`,
    modelVersions: {
      asr: DASHSCOPE_DEFAULT_MODEL,
      analysis_events_path: ctx.env.INFERENCE_EVENTS_PATH ?? "/analysis/events",
      analysis_report_path: ctx.env.INFERENCE_REPORT_PATH ?? "/analysis/report",
      summary_mode: "memo_first_with_llm_polish",
    },
    thresholds: {
      feedback_total_budget_ms: FEEDBACK_TOTAL_BUDGET_MS,
      feedback_assemble_budget_ms: FEEDBACK_ASSEMBLE_BUDGET_MS,
      feedback_events_budget_ms: FEEDBACK_EVENTS_BUDGET_MS,
      feedback_report_budget_ms: FEEDBACK_REPORT_BUDGET_MS,
      feedback_validate_budget_ms: FEEDBACK_VALIDATE_BUDGET_MS,
      feedback_persist_fetch_budget_ms: FEEDBACK_PERSIST_FETCH_BUDGET_MS,
    },
    backendTimeline,
    qualityGateSnapshot,
    reportPipeline: {
      mode: "memo_first_with_llm_polish",
      source: reportSource,
      llm_attempted: true,
      llm_success: reportSource === "llm_enhanced",
      llm_elapsed_ms: reportMs,
      blocking_reason: reportBlockingReason,
    },
    qualityGateFailures: gateEvaluation.failures,
  });

  const nextCache: FeedbackCache = {
    session_id: sessionId,
    updated_at: finalizedAt,
    ready: false,
    person_summary_cache: finalPerPerson,
    overall_summary_cache: finalOverall,
    evidence_index_cache: buildEvidenceIndex(finalPerPerson),
    report: result,
    quality,
    timings: {
      assemble_ms: assembleMs,
      events_ms: eventsMs,
      report_ms: reportMs,
      validation_ms: validationMs,
      persist_ms: 0,
      total_ms: 0,
    },
    report_source: reportSource,
    blocking_reason: reportBlockingReason,
    quality_gate_passed: false,
  };
  const persistStart = Date.now();
  await ctx.storeFeedbackCache(nextCache);
  const persistMs = Date.now() - persistStart;
  const totalMs = Date.now() - totalStart;
  const meetsBudget =
    totalMs <= FEEDBACK_TOTAL_BUDGET_MS &&
    assembleMs <= FEEDBACK_ASSEMBLE_BUDGET_MS &&
    eventsMs <= FEEDBACK_EVENTS_BUDGET_MS &&
    reportMs <= FEEDBACK_REPORT_BUDGET_MS &&
    validationMs <= FEEDBACK_VALIDATE_BUDGET_MS &&
    persistMs <= FEEDBACK_PERSIST_FETCH_BUDGET_MS;
  const gatePassed = gateEvaluation.passed && meetsBudget;
  const budgetReason = meetsBudget
    ? null
    : `feedback budgets exceeded (total=${totalMs} assemble=${assembleMs} events=${eventsMs} report=${reportMs} validate=${validationMs} persist=${persistMs})`;
  nextCache.timings.persist_ms = persistMs;
  nextCache.timings.total_ms = totalMs;
  nextCache.ready = gatePassed;
  nextCache.quality_gate_passed = gatePassed;
  if (!meetsBudget && nextCache.report) {
    const failures = Array.isArray(nextCache.report.trace.quality_gate_failures)
      ? [...nextCache.report.trace.quality_gate_failures]
      : [];
    failures.push(
      `feedback_budget gate failed: total=${totalMs} assemble=${assembleMs} events=${eventsMs} report=${reportMs} validate=${validationMs} persist=${persistMs}`
    );
    nextCache.report.trace.quality_gate_failures = failures;
  }
  if (!nextCache.ready && !nextCache.blocking_reason) {
    nextCache.blocking_reason = gateEvaluation.failures[0] || budgetReason || "feedback quality gate failed";
  } else if (budgetReason) {
    nextCache.blocking_reason = budgetReason;
  }
  await ctx.storeFeedbackCache(nextCache);
  return nextCache;
}
