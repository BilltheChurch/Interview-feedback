import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  maybeForwardPartial,
  handleSpeechmaticsMessage,
  type RealtimeAsrContext,
} from "../src/realtime-asr-processor";
import { buildRealtimeRuntime } from "../src/asr-helpers";
import type { AsrRealtimeRuntime, StreamRole, SessionState } from "../src/config";

/**
 * R4 — live in-place partial captions.
 *
 * Speechmatics AddPartialTranscript carries the cumulative full text of the in-progress
 * utterance. The Worker forwards it as a non-final frame (isFinal=false) so the Desktop
 * can render a live "still typing" line; the final path (AddTranscript) stays isFinal=true
 * and only fires after the sentence-level utterance flushes. These tests pin that split,
 * the partial dedupe/throttle, and speaker-attribution parity between partial and final.
 */

type BroadcastCall = {
  role: StreamRole;
  speaker: string | null;
  text: string;
  isFinal: boolean;
  startMs: number;
  endMs: number;
};

function makeCtx(opts: {
  runtimes?: Partial<Record<StreamRole, AsrRealtimeRuntime>>;
  state?: Partial<SessionState>;
  env?: Record<string, string>;
}): { ctx: RealtimeAsrContext; calls: BroadcastCall[] } {
  const calls: BroadcastCall[] = [];
  const runtimes: Record<StreamRole, AsrRealtimeRuntime> = {
    mixed: buildRealtimeRuntime("mixed"),
    teacher: buildRealtimeRuntime("teacher"),
    students: buildRealtimeRuntime("students"),
    ...(opts.runtimes as Record<StreamRole, AsrRealtimeRuntime>),
  };
  const state = { config: {}, roster: [], ...opts.state } as SessionState;

  const ctx = {
    env: { ASR_PROVIDER: "speechmatics", ...(opts.env ?? {}) },
    asrRealtimeByStream: runtimes,
    doCtx: {
      storage: {
        get: vi.fn(async () => state),
      },
      waitUntil: vi.fn(),
    },
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

  return { ctx, calls };
}

/** Build a raw Speechmatics transcript frame (AddPartialTranscript / AddTranscript). */
function transcriptFrame(opts: {
  partial: boolean;
  text: string;
  words: Array<{ content: string; speaker?: string; start: number; end: number }>;
}): string {
  return JSON.stringify({
    message: opts.partial ? "AddPartialTranscript" : "AddTranscript",
    transcript: opts.text,
    metadata: {
      start_time: opts.words[0]?.start ?? 0,
      end_time: opts.words[opts.words.length - 1]?.end ?? 0,
    },
    results: opts.words.map((w) => ({
      type: "word",
      start_time: w.start,
      end_time: w.end,
      alternatives: [{ content: w.content, speaker: w.speaker }],
    })),
  });
}

describe("maybeForwardPartial (R4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Non-zero origin: lastPartialSentAt initializes to 0 (= "never sent"), so a 0-based
    // clock would make the first forward look like a reset. Start at 10s to disambiguate.
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards a partial with isFinal=false", async () => {
    const { ctx, calls } = makeCtx({});
    await maybeForwardPartial("sess", "students", "hello there", "S1", ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].isFinal).toBe(false);
    expect(calls[0].role).toBe("students");
    expect(calls[0].speaker).toBe("S1");
    expect(calls[0].text).toBe("hello there");
  });

  it("drops empty partial text", async () => {
    const { ctx, calls } = makeCtx({});
    await maybeForwardPartial("sess", "students", "", "S1", ctx);
    expect(calls).toHaveLength(0);
  });

  it("dedupes a partial whose normalized text is unchanged", async () => {
    const { ctx, calls } = makeCtx({});
    await maybeForwardPartial("sess", "students", "hello world", "S1", ctx);
    // Advance past the throttle window so only dedupe (not throttle) can block it.
    vi.setSystemTime(10_500);
    await maybeForwardPartial("sess", "students", "hello world", "S1", ctx);
    expect(calls).toHaveLength(1);
  });

  it("throttles two changed partials that arrive inside the throttle window", async () => {
    const { ctx, calls } = makeCtx({});
    await maybeForwardPartial("sess", "students", "hello", "S1", ctx);
    vi.setSystemTime(10_050); // +50ms < resolvePartialThrottleMs default (100)
    await maybeForwardPartial("sess", "students", "hello world", "S1", ctx);
    expect(calls).toHaveLength(1);
    // Past the window → the next changed partial forwards.
    vi.setSystemTime(10_300);
    await maybeForwardPartial("sess", "students", "hello world today", "S1", ctx);
    expect(calls).toHaveLength(2);
    expect(calls[1].text).toBe("hello world today");
  });

  it("resolves the teacher speaker via interviewer identity (never a student)", async () => {
    const { ctx, calls } = makeCtx({
      state: { config: { interviewer_name: "Dr. Smith" } } as Partial<SessionState>,
    });
    await maybeForwardPartial("sess", "teacher", "how was your week", null, ctx);
    expect(calls).toHaveLength(1);
    expect(calls[0].speaker).toBe("Dr. Smith");
    expect(calls[0].isFinal).toBe(false);
  });

  it("falls back to 'teacher' when no interviewer identity is configured", async () => {
    const { ctx, calls } = makeCtx({});
    await maybeForwardPartial("sess", "teacher", "next question please", null, ctx);
    expect(calls[0].speaker).toBe("teacher");
  });
});

describe("handleSpeechmaticsMessage — partial vs final routing (R4)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("broadcasts an AddPartialTranscript frame as a non-final caption", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "it was",
        words: [
          { content: "it", speaker: "S1", start: 1.0, end: 1.2 },
          { content: "was", speaker: "S1", start: 1.2, end: 1.5 },
        ],
      }),
      ctx
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].isFinal).toBe(false);
    expect(calls[0].speaker).toBe("S1");
    expect(calls[0].text).toBe("it was");
    // Partials must not be persisted as an utterance / advance the emit cursor.
    expect(runtime.sttBuffer).toBeNull();
  });

  it("buffers an AddTranscript (final) frame instead of broadcasting immediately", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "it was good",
        words: [
          { content: "it", speaker: "S1", start: 1.0, end: 1.2 },
          { content: "was", speaker: "S1", start: 1.2, end: 1.5 },
          { content: "good", speaker: "S1", start: 1.5, end: 1.9 },
        ],
      }),
      ctx
    );

    // A single final does not flush yet — it accumulates into the sentence buffer and is
    // emitted (isFinal=true) later on a silence gap / speaker change / EndOfTranscript.
    expect(calls).toHaveLength(0);
    expect(runtime.sttBuffer).not.toBeNull();
    expect(runtime.sttBuffer?.texts).toEqual(["it was good"]);
    expect(runtime.sttBuffer?.speaker).toBe("S1");
  });

  it("clears the partial dedupe marker and throttle timestamp when a final arrives", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.lastPartialTextNorm = "stale partial";
    runtime.lastPartialSentAt = 10_000;
    const { ctx } = makeCtx({ runtimes: { students: runtime } });

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "done",
        words: [{ content: "done", speaker: "S1", start: 2.0, end: 2.3 }],
      }),
      ctx
    );

    expect(runtime.lastPartialTextNorm).toBe("");
    expect(runtime.lastPartialSentAt).toBe(0);
  });

  it("forwards the next utterance's first partial immediately after a final (no cross-utterance throttle)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    // 1) A partial forwards and stamps the throttle clock.
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "hello",
        words: [{ content: "hello", speaker: "S1", start: 1.0, end: 1.3 }],
      }),
      ctx
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].isFinal).toBe(false);

    // 2) A final settles the utterance — this must reset the throttle timestamp to 0.
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "hello world",
        words: [
          { content: "hello", speaker: "S1", start: 1.0, end: 1.3 },
          { content: "world", speaker: "S1", start: 1.3, end: 1.7 },
        ],
      }),
      ctx
    );
    expect(calls).toHaveLength(1); // final buffers, does not broadcast

    // 3) The next segment's first partial arrives well inside the 100ms throttle window
    //    (fake time never advanced). It must still forward — the final's reset makes it
    //    look like "never sent" so the throttle is skipped. Since the final above is still
    //    sitting in the endpointing buffer (same UI-level utterance), the partial carries
    //    the buffered prefix so the live line stays cumulative.
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "next",
        words: [{ content: "next", speaker: "S1", start: 2.0, end: 2.3 }],
      }),
      ctx
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].isFinal).toBe(false);
    expect(calls[1].text).toBe("hello world next");
  });

  it("prepends the buffered sentence prefix to the next segment's partial (same speaker)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    // Segment 1 final — buffered by endpointing, NOT broadcast (no sentence-final punct).
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "so I studied at Imperial",
        words: [
          { content: "so", speaker: "S1", start: 1.0, end: 1.2 },
          { content: "Imperial", speaker: "S1", start: 2.0, end: 2.4 },
        ],
      }),
      ctx
    );
    expect(calls).toHaveLength(0);

    // Segment 2 partial restarts from empty on the Speechmatics side — the forwarded
    // frame must still carry the buffered prefix so the Desktop typewriter appends
    // instead of wiping the already-shown words.
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "College",
        words: [{ content: "College", speaker: "S1", start: 2.5, end: 2.9 }],
      }),
      ctx
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].isFinal).toBe(false);
    expect(calls[0].text).toBe("so I studied at Imperial College");
  });

  it("does not prepend the buffer across a speaker change", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "my question is",
        words: [{ content: "question", speaker: "S1", start: 1.0, end: 1.4 }],
      }),
      ctx
    );

    // A different speaker starts talking — their partial must NOT inherit S1's buffer
    // (the buffer flushes on the next final's speaker-change hard boundary).
    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "well I think",
        words: [{ content: "well", speaker: "S2", start: 2.0, end: 2.3 }],
      }),
      ctx
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].speaker).toBe("S2");
    expect(calls[0].text).toBe("well I think");
  });

  it("joins a CJK buffered prefix without a phantom space", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    const { ctx, calls } = makeCtx({ runtimes: { students: runtime } });

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: false,
        text: "我本科在帝国理工",
        words: [{ content: "我本科在帝国理工", speaker: "S1", start: 1.0, end: 2.0 }],
      }),
      ctx
    );

    await handleSpeechmaticsMessage(
      "sess",
      "students",
      transcriptFrame({
        partial: true,
        text: "读的计算机",
        words: [{ content: "读的计算机", speaker: "S1", start: 2.2, end: 2.8 }],
      }),
      ctx
    );
    expect(calls).toHaveLength(1);
    // CJK-aware join: no space injected between the buffered prefix and the new segment.
    expect(calls[0].text).toBe("我本科在帝国理工读的计算机");
  });
});
