import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSpeechmaticsMessage,
  type RealtimeAsrContext,
} from "../src/realtime-asr-processor";
import { buildRealtimeRuntime } from "../src/asr-helpers";
import type {
  AsrRealtimeRuntime,
  AsrState,
  StreamRole,
  SessionState,
  UtteranceRaw,
  UtteranceMerged,
} from "../src/config";

/**
 * P0-a — utterance start_ms must spread across the SESSION timeline (real speaking time),
 * not collapse to 0~1s.
 *
 * Speechmatics reports word-level times relative to the CURRENT WS connection (each
 * StartRecognition resets its timeline to ~0). The Worker persists start_ms/end_ms on the
 * SESSION timeline. The fix derives start_ms from a per-connection session base
 * (runtime.connectionSessionBaseMs — the session ms already ingested when the connection's
 * StartRecognition fired) plus the Speechmatics connection-relative word time
 * (buf.startMs/buf.endMs). So:
 *   session start_ms = connectionSessionBaseMs + speechmatics word start_ms
 *
 * This keeps every utterance on the real time axis (no 00:00 collapse), stays monotonic
 * across a reconnect (base grows with the session), and still orders correctly in finalize
 * (reconcile sorts by start_ms). The session ingest chunk seq (start_seq/end_seq) remains
 * the authoritative cutoff/ordering integer — only the *timestamps* are corrected.
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
  const raw: Record<StreamRole, UtteranceRaw[]> = { mixed: [], teacher: [], students: [] };
  const merged: Record<StreamRole, UtteranceMerged[]> = { mixed: [], teacher: [], students: [] };
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

/** Build a Speechmatics final (AddTranscript) wire frame with connection-relative times. */
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

/**
 * Advance the drain-loop cursors the way the real drain loop would after ingesting audio
 * up to `sessionSec` seconds of the session. Chunks are 1s, so seq ≈ seconds. This mimics
 * "the drain loop has forwarded the session audio up to here" WITHOUT re-deriving start_ms
 * from these cursors.
 */
function advanceDrainCursorsTo(runtime: AsrRealtimeRuntime, sessionSec: number): void {
  const seq = Math.max(1, Math.round(sessionSec));
  if (runtime.currentStartSeq === null) runtime.currentStartSeq = seq;
  runtime.lastSentSeq = Math.max(runtime.lastSentSeq, seq);
}

describe("P0-a: utterance start_ms spreads across the session timeline (single connection)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps consecutive Speechmatics finals (0s / 5s / 12s) to session start_ms 0 / 5000 / 12000", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    // First connection: session base is 0 (nothing ingested yet before StartRecognition).
    runtime.connectionSessionBaseMs = 0;
    const { ctx, raw } = makeCtx(runtime);

    // Utterance 1: Speechmatics word time 0.0–3.0s. By the time its final arrives, the drain
    // loop has already forwarded ~4s of audio, so lastSentSeq ≈ 4.
    advanceDrainCursorsTo(runtime, 4);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("first", 0.0, 3.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    // Utterance 2: Speechmatics word time 5.0–8.0s; drain has advanced to ~9s.
    advanceDrainCursorsTo(runtime, 9);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("second", 5.0, 8.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    // Utterance 3: Speechmatics word time 12.0–15.0s; drain has advanced to ~16s.
    advanceDrainCursorsTo(runtime, 16);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("third", 12.0, 15.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    const students = raw.students;
    expect(students.map((u) => u.text)).toEqual(["first", "second", "third"]);

    // The core assertion the bug violates: start_ms follows the real speaking time, spread
    // across the session timeline — NOT collapsed into 0~1s and NOT a single giant span.
    expect(students[0].start_ms).toBe(0);
    expect(students[1].start_ms).toBe(5000);
    expect(students[2].start_ms).toBe(12000);
    expect(students[0].end_ms).toBe(3000);
    expect(students[1].end_ms).toBe(8000);
    expect(students[2].end_ms).toBe(15000);

    // start_seq / end_seq remain the SESSION ingest chunk seq (finalize cutoff/ordering key).
    expect(students[2].end_seq).toBeGreaterThan(students[0].end_seq);
  });
});

describe("P0-a: start_ms survives a mid-session Speechmatics reconnect (no inversion, no collapse)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("post-reconnect utterance gets start_ms = session base + speechmatics-relative time (greater than pre-reconnect)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.connectionSessionBaseMs = 0;
    const { ctx, raw } = makeCtx(runtime);

    // ── Pre-reconnect: utterance late in the session, Speechmatics word time 200–209s on the
    // FIRST connection (base 0). Drain has forwarded ~210s.
    advanceDrainCursorsTo(runtime, 210);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("first spoken", 200.0, 209.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    // ── Reconnect: a new StartRecognition resets the Speechmatics timeline to ~0. The session
    // base is now the session ms already ingested (drain never resets): ~215s.
    runtime.connectionSessionBaseMs = 215_000;
    advanceDrainCursorsTo(runtime, 224);
    // Utterance 2 arrives with Speechmatics-relative time ≈ 0 (post-reconnect timeline).
    await handleSpeechmaticsMessage("sess", "students", finalFrame("second spoken", 0.5, 8.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    const students = raw.students;
    expect(students).toHaveLength(2);
    const [u1, u2] = students;
    expect(u1.text).toBe("first spoken");
    expect(u2.text).toBe("second spoken");

    // Pre-reconnect: base 0 + 200s = 200000.
    expect(u1.start_ms).toBe(200_000);
    // Post-reconnect: session base 215000 + speechmatics 500 = 215500 (NOT collapsed to ~500).
    expect(u2.start_ms).toBe(215_500);

    // Monotonic: post-reconnect utterance strictly after the pre-reconnect one.
    expect(u2.start_ms).toBeGreaterThan(u1.start_ms);
    expect(u2.start_seq).toBeGreaterThan(u1.start_seq);

    // Finalize orders by start_ms — ordering must equal true speaking order.
    const byStartMs = [...students].sort((a, b) => a.start_ms - b.start_ms);
    expect(byStartMs.map((u) => u.text)).toEqual(["first spoken", "second spoken"]);
  });

  it("interleaved utterances across a reconnect finalize in true time order", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.connectionSessionBaseMs = 0;
    const { ctx, raw } = makeCtx(runtime);

    // Connection 1: two utterances at 3s and 40s.
    advanceDrainCursorsTo(runtime, 6);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("alpha", 3.0, 5.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);
    advanceDrainCursorsTo(runtime, 43);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("bravo", 40.0, 42.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    // Reconnect at ~50s.
    runtime.connectionSessionBaseMs = 50_000;
    advanceDrainCursorsTo(runtime, 53);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("charlie", 1.0, 3.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);
    advanceDrainCursorsTo(runtime, 62);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("delta", 9.0, 11.0), ctx);
    await handleSpeechmaticsMessage("sess", "students", END_OF_TRANSCRIPT, ctx);

    const byStartMs = [...raw.students].sort((a, b) => a.start_ms - b.start_ms);
    expect(byStartMs.map((u) => u.text)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    // No utterance collapsed to 0~1s except the genuine session-start one (there is none here).
    expect(raw.students.every((u) => u.start_ms >= 3000)).toBe(true);
  });
});
