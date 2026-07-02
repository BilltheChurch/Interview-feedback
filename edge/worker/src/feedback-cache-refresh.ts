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
  buildSynthesizePayload,
  collectEnrichedContext,
  computeSpeakerStats,
  validatePersonFeedbackEvidence,
} from "./finalize_v2";
import type { TranscriptItem } from "./finalize_v2";
import { computeEligibleSpeakers, synthesizeDegradedOverviewSummary } from "./services/llm-synthesizer";
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
  ACCEPTED_REPORT_SOURCES,
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
  buildDegradedSummarySections,
  buildEvidenceIndex,
  buildQualityMetrics,
  collectInterviewerUtterances,
  evaluateFeedbackQualityGates,
  mergeStatsWithRoster,
  resolveNoStudentSpeechDegradation,
  stripHtmlToText,
  validateClaimEvidenceRefs,
  NO_STUDENT_SPEECH_NOTICE,
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
    backend_used: "primary" | "secondary" | "disabled";
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
  // Exclude the teacher / interviewer from per-person scoring. The teacher stream
  // carries the interviewer's own audio — it must appear in synthesis context (so
  // the LLM knows what questions were asked) but must NOT receive a student card.
  const studentStats = stats.filter((s) => s.speaker_key !== "teacher");
  const evidence = buildEvidence({ memos, transcript });
  const memosWithEvidence = attachEvidenceToMemos(memos, evidence);
  const memoFirst = buildMemoFirstReport({
    transcript,
    memos: memosWithEvidence,
    evidence,
    stats: studentStats,
  });
  const assembleMs = Date.now() - assembleStart;

  const locale = getSessionLocale(state, ctx.env);

  // ── R2/R-B: eligible-student signal (shared oracle) ──
  // Run the SAME three-layer filter the synthesizer uses (computeEligibleSpeakers)
  // so the "no student speech" decision below can never diverge from whether the
  // LLM could actually produce any per_person. Built via buildSynthesizePayload /
  // collectEnrichedContext exactly like finalize-orchestrator, so the history-reload
  // path (this file) and the finalize path stay in lock-step.
  const eligibilityConfig = (state.config ?? {}) as Record<string, unknown>;
  const eligibilityContext = collectEnrichedContext({
    sessionConfig: {
      mode: eligibilityConfig.mode as "1v1" | "group" | undefined,
      interviewer_name: eligibilityConfig.interviewer_name as string | undefined,
      position_title: eligibilityConfig.position_title as string | undefined,
      company_name: eligibilityConfig.company_name as string | undefined,
      stages: (eligibilityConfig.stages as string[]) ?? [],
      free_form_notes: eligibilityConfig.free_form_notes as string | undefined,
      rubric: eligibilityConfig.rubric as Parameters<typeof collectEnrichedContext>[0]["sessionConfig"]["rubric"],
    },
  });
  const eligibilityPayload = buildSynthesizePayload({
    sessionId,
    transcript,
    memos: memosWithEvidence,
    evidence,
    stats: studentStats,
    events: [],
    bindings: [],
    rubric: eligibilityContext.rubric,
    sessionContext: eligibilityContext.sessionContext,
    freeFormNotes: eligibilityContext.freeFormNotes,
    historical: [],
    stages: eligibilityContext.stages,
    locale,
    nameAliases: (eligibilityConfig.name_aliases ?? {}) as Record<string, string[]>,
  });
  const eligibleActiveStudentCount = computeEligibleSpeakers(eligibilityPayload).active.length;

  const eventsStart = Date.now();
  const eventsPayload = {
    session_id: sessionId,
    transcript,
    memos: memosWithEvidence,
    stats: studentStats,
    locale,
  };
  const eventsResult = await ctx.invokeInferenceAnalysisEvents(eventsPayload);
  const analysisEvents = Array.isArray(eventsResult.events) ? eventsResult.events : [];
  const eventsMs = Date.now() - eventsStart;

  let reportSource: "memo_first" | "llm_enhanced" | "llm_failed" | "degraded_no_participants" = "memo_first";
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
      stats: studentStats,
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

  // ── R2/R-B: degraded overview-only report (no student speech) ──
  // Ported from finalize-orchestrator so the HISTORY-RELOAD path degrades the same
  // way the finalize path does. We only reach llm_failed with NO real per_person in
  // two cases:
  //   (a) no eligible student ever spoke (interviewer monologue / silent student
  //       side) → LEGITIMATE overview-only session → emit a deliverable degraded
  //       report with a user-facing notice instead of a hard red bar; and
  //   (b) eligible students exist but analysis/report still returned nothing → a
  //       genuine LLM failure → keep blocking (reportSource stays llm_failed).
  // The signal is the shared eligibility oracle (eligibleActiveStudentCount), NOT
  // finalPerPerson.length — buildMemoFirstReport always emits ≥1 PLACEHOLDER card,
  // so per_person is never actually empty here.
  if (reportSource === "llm_failed") {
    const degradation = resolveNoStudentSpeechDegradation(eligibleActiveStudentCount);
    if (degradation.degraded) {
      reportSource = "degraded_no_participants";
      reportBlockingReason = null;
      // Overview-only: drop the memo-first placeholder person cards so the UI shows
      // just the overview + notice, no phantom "unknown" student.
      finalPerPerson = [];
      // R5 复用护栏（复审补修）：已结束会话的 transcript/notes 不再变化——prior
      // cache 若已是 degraded 报告且带 LLM"内容小结"段（finalize 或上次重建产出），
      // 直接沿用该 summary_sections，不再重打 LLM。这条路径被 feedback-open/ready
      // 同步 await（10s 新鲜窗过后每次历史重开都会走到这里），无复用时每次重开都
      // 多付一次 LLM 往返（成本/延迟/措辞漂移），且重开时 LLM 失败会把 finalize
      // 产出的好小结静默覆盖成确定性拼接。
      const priorSections =
        current.report_source === "degraded_no_participants"
          ? ((current.report?.overall ?? null) as {
              summary_sections?: Array<{ topic?: string; bullets?: string[]; evidence_ids?: string[] }>;
            } | null)?.summary_sections ?? null
          : null;
      const priorLlmDigest =
        Array.isArray(priorSections) && priorSections.some((section) => section?.topic === "内容小结")
          ? priorSections
          : null;

      // R5: prior 无可复用小结时才尝试轻量 LLM；失败记日志后回退确定性拼接。
      let degradedLlmBullets: string[] | null = null;
      if (!priorLlmDigest) {
        try {
          degradedLlmBullets = await synthesizeDegradedOverviewSummary(ctx.env, {
            interviewerUtterances: collectInterviewerUtterances(transcript),
            notesText: stripHtmlToText(eligibilityContext.freeFormNotes ?? ""),
          });
        } catch (llmErr) {
          console.warn(
            `[feedback-cache-refresh] degraded summary LLM fallback (${sessionId}): ${String(
              (llmErr as Error)?.message ?? llmErr
            )}`
          );
        }
      }
      // R2: 重建 overview summary，反映本场实际内容（面试官发言 + notes），并置空
      // evidence_ids —— 不再沿用 memo-first 那句通用占位、也不盲挂无关头部
      // evidence。与 finalize-orchestrator 两条降级 fork 行为一致。
      finalOverall = {
        ...(finalOverall as Record<string, unknown>),
        notice: NO_STUDENT_SPEECH_NOTICE,
        summary_sections:
          priorLlmDigest ??
          buildDegradedSummarySections({
            transcript,
            freeFormNotes: eligibilityContext.freeFormNotes,
            notice: NO_STUDENT_SPEECH_NOTICE,
            llmBullets: degradedLlmBullets,
          }),
      };
    }
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
  // Accepted sources (incl. R2 degraded_no_participants) do NOT seed a gate
  // failure — only genuinely-unavailable reports (llm_failed) do. Aligns with
  // finalize-orchestrator's ACCEPTED_REPORT_SOURCES gate seeding.
  if (!ACCEPTED_REPORT_SOURCES.has(reportSource)) {
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
    report_degraded: !ACCEPTED_REPORT_SOURCES.has(reportSource),
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
  // ── R2/R-B: a degraded overview-only report is inherently deliverable ──
  // Mirror finalize-orchestrator: an ACCEPTED degraded_no_participants report
  // passes on the accepted-source + no-needs-evidence check alone, and is delivered
  // even if the tentative/budget gates trip (an all-teacher transcript can fail the
  // unknown-ratio / p95 gates). Other sources keep the stricter combined gate.
  const isDegraded = reportSource === "degraded_no_participants";
  const degradedGatePassed =
    ACCEPTED_REPORT_SOURCES.has(reportSource) && finalValidation.needsEvidenceCount === 0;
  nextCache.timings.persist_ms = persistMs;
  nextCache.timings.total_ms = totalMs;
  nextCache.ready = isDegraded ? degradedGatePassed : gatePassed;
  nextCache.quality_gate_passed = isDegraded ? degradedGatePassed : gatePassed;
  if (!meetsBudget && !isDegraded && nextCache.report) {
    const failures = Array.isArray(nextCache.report.trace.quality_gate_failures)
      ? [...nextCache.report.trace.quality_gate_failures]
      : [];
    failures.push(
      `feedback_budget gate failed: total=${totalMs} assemble=${assembleMs} events=${eventsMs} report=${reportMs} validate=${validationMs} persist=${persistMs}`
    );
    nextCache.report.trace.quality_gate_failures = failures;
  }
  // Degraded reports keep blocking_reason = null (they are deliverable).
  if (!isDegraded) {
    if (!nextCache.ready && !nextCache.blocking_reason) {
      nextCache.blocking_reason = gateEvaluation.failures[0] || budgetReason || "feedback quality gate failed";
    } else if (budgetReason) {
      nextCache.blocking_reason = budgetReason;
    }
  }

  // ── R-B good-cache overwrite guard ──
  // The freshness window forces a recompute on history re-entry (10s). If the prior
  // cache already held an ACCEPTED (good) report but THIS recompute produced a
  // NON-accepted source (e.g. a transient llm_failed from a flaky analysis/report
  // call), do NOT persist over the good cache — a single bad refresh must never
  // permanently poison a session that was previously deliverable.
  const priorAccepted = ACCEPTED_REPORT_SOURCES.has(current.report_source);
  const nextAccepted = ACCEPTED_REPORT_SOURCES.has(nextCache.report_source);
  if (priorAccepted && !nextAccepted) {
    const preserved: FeedbackCache = {
      ...current,
      updated_at: finalizedAt,
      timings: nextCache.timings,
    };
    await ctx.storeFeedbackCache(preserved);
    return preserved;
  }

  await ctx.storeFeedbackCache(nextCache);
  return nextCache;
}
