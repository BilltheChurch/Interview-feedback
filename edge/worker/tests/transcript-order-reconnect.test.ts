import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSpeechmaticsMessage,
  type RealtimeAsrContext,
} from "../src/realtime-asr-processor";
import { buildRealtimeRuntime } from "../src/asr-helpers";
import { buildReconciledTranscript } from "../src/reconcile";
import type {
  AsrRealtimeRuntime,
  AsrState,
  StreamRole,
  SessionState,
  UtteranceRaw,
  UtteranceMerged,
} from "../src/config";

/**
 * R-E — finalize transcript order must follow the session-monotonic clock, not the
 * Speechmatics connection-relative clock.
 *
 * Speechmatics numbers each WS recognition connection from ~0 (each StartRecognition
 * resets the transcript timeline). The Worker's authoritative clock is the ingest chunk
 * seq maintained by the drain loop (runtime.currentStartSeq / runtime.lastSentSeq). When
 * the students stream reconnects mid-session the Speechmatics t.start_ms collapses back to
 * a small value; the persisted utterance start_ms/start_seq must NOT collapse with it,
 * otherwise finalize (which orders by start) reports segments out of true speaking order.
 */

function makeAsrState(): AsrState {
  return {
    enabled: true,
    provider: "dashscope",
    model: "test-model",
    window_seconds: 8,
    hop_seconds: 4,
    last_window_end_seq: 0,
    utterance_count: 0,
    total_windows_processed: 0,
    total_audio_seconds_processed: 0,
    consecutive_failures: 0,
    next_retry_after_ms: 0,
    updated_at: new Date(0).toISOString(),
  };
}

function makeCtx(runtime: AsrRealtimeRuntime): {
  ctx: RealtimeAsrContext;
  raw: Record<StreamRole, UtteranceRaw[]>;
} {
  const raw: Record<StreamRole, UtteranceRaw[]> = {
    mixed: [],
    teacher: [],
    students: [],
  };
  const merged: Record<StreamRole, UtteranceMerged[]> = {
    mixed: [],
    teacher: [],
    students: [],
  };
  const asrByStream: Record<StreamRole, AsrState> = {
    mixed: makeAsrState(),
    teacher: makeAsrState(),
    students: makeAsrState(),
  };
  const runtimes: Record<StreamRole, AsrRealtimeRuntime> = {
    mixed: buildRealtimeRuntime("mixed"),
    teacher: buildRealtimeRuntime("teacher"),
    students: runtime,
  };
  const state = { config: {}, roster: [] } as unknown as SessionState;

  const ctx = {
    env: { ASR_PROVIDER: "speechmatics" },
    asrRealtimeByStream: runtimes,
    doCtx: {
      storage: { get: vi.fn(async () => state), put: vi.fn(async () => {}) },
      waitUntil: vi.fn(),
    },
    asrRealtimeEnabled: () => true,
    currentIsoTs: () => new Date().toISOString(),
    loadAsrByStream: async () => asrByStream,
    storeAsrByStream: async () => {},
    loadUtterancesRawByStream: async () => raw,
    storeUtterancesRawByStream: async (s: Record<StreamRole, UtteranceRaw[]>) => {
      raw.students = s.students;
      raw.teacher = s.teacher;
      raw.mixed = s.mixed;
    },
    loadUtterancesMergedByStream: async () => merged,
    storeUtterancesMergedByStream: async () => {},
    loadIngestByStream: async () => ({
      mixed: { last_seq: 0 },
      teacher: { last_seq: 0 },
      students: { last_seq: 0 },
    }),
    patchAsrCursor: async () => {},
    appendSpeakerEvent: async () => {},
    maybeScheduleCheckpoint: async () => {},
    broadcastTranscriptFrame: () => {},
  } as unknown as RealtimeAsrContext;

  return { ctx, raw };
}

/** Build a Speechmatics final (AddTranscript) wire frame. */
function finalFrame(text: string, startSec: number, endSec: number, speaker = "S1"): string {
  return JSON.stringify({
    message: "AddTranscript",
    transcript: text,
    metadata: { start_time: startSec, end_time: endSec },
    results: [
      {
        type: "word",
        start_time: startSec,
        end_time: endSec,
        alternatives: [{ content: text, speaker }],
      },
    ],
  });
}

const END_OF_TRANSCRIPT = JSON.stringify({ message: "EndOfTranscript" });

describe("R-E: transcript order survives a mid-session Speechmatics reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the post-reconnect utterance ordered AFTER the pre-reconnect one (session clock, not Speechmatics-relative)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, raw } = makeCtx(runtime);

    // ── Utterance 1: happens LATE in the session. The drain loop (session clock) has
    // already advanced the seq cursors to ~200s of audio for this window. Speechmatics
    // reports its own connection-relative time (200s) for this FIRST connection, whose
    // session base is 0 (nothing ingested before the very first StartRecognition).
    runtime.connectionSessionBaseMs = 0;
    runtime.currentStartSeq = 201; // drain loop: session chunk seq for window start
    runtime.lastSentSeq = 210;     // drain loop: latest session chunk seq sent
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      finalFrame("first spoken", 200.0, 209.0),
      ctx
    );
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    // ── Speechmatics WS RECONNECTS. A fresh StartRecognition resets its timeline to ~0.
    // connectSpeechmaticsRealtime captures the session ms already ingested as this
    // connection's session base (~215s). The drain loop keeps counting session chunk seq
    // (it never resets), so the NEXT window's session cursors are even higher.
    runtime.connectionSessionBaseMs = 215_000; // set at StartRecognition = session ms ingested
    runtime.currentStartSeq = 215; // session chunk seq — strictly after utterance 1
    runtime.lastSentSeq = 224;
    // Utterance 2 arrives with Speechmatics-relative time ≈ 0 (post-reconnect timeline).
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      finalFrame("second spoken", 0.5, 8.0),
      ctx
    );
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    const students = raw.students;
    expect(students).toHaveLength(2);
    const [u1, u2] = students;
    expect(u1.text).toBe("first spoken");
    expect(u2.text).toBe("second spoken");

    // The post-reconnect utterance must sort AFTER the first by BOTH keys. With the OLD bug
    // (seq-derived start_ms, no session base), the reconnect timeline collapsed u2 onto a
    // small start; now start_ms = connectionSessionBaseMs + speechmatics-relative time:
    //   u1 = 0 + 200000 = 200000,  u2 = 215000 + 500 = 215500 → monotonic, no inversion.
    expect(u1.start_ms).toBe(200_000);
    expect(u2.start_ms).toBe(215_500);
    expect(u2.start_seq).toBeGreaterThan(u1.start_seq);
    expect(u2.start_ms).toBeGreaterThan(u1.start_ms);

    // Finalize orders by start_ms (reconcile.ts). Ordering by start_ms must equal true order.
    const byStartMs = [...students].sort((a, b) => a.start_ms - b.start_ms);
    expect(byStartMs.map((u) => u.text)).toEqual(["first spoken", "second spoken"]);
  });

  it("finalize buildReconciledTranscript orders interleaved teacher+students by true time", () => {
    // Real speaking order: teacher(t0) → student(t1) → teacher(t2) → student(t3, post-reconnect).
    // The student post-reconnect utterance carries a SESSION-clock start_ms (not collapsed).
    const teacher: Parameters<typeof buildReconciledTranscript>[0]["utterances"] = [
      { utterance_id: "t-a", stream_role: "teacher", text: "welcome", start_ms: 0, end_ms: 4000, duration_ms: 4000 },
      { utterance_id: "t-b", stream_role: "teacher", text: "next question", start_ms: 20000, end_ms: 24000, duration_ms: 4000 },
    ];
    const students: typeof teacher = [
      { utterance_id: "s-a", stream_role: "students", text: "my answer one", start_ms: 5000, end_ms: 12000, duration_ms: 7000 },
      { utterance_id: "s-b", stream_role: "students", text: "my answer two", start_ms: 25000, end_ms: 33000, duration_ms: 8000 },
    ];
    const transcript = buildReconciledTranscript({
      utterances: [...teacher, ...students],
      events: [],
      speakerLogs: { speaker_map: [], turns: [], embeddings: [] } as never,
      state: { config: {}, roster: [], bindings: {}, cluster_binding_meta: {}, clusters: [] } as never,
      diarizationBackend: "cloud",
      roster: [],
    });
    expect(transcript.map((t) => t.text)).toEqual([
      "welcome",
      "my answer one",
      "next question",
      "my answer two",
    ]);
  });
});
