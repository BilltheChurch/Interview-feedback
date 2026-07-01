import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSpeechmaticsMessage,
  closeRealtimeAsrSession,
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
 * Silence-timeout flush.
 *
 * flushSttBuffer (the endpointing settle) previously fired ONLY when (a) the NEXT
 * Speechmatics final arrived and the silence gap / speaker changed, or (b) EndOfTranscript
 * on graceful close. So a speaker who finished a sentence and then paused (no next final)
 * left the accumulated buffer suspended forever — the Desktop only ever saw partial
 * (isFinal=false) frames for that utterance and never its final. These tests pin a
 * per-stream silence timer that flushes the buffer after STT_SILENCE_FLUSH_MS of no new
 * finals, emitting the settled utterance (isFinal=true) on the SAME session-clock path.
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

type BroadcastCall = {
  role: StreamRole;
  speaker: string | null;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
};

function makeCtx(
  runtime: AsrRealtimeRuntime,
  env: Record<string, string> = {}
): {
  ctx: RealtimeAsrContext;
  raw: Record<StreamRole, UtteranceRaw[]>;
  calls: BroadcastCall[];
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
  const calls: BroadcastCall[] = [];

  const ctx = {
    env: { ASR_PROVIDER: "speechmatics", ...env },
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
    broadcastTranscriptFrame: (
      role: StreamRole,
      speaker: string | null,
      text: string,
      isFinal: boolean,
      startMs: number,
      endMs: number
    ) => {
      calls.push({ role, speaker, text, isFinal, startMs, endMs });
    },
  } as unknown as RealtimeAsrContext;

  return { ctx, raw, calls };
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

describe("silence-timeout flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("flushes a buffered final into an emitted utterance after the silence window with no next final", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, raw, calls } = makeCtx(runtime, { STT_SILENCE_FLUSH_MS: "1200" });

    // One final arrives → buffered, not yet emitted (single final never gap-flushes).
    // Round-3 endpointing: the text ends on sentence-final punctuation, so the SHORT silence
    // window is allowed to settle it (an unpunctuated buffer would wait for the long backstop).
    await handleSpeechmaticsMessage("sess", "students", finalFrame("hello there.", 1.0, 1.8), ctx);
    expect(runtime.sttBuffer).not.toBeNull();
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);

    // No next final arrives. Advance past the silence window.
    await vi.advanceTimersByTimeAsync(1300);

    // The silence timer must have flushed the buffer and emitted the settled utterance.
    expect(runtime.sttBuffer).toBeNull();
    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("hello there.");
    expect(finals[0].role).toBe("students");
    // A raw utterance was persisted.
    expect(raw.students).toHaveLength(1);
    expect(raw.students[0].text).toBe("hello there.");
    // start_seq/end_seq remain the SESSION ingest chunk seq (finalize cutoff/ordering key).
    expect(raw.students[0].start_seq).toBe(5);
    expect(raw.students[0].end_seq).toBe(12);
    // P0-a: start_ms/end_ms are the Speechmatics word times shifted onto the session timeline
    // by this connection's session base (default 0 here): 1.0s→1000, 1.8s→1800. They reflect
    // the real speaking time, not the emit-boundary seq span.
    expect(raw.students[0].start_ms).toBe(1000);
    expect(raw.students[0].end_ms).toBe(1800);
  });

  it("does not flush before the silence window elapses", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 3;
    runtime.lastSentSeq = 7;
    const { ctx, calls } = makeCtx(runtime, { STT_SILENCE_FLUSH_MS: "1200" });

    await handleSpeechmaticsMessage("sess", "students", finalFrame("still talking", 1.0, 1.8), ctx);
    await vi.advanceTimersByTimeAsync(1000); // < 1200

    expect(runtime.sttBuffer).not.toBeNull();
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
  });

  it("a second final inside the window resets the timer (first sentence is not flushed early)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 4;
    runtime.lastSentSeq = 10;
    const { ctx, calls } = makeCtx(runtime, { STT_SILENCE_FLUSH_MS: "1200" });

    // First final at t0.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("part one", 1.0, 1.5), ctx);
    // Second final 800ms later — same speaker, tiny gap → accumulates, does NOT gap-flush.
    // Ends on sentence-final punctuation so the SHORT silence window may settle the combined
    // sentence (round-3 punctuation gate; an unpunctuated buffer would wait for the backstop).
    await vi.advanceTimersByTimeAsync(800);
    await handleSpeechmaticsMessage("sess", "students", finalFrame("part two.", 1.6, 2.1), ctx);

    // 800ms after the SECOND final (1600ms after the first). If the first timer had NOT
    // been reset it would have fired at 1200ms and flushed a truncated sentence. It must not.
    await vi.advanceTimersByTimeAsync(800);
    expect(runtime.sttBuffer).not.toBeNull();
    expect(runtime.sttBuffer?.texts).toEqual(["part one", "part two."]);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);

    // Now let the (reset) timer expire → one combined utterance settles.
    await vi.advanceTimersByTimeAsync(500); // total 1300ms past the second final
    expect(runtime.sttBuffer).toBeNull();
    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("part one part two.");
  });

  it("a gap-triggered flush cancels the silence timer (no duplicate emit)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 2;
    runtime.lastSentSeq = 6;
    const { ctx, calls } = makeCtx(runtime, { STT_SILENCE_FLUSH_MS: "1200" });

    // First final. Ends on sentence-final punctuation so the gap-flush gate (round-3) allows
    // the far-later final to settle it.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("sentence one.", 1.0, 1.5), ctx);
    // A far-later final (> STT_UTTERANCE_GAP_MS default 900 gap) → gap-flushes sentence one
    // immediately, then buffers sentence two.
    runtime.currentStartSeq = 8;
    runtime.lastSentSeq = 14;
    await handleSpeechmaticsMessage("sess", "students", finalFrame("sentence two.", 5.0, 5.6), ctx);

    // Exactly one final so far (sentence one) — sentence two still buffered.
    let finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("sentence one.");
    expect(runtime.sttBuffer?.texts).toEqual(["sentence two."]);

    // The silence timer (re-armed by sentence two's buffering) fires → sentence two settles
    // exactly ONCE. The old timer from sentence one must not double-emit.
    await vi.advanceTimersByTimeAsync(1300);
    finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(2);
    expect(finals[1].text).toBe("sentence two.");
    expect(runtime.sttBuffer).toBeNull();
  });

  it("closing the session cancels a pending silence timer (no post-close emit)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 9;
    const { ctx, calls } = makeCtx(runtime, { STT_SILENCE_FLUSH_MS: "1200" });

    await handleSpeechmaticsMessage("sess", "students", finalFrame("last words", 1.0, 1.5), ctx);
    // Graceful close drains the buffer via EndOfTranscript in production; here we assert the
    // pending timer itself is cancelled so it cannot fire a stray emit after teardown.
    await closeRealtimeAsrSession("students", "test-close", ctx, true, false);

    const finalsBeforeAdvance = calls.filter((c) => c.isFinal).length;
    await vi.advanceTimersByTimeAsync(2000);
    const finalsAfterAdvance = calls.filter((c) => c.isFinal).length;
    expect(finalsAfterAdvance).toBe(finalsBeforeAdvance);
  });
});
