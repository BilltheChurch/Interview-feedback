/**
 * degraded-no-student-speech.test.ts
 *
 * R2 (degraded report): when a group interview produces NO eligible student
 * speech (e.g. the interviewer monologues into the mic, or the system-audio side
 * stays silent), finalize used to emit a hard red bar because synthesis returned
 * no per_person and `report_source` fell back to `memo_first_fallback` (not in
 * ACCEPTED_REPORT_SOURCES).
 *
 * Desired behaviour:
 *   - No eligible student speech (0 speakers pass the synthesizer's three-layer
 *     filter) → DEGRADED overview-only report:
 *       * report_source = "degraded_no_participants" (an ACCEPTED source)
 *       * ready = true, quality_gate_passed = true, no blocking_reason
 *       * per_person empty (no phantom placeholder cards) + user-facing notice
 *   - Eligible students exist (> 0) but synthesis returned nothing → NOT degraded
 *     (a genuine LLM failure; keep the existing block path).
 *   - Normal per_person → unchanged.
 *
 * The most important test here is `runFinalizeV2Job report-only integration` — it
 * drives the REAL orchestrator entry point (not a hand-rolled mock of the ready
 * formula), which is what catches the "guard unreachable" class of bug: the guard
 * must key off the shared eligibility oracle, NOT `finalPerPerson.length` (which is
 * never 0 because buildMemoFirstReport always emits ≥1 placeholder card).
 */

import { describe, it, expect, vi } from "vitest";
import {
  resolveNoStudentSpeechDegradation,
  NO_STUDENT_SPEECH_NOTICE,
  evaluateFeedbackQualityGates,
} from "../src/feedback-helpers";
import { computeEligibleSpeakers } from "../src/services/llm-synthesizer";
import { ACCEPTED_REPORT_SOURCES } from "../src/config";
import { runFinalizeV2Job, type FinalizeJobContext } from "../src/finalize-orchestrator";
import type { SpeakerStatItem, ResultV2, SynthesizeRequestPayload } from "../src/types_v2";

function stat(partial: Partial<SpeakerStatItem>): SpeakerStatItem {
  return {
    speaker_key: partial.speaker_key ?? "S1",
    speaker_name: partial.speaker_name ?? "Alice",
    talk_time_ms: partial.talk_time_ms ?? 0,
    talk_time_pct: partial.talk_time_pct ?? 0,
    turns: partial.turns ?? 0,
    silence_ms: partial.silence_ms ?? 0,
    interruptions: partial.interruptions ?? 0,
    interrupted_by_others: partial.interrupted_by_others ?? 0,
    binding_status: partial.binding_status,
  };
}

// ── Pure helper ──────────────────────────────────────────────────────────────

describe("resolveNoStudentSpeechDegradation (R2)", () => {
  it("degrades when the eligible-active student count is 0", () => {
    const r = resolveNoStudentSpeechDegradation(0);
    expect(r.degraded).toBe(true);
    expect(r.eligibleStudentCount).toBe(0);
    expect(r.notice).toBe(NO_STUDENT_SPEECH_NOTICE);
  });

  it("does NOT degrade when eligible-active students exist (real LLM failure)", () => {
    const r = resolveNoStudentSpeechDegradation(1);
    expect(r.degraded).toBe(false);
    expect(r.eligibleStudentCount).toBe(1);
  });

  it("provides an English, user-facing notice", () => {
    expect(NO_STUDENT_SPEECH_NOTICE).toMatch(/no student speech/i);
    expect(NO_STUDENT_SPEECH_NOTICE).toMatch(/overview/i);
  });
});

// ── Shared eligibility oracle (must match the synthesizer's filter) ───────────

function makeUtterance(
  id: string,
  role: "teacher" | "students",
  speakerName: string | null,
  clusterId: string | null,
  text: string,
  startMs: number,
  endMs: number
) {
  return {
    utterance_id: id,
    stream_role: role,
    speaker_name: speakerName,
    cluster_id: clusterId,
    decision: "auto" as const,
    text,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  };
}

function makePayload(overrides: Partial<SynthesizeRequestPayload>): SynthesizeRequestPayload {
  return {
    session_id: "sess-oracle",
    transcript: [],
    memos: [],
    free_form_notes: null,
    evidence: [],
    stats: [],
    events: [],
    rubric: null,
    session_context: null,
    memo_speaker_bindings: [],
    historical: [],
    stages: [],
    locale: "en-US",
    ...overrides,
  };
}

describe("computeEligibleSpeakers (shared oracle, R2 alignment)", () => {
  it("returns 0 active when only the interviewer (teacher stream) spoke", () => {
    const payload = makePayload({
      transcript: [makeUtterance("u1", "teacher", "Mr. Lee", null, "Tell me about yourself.", 0, 4000)],
      stats: [stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 5, talk_time_ms: 40000 })],
      session_context: { mode: "group", interviewer_name: "Mr. Lee", stage_descriptions: [] },
    });
    expect(computeEligibleSpeakers(payload).active.length).toBe(0);
  });

  it("excludes the interviewer BY NAME even if not keyed 'teacher' (naive filter would over-count)", () => {
    // A speaker keyed S9 but whose name matches session_context.interviewer_name.
    // A naive `speaker_key !== 'teacher'` + turns/talk-time count would wrongly
    // count this as an eligible student (=1) and refuse to degrade.
    const payload = makePayload({
      transcript: [makeUtterance("u1", "teacher", "Dr. Chen", null, "Q1", 0, 4000)],
      stats: [stat({ speaker_key: "S9", speaker_name: "Dr. Chen", turns: 6, talk_time_ms: 50000 })],
      session_context: { mode: "group", interviewer_name: "Dr. Chen", stage_descriptions: [] },
    });
    expect(computeEligibleSpeakers(payload).active.length).toBe(0);
  });

  it("drops unnamed, un-mentioned clusters (turns>0 but not eligible)", () => {
    const payload = makePayload({
      transcript: [makeUtterance("u1", "students", null, "c3", "mumble", 0, 3000)],
      stats: [stat({ speaker_key: "c3", speaker_name: "c3", turns: 2, talk_time_ms: 3000 })],
    });
    expect(computeEligibleSpeakers(payload).active.length).toBe(0);
  });

  it("counts a named student who actually spoke", () => {
    const payload = makePayload({
      transcript: [makeUtterance("u1", "students", "Alice", "S1", "I'm Alice.", 0, 5000)],
      stats: [stat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 })],
    });
    expect(computeEligibleSpeakers(payload).active.length).toBe(1);
  });
});

// ── ACCEPTED_REPORT_SOURCES contract ─────────────────────────────────────────

describe("degraded_no_participants report source (R2)", () => {
  it("is an ACCEPTED report source so the report is delivered (not red-barred)", () => {
    expect(ACCEPTED_REPORT_SOURCES.has("degraded_no_participants")).toBe(true);
  });
  it("keeps memo_first_fallback as a NON-accepted (blocking) source", () => {
    expect(ACCEPTED_REPORT_SOURCES.has("memo_first_fallback")).toBe(false);
  });
});

// ── REAL orchestrator integration (report-only entry) ────────────────────────

type CapturedCache = {
  ready?: boolean;
  quality_gate_passed?: boolean;
  blocking_reason?: string | null;
  report_source?: string;
  report?: ResultV2 | null;
};

/**
 * Build a fake FinalizeJobContext that drives the REAL runFinalizeV2Job in
 * 'report-only' mode. The existing ResultV2 in R2 carries the transcript+stats;
 * synthesis is stubbed to return `synthPerPerson` (empty ⇒ the fallback path).
 */
function makeHarness(opts: {
  existingResult: ResultV2;
  synthPerPerson: unknown[];
  interviewerName?: string;
}) {
  const captured: { cache: CapturedCache | null; status: Record<string, unknown> | null } = {
    cache: null,
    status: null,
  };
  let storedResultV2: ResultV2 | null = null;

  const sessionState = {
    config: { mode: "group", interviewer_name: opts.interviewerName ?? "Mr. Lee" },
  };

  const feedbackCache: CapturedCache & Record<string, unknown> = {
    session_id: "sess-r2",
    updated_at: "",
    ready: false,
    person_summary_cache: [],
    overall_summary_cache: {},
    evidence_index_cache: {},
    report: null,
    quality: {},
    timings: {},
    report_source: "memo_first",
    blocking_reason: null,
    quality_gate_passed: false,
  };

  const RESULT_BUCKET = {
    get: vi.fn(async () => ({
      text: async () => JSON.stringify(opts.existingResult),
    })),
    put: vi.fn(async (_key: string, body: string) => {
      storedResultV2 = JSON.parse(body) as ResultV2;
    }),
  };

  const ctx = {
    doCtx: {
      storage: {
        get: vi.fn(async (key: string) => (key === "state" ? sessionState : undefined)),
        put: vi.fn(async () => {}),
      },
    },
    env: { RESULT_BUCKET, QUALITY_GATE_UNKNOWN_RATIO: undefined },
    currentIsoTs: () => "2026-07-01T00:00:00.000Z",
    finalizeTimeoutMs: () => 600_000,
    getCaptionSource: () => "none" as const,
    setCaptionSource: () => {},
    getCaptionBuffer: () => [],
    setCaptionBuffer: () => {},
    updateFinalizeV2Status: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      captured.status = { ...(captured.status ?? {}), ...patch };
      return null;
    }),
    setFinalizeLock: vi.fn(async () => {}),
    ensureFinalizeJobActive: vi.fn(async () => {}),
    loadIngestByStream: vi.fn(async () => ({
      mixed: { last_seq: 0 },
      teacher: { last_seq: 0 },
      students: { last_seq: 0 },
    })),
    loadFinalizeV2Status: vi.fn(async () => ({
      job_id: "job-r2",
      status: "running" as const,
      stage: "reconcile" as const,
      progress: 42,
      errors: [],
      warnings: [],
      degraded: false,
      backend_used: "primary" as const,
      version: "v2" as const,
      started_at: "2026-07-01T00:00:00.000Z",
    })),
    isFinalizeTerminal: () => false,
    setSessionPhase: vi.fn(async () => "finalized" as const),
    clearFinalizeStageCheckpoint: vi.fn(async () => {}),
    saveFinalizeStageCheckpoint: vi.fn(async () => {}),
    tier2Enabled: () => false,
    tier2AutoTrigger: () => false,
    loadMemos: vi.fn(async () => []),
    storeMemos: vi.fn(async () => {}),
    invokeInferenceAnalysisEvents: vi.fn(async () => ({
      events: [],
      backend_used: "primary",
      degraded: false,
      warnings: [],
      timeline: [],
      fallback_reason: null,
    })),
    invokeInferenceSynthesizeReport: vi.fn(async () => ({
      data: { per_person: opts.synthPerPerson, overall: { narrative: "Session overview." } },
      backend_used: "primary",
      degraded: false,
      warnings: [],
      timeline: [],
    })),
    loadCheckpoints: vi.fn(async () => []),
    sanitizeClaimEvidenceRefs: (perPerson: unknown[]) => ({ sanitized: perPerson, strippedCount: 0 }),
    validateClaimEvidenceRefs: (report: ResultV2) => {
      let claimCount = 0;
      let needs = 0;
      for (const p of report.per_person ?? []) {
        for (const d of p.dimensions ?? []) {
          for (const c of [...(d.strengths ?? []), ...(d.risks ?? []), ...(d.actions ?? [])]) {
            claimCount += 1;
            if (!Array.isArray(c.evidence_refs) || c.evidence_refs.filter(Boolean).length === 0) needs += 1;
          }
        }
      }
      return { valid: needs === 0 && claimCount > 0, claimCount, invalidCount: needs, needsEvidenceCount: needs, failures: [] };
    },
    buildQualityMetrics: () => ({
      unknown_ratio: 0,
      students_utterance_count: 0,
      students_unknown_count: 0,
      echo_suppressed_chunks: 0,
      echo_suppression_recent_rate: 0,
      echo_leak_rate: 0,
      suppression_false_positive_rate: undefined,
    }),
    buildEvidenceIndex: () => ({}),
    evaluateFeedbackQualityGates,
    loadFeedbackCache: vi.fn(async () => feedbackCache),
    storeFeedbackCache: vi.fn(async (c: CapturedCache) => {
      captured.cache = { ...c };
    }),
    triggerImprovementGeneration: vi.fn(async () => {}),
  } as unknown as FinalizeJobContext;

  return { ctx, captured, getStoredResultV2: () => storedResultV2 };
}

/** Minimal valid ResultV2 for report-only re-run. */
function makeExistingResult(stats: SpeakerStatItem[], transcript: ResultV2["transcript"]): ResultV2 {
  return {
    session: {
      session_id: "sess-r2",
      finalized_at: "2026-06-30T00:00:00.000Z",
      tentative: false,
      confidence_level: "high",
      unresolved_cluster_count: 0,
      diarization_backend: "cloud",
    },
    transcript,
    speaker_logs: { teacher: [], students: [] } as unknown as ResultV2["speaker_logs"],
    stats,
    memos: [],
    evidence: [],
    overall: {} as ResultV2["overall"],
    per_person: [],
    quality: {} as ResultV2["quality"],
    trace: {
      finalize_job_id: "job-old",
      model_versions: {},
      thresholds: {},
      unknown_ratio: 0,
      generated_at: "2026-06-30T00:00:00.000Z",
    },
  };
}

describe("runFinalizeV2Job report-only integration (R2)", () => {
  it("BRANCH A — no student speech → degraded_no_participants, ready=true, empty per_person + notice", async () => {
    // Only the interviewer (teacher) spoke; stats has just a teacher entry.
    const transcript = [makeUtterance("u1", "teacher", "Mr. Lee", null, "Tell me about the role.", 0, 4000)];
    const existing = makeExistingResult(
      [stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 6, talk_time_ms: 40000 })],
      transcript
    );
    // Synthesis returns NO per_person (the LLM has no interviewee_stats to score).
    const { ctx, captured, getStoredResultV2 } = makeHarness({ existingResult: existing, synthPerPerson: [] });

    await runFinalizeV2Job("sess-r2", "job-r2", {}, ctx, "report-only");

    expect(captured.cache?.report_source).toBe("degraded_no_participants");
    expect(captured.cache?.quality_gate_passed).toBe(true);
    expect(captured.cache?.ready).toBe(true);
    expect(captured.cache?.blocking_reason).toBeNull();

    const result = getStoredResultV2();
    expect(result).not.toBeNull();
    expect(result!.per_person).toEqual([]); // no phantom placeholder cards
    expect((result!.overall as { notice?: string }).notice).toBe(NO_STUDENT_SPEECH_NOTICE);
  });

  it("BRANCH B — eligible student but empty per_person → NOT degraded, still blocked (ready=false)", async () => {
    // Alice (named student) actually spoke → eligible=1 → real LLM failure, not degradation.
    const transcript = [
      makeUtterance("u0", "teacher", "Mr. Lee", null, "Q1", 0, 3000),
      makeUtterance("u1", "students", "Alice", "S1", "I'm Alice, from MIT.", 3000, 9000),
    ];
    const existing = makeExistingResult(
      [
        stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        stat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      transcript
    );
    const { ctx, captured } = makeHarness({ existingResult: existing, synthPerPerson: [] });

    await runFinalizeV2Job("sess-r2", "job-r2", {}, ctx, "report-only");

    expect(captured.cache?.report_source).toBe("memo_first_fallback");
    expect(captured.cache?.quality_gate_passed).toBe(false);
    expect(captured.cache?.ready).toBe(false);
    expect(captured.cache?.blocking_reason).toBeTruthy();
  });

  it("BRANCH C — normal per_person from synthesis → llm_synthesized, ready=true (unchanged)", async () => {
    const transcript = [
      makeUtterance("u0", "teacher", "Mr. Lee", null, "Q1", 0, 3000),
      makeUtterance("u1", "students", "Alice", "S1", "I'm Alice, from MIT.", 3000, 9000),
    ];
    const existing = makeExistingResult(
      [
        stat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        stat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      transcript
    );
    // Synthesis returns a valid per_person with a claim that has an evidence ref
    // present in the evidence pack (the pack includes an auto-generated stats item).
    const perPerson = [
      {
        person_key: "S1",
        display_name: "Alice",
        dimensions: [
          {
            dimension: "collaboration",
            score: 7,
            // Non-empty evidence_refs → passes claim validation (green path).
            strengths: [{ claim_id: "S1_c1", text: "Clear self-intro.", evidence_refs: ["ev_intro"], confidence: 0.8 }],
            risks: [],
            actions: [],
          },
        ],
        summary: { strengths: [], risks: [], actions: [] },
      },
    ];
    const { ctx, captured, getStoredResultV2 } = makeHarness({ existingResult: existing, synthPerPerson: perPerson });

    await runFinalizeV2Job("sess-r2", "job-r2", {}, ctx, "report-only");

    // Normal green path: real per_person → llm_synthesized, gate passes, NOT degraded,
    // per_person preserved. (report-only marks `ready = quality_gate_passed && !tentative`,
    // and tentative is orthogonally set by the ingest-p95 gate which report-only can't
    // measure — so we assert the gate + source, not the tentative-derived `ready`.)
    expect(captured.cache?.report_source).toBe("llm_synthesized");
    expect(captured.cache?.report_source).not.toBe("degraded_no_participants");
    expect(captured.cache?.quality_gate_passed).toBe(true);
    expect(getStoredResultV2()!.per_person.length).toBe(1);
    expect((getStoredResultV2()!.overall as { notice?: string }).notice).toBeUndefined();
  });
});
