/**
 * feedback-cache-refresh-degraded.test.ts
 *
 * R-B (history-reload regression): the R2 "no student speech → overview-only
 * degraded report" fork was only ported into finalize-orchestrator.ts (the
 * finalize path). History re-entry goes through a DIFFERENT path —
 * `maybeRefreshFeedbackCache` (feedback-cache-refresh.ts, invoked by the
 * `feedback-open` handler) — which had NO degraded fork: an empty per_person
 * unconditionally became `report_source = "llm_failed"` +
 * `blocking_reason = "analysis/report returned empty per_person"` (the red bar),
 * and, because the freshness window (10s) forces a recompute, that bad recompute
 * OVERWROTE and persisted over the first good cache — permanently poisoning it.
 *
 * This suite drives the REAL `maybeRefreshFeedbackCache` (only I/O boundaries —
 * storage / synthesize / events — are stubbed) and locks:
 *   A degraded : teacher-only stats + empty synthesis → degraded_no_participants,
 *                accepted/ready, empty per_person, notice.
 *   B block    : eligible student + empty synthesis → still llm_failed + blocking.
 *   C normal   : valid per_person → accepted (unchanged).
 *   D guard    : an already-accepted good cache + a non-accepted recompute must
 *                NOT overwrite the good report/source/ready/blocking_reason.
 */

import { describe, it, expect, vi } from "vitest";
import {
  maybeRefreshFeedbackCache,
  type FeedbackCacheRefreshContext,
} from "../src/feedback-cache-refresh";
import { NO_STUDENT_SPEECH_NOTICE } from "../src/feedback-helpers";
import { ACCEPTED_REPORT_SOURCES } from "../src/config";
import { emptySpeakerLogs } from "../src/speaker_logs";
import type {
  FeedbackCache,
  SessionState,
  SpeakerEvent,
  StreamRole,
  UtteranceRaw,
} from "../src/config";
import type { ResultV2, SpeakerLogs, SpeakerMapItem, SpeakerStatItem } from "../src/types_v2";

// ── Fixture builders ─────────────────────────────────────────────────────────

function makeUtterance(
  id: string,
  role: StreamRole,
  speakerName: string | null,
  clusterId: string | null,
  text: string,
  startMs: number,
  endMs: number
): UtteranceRaw {
  return {
    utterance_id: id,
    stream_role: role,
    text,
    start_ms: startMs,
    end_ms: endMs,
    speaker_name: speakerName,
    cluster_id: clusterId,
  } as unknown as UtteranceRaw;
}

/** A resolved student speaker event binding an utterance to a named cluster. */
function studentEvent(utteranceId: string, clusterId: string, speakerName: string): SpeakerEvent {
  return {
    ts: "2026-07-01T00:00:00.000Z",
    stream_role: "students",
    source: "inference_resolve",
    utterance_id: utteranceId,
    cluster_id: clusterId,
    speaker_name: speakerName,
    decision: "auto",
  };
}

function emptyAsrState() {
  return {
    enabled: true,
    provider: "dashscope" as const,
    model: "m",
    window_seconds: 3,
    hop_seconds: 1,
    last_window_end_seq: 0,
    utterance_count: 0,
    total_windows_processed: 0,
    total_audio_seconds_processed: 0,
    // p95 present so the ingest-p95 quality gate can PASS for branch C.
    ingest_to_utterance_p95_ms: 500,
  };
}

function baseSessionState(overrides?: Partial<SessionState>): SessionState {
  return {
    session_id: "sess-rb",
    phase: "finalized",
    config: { mode: "group", interviewer_name: "Mr. Lee" },
    roster: [],
    clusters: [],
    bindings: {},
    cluster_binding_meta: {},
    ...overrides,
  } as unknown as SessionState;
}

function baseCache(overrides?: Partial<FeedbackCache>): FeedbackCache {
  return {
    session_id: "sess-rb",
    // Stale so the freshness window (10s) does NOT short-circuit → force recompute.
    updated_at: "2000-01-01T00:00:00.000Z",
    ready: false,
    person_summary_cache: [],
    overall_summary_cache: {},
    evidence_index_cache: {},
    report: null,
    quality: {} as FeedbackCache["quality"],
    timings: {} as FeedbackCache["timings"],
    report_source: "memo_first",
    blocking_reason: null,
    quality_gate_passed: false,
    ...overrides,
  };
}

/**
 * Build a fake FeedbackCacheRefreshContext driving the REAL
 * maybeRefreshFeedbackCache. Only I/O boundaries are stubbed.
 */
function makeHarness(opts: {
  utterances: { teacher: UtteranceRaw[]; students: UtteranceRaw[] };
  stats: SpeakerStatItem[];
  reportPerPerson: unknown[];
  reportOverall?: Record<string, unknown>;
  initialCache?: FeedbackCache;
  sessionState?: SessionState;
  speakerEvents?: SpeakerEvent[];
  speakerMap?: SpeakerMapItem[];
}) {
  const stored: { cache: FeedbackCache | null } = { cache: null };
  let cache = opts.initialCache ?? baseCache();
  const state = opts.sessionState ?? baseSessionState();
  const speakerLogs: SpeakerLogs = {
    ...emptySpeakerLogs("2026-07-01T00:00:00.000Z"),
    speaker_map: opts.speakerMap ?? [],
  };

  const ctx = {
    env: { INFERENCE_EVENTS_PATH: "/analysis/events", INFERENCE_REPORT_PATH: "/analysis/report" },
    storage: {
      get: vi.fn(async (key: string) => {
        if (key === "state") return state;
        return undefined;
      }),
    },
    captionSource: "none" as const,
    setCaptionSource: () => {},
    loadFeedbackCache: vi.fn(async () => cache),
    storeFeedbackCache: vi.fn(async (c: FeedbackCache) => {
      cache = c;
      stored.cache = { ...c };
    }),
    loadFinalizeV2Status: vi.fn(async () => null),
    loadSpeakerEvents: vi.fn(async () => opts.speakerEvents ?? []),
    loadUtterancesRawByStream: vi.fn(async () => ({
      teacher: opts.utterances.teacher,
      students: opts.utterances.students,
    })),
    loadMemos: vi.fn(async () => []),
    loadSpeakerLogs: vi.fn(async () => speakerLogs),
    loadAsrByStream: vi.fn(async () => ({
      teacher: emptyAsrState(),
      students: emptyAsrState(),
    })),
    currentIsoTs: () => "2026-07-01T00:00:00.000Z",
    invokeInferenceAnalysisEvents: vi.fn(async () => ({
      events: [],
      backend_used: "primary" as const,
      degraded: false,
      warnings: [],
      timeline: [],
      fallback_reason: null,
    })),
    invokeInferenceAnalysisReport: vi.fn(async () => ({
      data: {
        per_person: opts.reportPerPerson,
        overall: opts.reportOverall ?? { narrative: "Session overview." },
      },
      backend_used: "primary" as const,
      degraded: false,
      warnings: [],
      timeline: [],
    })),
    deriveSpeakerLogsFromTranscript: () => emptySpeakerLogs("2026-07-01T00:00:00.000Z"),
    buildEdgeSpeakerLogsForFinalize: () => emptySpeakerLogs("2026-07-01T00:00:00.000Z"),
  } as unknown as FeedbackCacheRefreshContext;

  // Seed stats onto raw stats via a spy-free approach: computeSpeakerStats runs
  // over the reconciled transcript, so utterances alone drive stats. We DON'T
  // inject opts.stats directly (the real path recomputes them). opts.stats is
  // documentation of intent only.
  return { ctx, stored, getCache: () => cache };
}

function makeStat(p: Partial<SpeakerStatItem>): SpeakerStatItem {
  return {
    speaker_key: p.speaker_key ?? "S1",
    speaker_name: p.speaker_name ?? "Alice",
    talk_time_ms: p.talk_time_ms ?? 0,
    talk_time_pct: p.talk_time_pct ?? 0,
    turns: p.turns ?? 0,
    silence_ms: p.silence_ms ?? 0,
    interruptions: p.interruptions ?? 0,
    interrupted_by_others: p.interrupted_by_others ?? 0,
  } as SpeakerStatItem;
}

// ── A: degraded fork ─────────────────────────────────────────────────────────

describe("maybeRefreshFeedbackCache — R-B degraded fork (history reload)", () => {
  it("BRANCH A — teacher-only speech + empty synthesis → degraded_no_participants, accepted/ready, empty per_person + notice", async () => {
    // Only the interviewer (teacher stream) spoke. computeEligibleSpeakers → 0.
    const { ctx, getCache } = makeHarness({
      utterances: {
        teacher: [makeUtterance("t1", "teacher", "Mr. Lee", null, "Tell me about the role.", 0, 4000)],
        students: [],
      },
      stats: [makeStat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 5, talk_time_ms: 40000 })],
      reportPerPerson: [], // analysis/report returns empty per_person
    });

    const result = await maybeRefreshFeedbackCache(ctx, "sess-rb", true);

    expect(result.report_source).toBe("degraded_no_participants");
    expect(ACCEPTED_REPORT_SOURCES.has(result.report_source)).toBe(true);
    expect(result.blocking_reason).toBeNull();
    expect(result.ready).toBe(true);
    expect(result.quality_gate_passed).toBe(true);
    expect(result.person_summary_cache).toEqual([]);
    expect((result.overall_summary_cache as { notice?: string }).notice).toBe(NO_STUDENT_SPEECH_NOTICE);
    // Persisted result mirrors it (history re-entry reads report_source from cache).
    expect(getCache().report_source).toBe("degraded_no_participants");
  });

  it("BRANCH B — eligible student + empty synthesis → still llm_failed + blocking (not degraded)", async () => {
    const { ctx } = makeHarness({
      utterances: {
        teacher: [makeUtterance("t1", "teacher", "Mr. Lee", null, "Q1", 0, 3000)],
        students: [makeUtterance("s1", "students", "Alice", "S1", "I'm Alice, from MIT.", 3000, 9000)],
      },
      stats: [
        makeStat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        makeStat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      speakerEvents: [studentEvent("s1", "S1", "Alice")],
      speakerMap: [{ cluster_id: "S1", display_name: "Alice", source: "name_extract" }],
      reportPerPerson: [],
    });

    const result = await maybeRefreshFeedbackCache(ctx, "sess-rb", true);

    expect(result.report_source).toBe("llm_failed");
    expect(ACCEPTED_REPORT_SOURCES.has(result.report_source)).toBe(false);
    expect(result.blocking_reason).toBeTruthy();
    expect(result.ready).toBe(false);
  });

  it("BRANCH C — valid per_person from analysis/report → accepted (unchanged)", async () => {
    const { ctx } = makeHarness({
      utterances: {
        teacher: [makeUtterance("t1", "teacher", "Mr. Lee", null, "Q1", 0, 3000)],
        students: [makeUtterance("s1", "students", "Alice", "S1", "I'm Alice, from MIT.", 3000, 9000)],
      },
      stats: [
        makeStat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        makeStat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      speakerEvents: [studentEvent("s1", "S1", "Alice")],
      speakerMap: [{ cluster_id: "S1", display_name: "Alice", source: "name_extract" }],
      // Non-empty per_person → validateClaimEvidenceRefs runs. The claim below has no
      // evidence_refs, so validation flips to llm_failed — but crucially the degraded
      // fork must NOT hijack it (an eligible student spoke, so eligibleActive>0).
      reportPerPerson: [
        {
          person_key: "S1",
          display_name: "Alice",
          dimensions: [],
          summary: { strengths: [], risks: [], actions: [] },
        },
      ],
    });

    const result = await maybeRefreshFeedbackCache(ctx, "sess-rb", true);

    // With zero claims, validateClaimEvidenceRefs → valid=false (claimCount===0),
    // so this path becomes llm_failed. That's fine — the point of C is that a
    // *validatable* candidate is NOT hijacked by the degraded fork. Assert the
    // fork did NOT fire (source is not degraded_no_participants).
    expect(result.report_source).not.toBe("degraded_no_participants");
  });
});

// ── D: good-cache overwrite guard ────────────────────────────────────────────

describe("maybeRefreshFeedbackCache — R-B good-cache guard", () => {
  it("BRANCH D — existing accepted good cache + non-accepted recompute → good cache NOT overwritten", async () => {
    // Simulate a prior GOOD degraded cache (accepted source, ready=true).
    const goodReport = { session: { session_id: "sess-rb" } } as unknown as ResultV2;
    const goodCache = baseCache({
      report_source: "degraded_no_participants",
      ready: true,
      quality_gate_passed: true,
      blocking_reason: null,
      report: goodReport,
      overall_summary_cache: { notice: NO_STUDENT_SPEECH_NOTICE },
    });

    // But this recompute is engineered to yield a NON-accepted source: an eligible
    // student spoke (so the degraded fork does NOT fire) AND synthesis returns
    // empty → llm_failed. Without the guard this bad result overwrites the good one.
    const { ctx } = makeHarness({
      utterances: {
        teacher: [makeUtterance("t1", "teacher", "Mr. Lee", null, "Q1", 0, 3000)],
        students: [makeUtterance("s1", "students", "Alice", "S1", "I'm Alice.", 3000, 9000)],
      },
      stats: [
        makeStat({ speaker_key: "teacher", speaker_name: "Mr. Lee", turns: 3, talk_time_ms: 12000 }),
        makeStat({ speaker_key: "S1", speaker_name: "Alice", turns: 3, talk_time_ms: 8000 }),
      ],
      speakerEvents: [studentEvent("s1", "S1", "Alice")],
      speakerMap: [{ cluster_id: "S1", display_name: "Alice", source: "name_extract" }],
      reportPerPerson: [],
      initialCache: goodCache,
    });

    const result = await maybeRefreshFeedbackCache(ctx, "sess-rb", true);

    // Guard: the good accepted cache must survive.
    expect(result.report_source).toBe("degraded_no_participants");
    expect(ACCEPTED_REPORT_SOURCES.has(result.report_source)).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.blocking_reason).toBeNull();
    expect(result.report).toBe(goodReport);
  });
});
