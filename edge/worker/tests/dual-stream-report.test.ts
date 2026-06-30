/**
 * dual-stream-report.test.ts
 *
 * Locks the contract: interviewer (teacher stream) is included in synthesis
 * context but excluded from per-person scoring / stats persona cards.
 *
 * Two halves of the contract are asserted:
 *   A. computeSpeakerStats + buildMemoFirstReport → per_person contains ONLY
 *      student keys (S1/S2), NO "teacher" card.
 *   B. buildSynthesizePayload transcript payload contains the teacher lines
 *      (stream_role = "teacher") so the LLM has question context.
 */

import { describe, it, expect } from "vitest";
import {
  computeSpeakerStats,
  buildMemoFirstReport,
  buildEvidence,
  attachEvidenceToMemos,
  buildSynthesizePayload,
  type TranscriptItem,
} from "../src/finalize_v2";
import { analyzeEventsLocally } from "../src/local_events_analyzer";
import type { MemoItem } from "../src/types_v2";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeItem(
  id: string,
  role: "teacher" | "students",
  clusterId: string | null,
  speakerName: string | null,
  text: string,
  startMs: number,
  endMs: number
): TranscriptItem {
  return {
    utterance_id: id,
    stream_role: role,
    cluster_id: clusterId,
    speaker_name: speakerName,
    decision: "auto",
    text,
    start_ms: startMs,
    end_ms: endMs,
    duration_ms: endMs - startMs,
  };
}

/**
 * Mixed transcript:
 *   teacher: two questions
 *   students: S1 (Alice) and S2 (Bob) each have a response
 */
const TRANSCRIPT: TranscriptItem[] = [
  makeItem("u_t1", "teacher", null, null, "Tell me about yourself.", 0, 3000),
  makeItem("u_s1", "students", "S1", "Alice", "I'm Alice, I graduated from MIT.", 3000, 8000),
  makeItem("u_s2", "students", "S2", "Bob", "I'm Bob, I worked at a startup.", 8000, 13000),
  makeItem("u_t2", "teacher", null, null, "What is your greatest strength?", 13000, 16000),
  makeItem("u_s3", "students", "S1", "Alice", "I'm very organized and detail-oriented.", 16000, 21000),
  makeItem("u_s4", "students", "S2", "Bob", "My greatest strength is leadership.", 21000, 26000),
];

const MEMOS: MemoItem[] = [
  {
    memo_id: "m1",
    created_at_ms: 5000,
    author_role: "teacher",
    type: "observation",
    tags: ["collaboration"],
    text: "Alice showed strong collaboration skills.",
  },
  {
    memo_id: "m2",
    created_at_ms: 10000,
    author_role: "teacher",
    type: "observation",
    tags: ["leadership"],
    text: "Bob demonstrated clear leadership qualities.",
  },
];

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("dual-stream report: interviewer-as-context, not-scored contract", () => {
  // ── Part A: per-person stats / scoring boundary ───────────────────────────

  it("A1: computeSpeakerStats includes teacher key (raw stats expose the leak without filtering)", () => {
    // Raw computeSpeakerStats does include ALL utterances — callers must filter.
    const stats = computeSpeakerStats(TRANSCRIPT);
    const keys = stats.map((s) => s.speaker_key);
    // Confirm teacher IS in raw stats (so callers know they need to filter it out)
    expect(keys).toContain("teacher");
  });

  it("A2: filtering teacher from stats before buildMemoFirstReport removes teacher from per_person", () => {
    const rawStats = computeSpeakerStats(TRANSCRIPT);

    // The filter that callers MUST apply before building per-person feedback.
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");

    // Intermediate: filtered stats contain only the students, never teacher.
    const statKeys = studentStats.map((s) => s.speaker_key);
    expect(statKeys).not.toContain("teacher");
    expect(statKeys).toContain("Alice");
    expect(statKeys).toContain("Bob");

    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });
    const memosWithEvidence = attachEvidenceToMemos(MEMOS, evidence);
    const report = buildMemoFirstReport({
      transcript: TRANSCRIPT,
      memos: memosWithEvidence,
      evidence,
      stats: studentStats,
    });

    const personKeys = report.per_person.map((p) => p.person_key);

    // No teacher / Interviewer card in per_person
    expect(personKeys).not.toContain("teacher");
    expect(personKeys).not.toContain("Interviewer");
    expect(personKeys.some((k) => k.toLowerCase().includes("teacher"))).toBe(false);

    // Both student keys present
    expect(personKeys).toContain("Alice");
    expect(personKeys).toContain("Bob");
  });

  // Documents the pre-fix bug callers must guard against; not a regression if buildMemoFirstReport is ever made teacher-safe internally.
  it("A3: buildMemoFirstReport with unfiltered stats leaks teacher into per_person (characterizes the bug)", () => {
    // This test documents existing behavior: WITHOUT filtering, teacher card appears.
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });
    const memosWithEvidence = attachEvidenceToMemos(MEMOS, evidence);
    const report = buildMemoFirstReport({
      transcript: TRANSCRIPT,
      memos: memosWithEvidence,
      evidence,
      stats: rawStats,
    });

    // Leak: teacher appears as a person when stats are not filtered.
    const personKeys = report.per_person.map((p) => p.person_key);
    expect(personKeys).toContain("teacher");
  });

  // ── Part B: synthesis context preserves teacher lines ────────────────────

  it("B1: buildSynthesizePayload includes teacher utterances in transcript context", () => {
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");
    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });
    const memosWithEvidence = attachEvidenceToMemos(MEMOS, evidence);

    const payload = buildSynthesizePayload({
      sessionId: "sess_001",
      transcript: TRANSCRIPT,
      memos: MEMOS,
      evidence,
      stats: studentStats,
      events: [],
      bindings: [],
      rubric: null,
      sessionContext: null,
      freeFormNotes: null,
      historical: [],
      stages: [],
      locale: "en-US",
    });

    // Teacher lines MUST be present in synthesis transcript
    const teacherLines = payload.transcript.filter((u) => u.stream_role === "teacher");
    expect(teacherLines.length).toBe(2);

    // Teacher lines carry their text so the LLM understands what was asked
    const texts = teacherLines.map((u) => u.text);
    expect(texts).toContain("Tell me about yourself.");
    expect(texts).toContain("What is your greatest strength?");
  });

  it("B2: buildSynthesizePayload stats does NOT include teacher", () => {
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");
    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });

    const payload = buildSynthesizePayload({
      sessionId: "sess_001",
      transcript: TRANSCRIPT,
      memos: MEMOS,
      evidence,
      stats: studentStats,
      events: [],
      bindings: [],
      rubric: null,
      sessionContext: null,
      freeFormNotes: null,
      historical: [],
      stages: [],
      locale: "en-US",
    });

    const statKeys = payload.stats.map((s) => s.speaker_key);
    expect(statKeys).not.toContain("teacher");
    expect(statKeys).toContain("Alice");
    expect(statKeys).toContain("Bob");
  });

  // ── Part C: teacher utterance count untouched in transcript ─────────────

  it("C1: full TRANSCRIPT has exactly 2 teacher and 4 student utterances", () => {
    const teacherCount = TRANSCRIPT.filter((u) => u.stream_role === "teacher").length;
    const studentCount = TRANSCRIPT.filter((u) => u.stream_role === "students").length;
    expect(teacherCount).toBe(2);
    expect(studentCount).toBe(4);
  });

  // ── Part D: structural soundness — teacher carrying a speaker_name ────────
  // Simulates a future ASR backend (e.g. ACS captions / multi-channel
  // diarization) that attaches a speaker_name to teacher-stream utterances.
  // speakerKey() must collapse these to "teacher" so the
  // `speaker_key !== "teacher"` filter still excludes the interviewer.

  const ACS_TRANSCRIPT: TranscriptItem[] = [
    // Teacher stream utterances carry an ASR-provided speaker_name ("Tim").
    makeItem("u_t1", "teacher", null, "Tim", "Tell me about yourself.", 0, 3000),
    makeItem("u_s1", "students", "S1", "Alice", "I'm Alice, I graduated from MIT.", 3000, 8000),
    makeItem("u_t2", "teacher", null, "Tim", "What is your greatest strength?", 8000, 11000),
    makeItem("u_s2", "students", "S2", "Bob", "My greatest strength is leadership.", 11000, 16000),
  ];

  it("D1: computeSpeakerStats keys named teacher utterance as 'teacher', NOT 'Tim'", () => {
    const stats = computeSpeakerStats(ACS_TRANSCRIPT);
    const keys = stats.map((s) => s.speaker_key);
    // Teacher collapses to "teacher" even though the ASR event named it "Tim".
    expect(keys).toContain("teacher");
    expect(keys).not.toContain("Tim");
    expect(keys).toContain("Alice");
    expect(keys).toContain("Bob");
  });

  it("D2: named teacher utterance is excluded from per_person after filter", () => {
    const rawStats = computeSpeakerStats(ACS_TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");

    const evidence = buildEvidence({ memos: MEMOS, transcript: ACS_TRANSCRIPT });
    const memosWithEvidence = attachEvidenceToMemos(MEMOS, evidence);
    const report = buildMemoFirstReport({
      transcript: ACS_TRANSCRIPT,
      memos: memosWithEvidence,
      evidence,
      stats: studentStats,
    });

    const personKeys = report.per_person.map((p) => p.person_key);
    // The interviewer's ASR name must NOT leak into per_person.
    expect(personKeys).not.toContain("Tim");
    expect(personKeys).not.toContain("teacher");
    expect(personKeys).toContain("Alice");
    expect(personKeys).toContain("Bob");
  });

  it("D3: named teacher utterance still appears in synthesis transcript as context", () => {
    const rawStats = computeSpeakerStats(ACS_TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");
    const evidence = buildEvidence({ memos: MEMOS, transcript: ACS_TRANSCRIPT });

    const payload = buildSynthesizePayload({
      sessionId: "sess_acs",
      transcript: ACS_TRANSCRIPT,
      memos: MEMOS,
      evidence,
      stats: studentStats,
      events: [],
      bindings: [],
      rubric: null,
      sessionContext: null,
      freeFormNotes: null,
      historical: [],
      stages: [],
      locale: "en-US",
    });

    const teacherLines = payload.transcript.filter((u) => u.stream_role === "teacher");
    expect(teacherLines.length).toBe(2);
    const texts = teacherLines.map((u) => u.text);
    expect(texts).toContain("Tell me about yourself.");
    expect(texts).toContain("What is your greatest strength?");

    // And the interviewer is NOT in the synthesis stats roster.
    const statKeys = payload.stats.map((s) => s.speaker_key);
    expect(statKeys).not.toContain("Tim");
    expect(statKeys).not.toContain("teacher");
  });

  // ── Part F: feedback-cache-refresh and tier2 report paths ───────────────────
  // Both paths follow the same contract as finalize-orchestrator (R-T4):
  // derive studentStats = stats.filter(s => s.speaker_key !== "teacher") and
  // feed only studentStats to buildMemoFirstReport / buildSynthesizePayload.
  // These tests assert that contract at the unit level for the shared helpers.

  it("F1: cache-refresh memo-first path: teacher excluded from per_person after studentStats filter", () => {
    // Simulates the buildMemoFirstReport call in feedback-cache-refresh.ts
    // (lines 146-151 after fix): stats filtered to studentStats before the call.
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");

    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });
    const memosWithEvidence = attachEvidenceToMemos(MEMOS, evidence);
    const memoFirst = buildMemoFirstReport({
      transcript: TRANSCRIPT,
      memos: memosWithEvidence,
      evidence,
      stats: studentStats,
    });

    const personKeys = memoFirst.per_person.map((p) => p.person_key);
    // Teacher must not appear as a person card in the cache-refresh memo-first baseline.
    expect(personKeys).not.toContain("teacher");
    expect(personKeys).not.toContain("Interviewer");
    expect(personKeys.some((k) => k.toLowerCase().includes("teacher"))).toBe(false);
    // Both student cards present.
    expect(personKeys).toContain("Alice");
    expect(personKeys).toContain("Bob");
  });

  it("F2: cache-refresh report path: teacher NOT leaked to events/report stats payload after filter", () => {
    // Simulates the eventsPayload and invokeInferenceAnalysisReport stats arg
    // in feedback-cache-refresh.ts (lines 156-184 after fix).
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");

    // The stats field sent to events and report endpoints must exclude teacher.
    const statKeys = studentStats.map((s) => s.speaker_key);
    expect(statKeys).not.toContain("teacher");
    expect(statKeys).toContain("Alice");
    expect(statKeys).toContain("Bob");
  });

  it("F3: tier2 synthesize path: teacher excluded from buildSynthesizePayload stats after studentStats filter", () => {
    // Simulates the buildSynthesizePayload call in tier2-processor.ts
    // (line 296-312 after fix): stats: studentStats, not mergedStats.
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    const studentStats = rawStats.filter((s) => s.speaker_key !== "teacher");
    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });

    const payload = buildSynthesizePayload({
      sessionId: "sess_tier2",
      transcript: TRANSCRIPT,
      memos: MEMOS,
      evidence,
      stats: studentStats,
      events: [],
      bindings: [],
      rubric: null,
      sessionContext: null,
      freeFormNotes: null,
      historical: [],
      stages: [],
      locale: "en-US",
    });

    // Teacher must not appear in the synthesize stats roster.
    const statKeys = payload.stats.map((s) => s.speaker_key);
    expect(statKeys).not.toContain("teacher");
    expect(statKeys).toContain("Alice");
    expect(statKeys).toContain("Bob");

    // Teacher lines must still appear in the synthesis transcript (LLM context).
    const teacherLines = payload.transcript.filter((u) => u.stream_role === "teacher");
    expect(teacherLines.length).toBe(2);
  });

  it("F4: tier2 without filter would leak teacher into synthesize stats (characterizes the bug)", () => {
    // Documents the pre-fix behavior: WITHOUT the studentStats filter,
    // mergedStats flows into buildSynthesizePayload and teacher appears.
    const rawStats = computeSpeakerStats(TRANSCRIPT);
    // intentionally NOT filtering — simulates the pre-fix tier2 path
    const evidence = buildEvidence({ memos: MEMOS, transcript: TRANSCRIPT });

    const payload = buildSynthesizePayload({
      sessionId: "sess_tier2_nofilt",
      transcript: TRANSCRIPT,
      memos: MEMOS,
      evidence,
      stats: rawStats,
      events: [],
      bindings: [],
      rubric: null,
      sessionContext: null,
      freeFormNotes: null,
      historical: [],
      stages: [],
      locale: "en-US",
    });

    // Leak: teacher appears in synthesis stats when filter is absent.
    const statKeys = payload.stats.map((s) => s.speaker_key);
    expect(statKeys).toContain("teacher");
  });

  // ── Part E: events path also collapses named teacher to "teacher" ─────────
  // analyzeEventsLocally has its OWN speakerKey() and feeds the synthesis events
  // payload (actor/target). A teacher utterance carrying speaker_name "Tim" must
  // be attributed to "teacher" — never "Tim" — in event actors/targets.

  it("E1: a named teacher interruption is attributed to 'teacher', not 'Tim'", () => {
    // Teacher (named "Tim" by ASR) speaks a long turn, then a student interrupts.
    // Interruption fires when curr.start_ms <= prev.end_ms + 300 and
    // prev.duration_ms >= 1200 and speakers differ.
    const transcript: TranscriptItem[] = [
      // Teacher long turn (>= 1200ms) carrying an ASR-provided name.
      makeItem("u_t1", "teacher", null, "Tim", "Let me explain the next question in detail here.", 0, 4000),
      // Student starts before teacher's turn ends + 300ms → interruption.
      makeItem("u_s1", "students", "S1", "Alice", "Sorry, can I jump in here?", 4100, 7000),
    ];

    const events = analyzeEventsLocally({
      sessionId: "sess_evt",
      transcript,
      memos: [],
      stats: [
        { speaker_key: "teacher", talk_time_ms: 4000, turns: 1 },
        { speaker_key: "Alice", talk_time_ms: 2900, turns: 1 },
      ],
    });

    const interrupts = events.filter((e) => e.event_type === "interrupt");
    expect(interrupts.length).toBeGreaterThan(0);

    // The interrupted party (target) is the teacher, keyed as "teacher", NOT "Tim".
    const targets = interrupts.map((e) => e.target);
    expect(targets).toContain("teacher");
    expect(targets).not.toContain("Tim");

    // The interviewer name must never appear as an actor/target anywhere.
    for (const e of events) {
      expect(e.actor).not.toBe("Tim");
      expect(e.target).not.toBe("Tim");
    }
  });
});
