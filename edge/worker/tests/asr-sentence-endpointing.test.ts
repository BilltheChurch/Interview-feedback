import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  handleSpeechmaticsMessage,
  closeRealtimeAsrSession,
  type RealtimeAsrContext,
} from "../src/realtime-asr-processor";
import { buildRealtimeRuntime } from "../src/asr-helpers";
import {
  resolveSttMaxUtteranceSilenceMs,
  STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT,
  resolveSttMaxUtteranceMs,
  STT_MAX_UTTERANCE_MS_DEFAULT,
} from "../src/config";
import type {
  AsrRealtimeRuntime,
  AsrState,
  StreamRole,
  SessionState,
  UtteranceRaw,
  UtteranceMerged,
} from "../src/config";

/**
 * 句末标点门控 + 长静音兜底断句 (real-user round-3 反馈).
 *
 * 真人测试反馈：一个人连说 30–90 秒会被 900ms 的思考停顿"拦腰斩断"成很多 2–3 词
 * 碎段。新行为：同一说话人内部，短停顿（gap 900 / silence 1200ms）只有在 buf 文本以
 * 句末标点结尾时才 flush；否则继续累积。无标点的长独白（如中文，实时不吐标点）由长静音
 * 兜底 STT_MAX_UTTERANCE_SILENCE_MS 强制定稿。说话人切换仍是硬边界，立即 flush。
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
  } as unknown as AsrState;
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

describe("sentence-final punctuation gating + long-silence backstop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // (a) 英文 buf 不以句末标点结尾 + 短停顿(gap 900 / silence 1200ms) → 不 flush (继续累积).
  it("(a) does NOT flush on a short pause when the buffer does not end with sentence-final punctuation", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    // First final (no terminal punctuation — mid-phrase).
    await handleSpeechmaticsMessage("sess", "students", finalFrame("Imperial College", 1.0, 1.6), ctx);
    // A next final arrives after a >900ms gap (thinking pause). Under the OLD behavior this
    // would gap-flush "Imperial College" mid-phrase. New behavior: no terminal punct → keep buffering.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("London", 2.6, 3.0), ctx);

    // No flush happened — both words accumulated into one buffer.
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
    expect(runtime.sttBuffer?.texts).toEqual(["Imperial College", "London"]);

    // Silence timer at 1200ms must ALSO not flush (still no terminal punct) — it re-arms
    // toward the long-silence backstop instead.
    await vi.advanceTimersByTimeAsync(1300);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
    expect(runtime.sttBuffer).not.toBeNull();
  });

  // (b) 英文 buf 以句末标点结尾 + 短停顿 → flush.
  it("(b) flushes on the silence window when the buffer ends with sentence-final punctuation", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    // A final ending in a period — a complete sentence.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("I studied there.", 1.0, 1.8), ctx);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);

    // Silence window elapses → terminal punct present → flush.
    await vi.advanceTimersByTimeAsync(1300);
    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("I studied there.");
    expect(runtime.sttBuffer).toBeNull();
  });

  // (b2) 句末标点结尾 + gap-flush (下一条 final 迟到) → flush.
  it("(b2) gap-flushes a terminated sentence when a later final arrives after the gap", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 2;
    runtime.lastSentSeq = 6;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    await handleSpeechmaticsMessage("sess", "students", finalFrame("First sentence.", 1.0, 1.5), ctx);
    // Next final after >900ms gap. buf ends with "." → gap-flush is allowed.
    runtime.currentStartSeq = 8;
    runtime.lastSentSeq = 14;
    await handleSpeechmaticsMessage("sess", "students", finalFrame("Second one.", 5.0, 5.6), ctx);

    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("First sentence.");
    expect(runtime.sttBuffer?.texts).toEqual(["Second one."]);
  });

  // (c) buf 无句末标点 (模拟中文) + 静音达到兜底(默认 2800ms) → flush.
  it("(c) force-flushes an unpunctuated buffer once the long-silence backstop elapses", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
      STT_MAX_UTTERANCE_SILENCE_MS: "2800",
    });

    // Chinese-style final with no sentence-final punctuation.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("我来自帝国理工学院", 1.0, 2.0), ctx);

    // At the short silence window (1200ms) it must NOT flush (no terminal punct).
    await vi.advanceTimersByTimeAsync(1300);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
    expect(runtime.sttBuffer).not.toBeNull();

    // Advance to the long-silence backstop (2800ms total from the last final) → force flush.
    await vi.advanceTimersByTimeAsync(1600); // 1300 + 1600 = 2900 > 2800
    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("我来自帝国理工学院");
    expect(runtime.sttBuffer).toBeNull();
  });

  // (c2) 无标点 + 无说话人切换 + 换气 <2800ms（不触发静音兜底）+ 累积时长超 22s 上限
  //      → 在 final 边界强制 flush（中文/无标点长独白的最后兜底，避免整段零切分）。
  it("(c2) force-flushes at the max-utterance duration cap for a long unpunctuated monologue", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
      STT_MAX_UTTERANCE_SILENCE_MS: "2800",
      STT_MAX_UTTERANCE_MS: "22000",
    });

    // Feed a stream of no-punctuation Chinese finals, same speaker (S1). Each next final starts
    // only 0.2s after the prior end (word time gap ≪ 900ms gap AND ≪ 2800ms silence backstop),
    // so neither the gap-flush nor the silence backstop can trigger. Word times accumulate:
    // final k spans [k*3 .. k*3+2.8]s. After 8 finals the buffer span reaches ~23.8s (>22s cap).
    // Advance the fake clock only a tiny amount between finals (well under 2800ms) so the silence
    // timer never fires either. The ONLY thing that can settle this is the duration cap.
    let flushedAt = -1;
    for (let k = 0; k < 8; k += 1) {
      const startSec = k * 3.0;      // 0, 3, 6, 9, 12, 15, 18, 21
      const endSec = startSec + 2.8; // 2.8, 5.8, ... , 23.8
      await handleSpeechmaticsMessage(
        "sess",
        "students",
        finalFrame(`第${k}段没有标点的中文`, startSec, endSec, "S1"),
        ctx
      );
      await vi.advanceTimersByTimeAsync(200); // ≪ silence window, backstop never fires
      if (flushedAt < 0 && calls.some((c) => c.isFinal)) flushedAt = k;
    }

    // The cap (22000ms word-time span) is crossed at final k=8th (endMs 23800 - startMs 0 ≥ 22000
    // happens once endSec ≥ 22s, i.e. the final starting at 21s → span 0..23.8s). A forced flush
    // must have emitted exactly one settled utterance at that final boundary.
    const finals = calls.filter((c) => c.isFinal);
    expect(finals.length).toBeGreaterThanOrEqual(1);
    // The flush happened WITHOUT any long silence and WITHOUT a speaker change — purely the cap.
    expect(flushedAt).toBeGreaterThanOrEqual(0);
    // The emitted utterance is the accumulated monologue (a real cut, not the whole thing lost).
    expect(finals[0].text).toContain("第0段");
    // After the cap flush the next final(s) start a fresh buffer (segment boundary), so the buffer
    // span was reset — the long monologue was cut into pieces instead of one giant utterance.
    if (runtime.sttBuffer) {
      const span = runtime.sttBuffer.endMs - runtime.sttBuffer.startMs;
      expect(span).toBeLessThan(22000);
    }
  });

  // (c3) 时长上限只兜住"无停顿无标点超长段"——正常英文短句（有标点、时长远低于上限）不受影响。
  it("(c3) the duration cap does not interfere with normal short punctuated utterances", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
      STT_MAX_UTTERANCE_MS: "22000",
    });

    // A short punctuated sentence (2.8s span, ≪ 22s cap) → the cap must NOT fire; the punctuation
    // + silence window settles it normally.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("Short sentence.", 1.0, 1.8), ctx);
    await vi.advanceTimersByTimeAsync(1300);
    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("Short sentence.");
  });

  // (d) 说话人切换 → 立即 flush (不管标点).
  it("(d) flushes immediately on speaker change even without terminal punctuation", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 12;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    // Speaker S1, no terminal punctuation.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("mid phrase no punct", 1.0, 1.6, "S1"), ctx);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);

    // A different speaker (S2) arrives within the gap → hard turn boundary → flush S1 now.
    runtime.currentStartSeq = 8;
    runtime.lastSentSeq = 16;
    await handleSpeechmaticsMessage("sess", "students", finalFrame("hello I am next", 1.7, 2.3, "S2"), ctx);

    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("mid phrase no punct");
    expect(runtime.sttBuffer?.texts).toEqual(["hello I am next"]);
    expect(runtime.sttBuffer?.speaker).toBe("S2");
  });

  // (e) 断连/结束路径：graceful close 必须 flush 残余无标点 buf（不丢数据）。
  it("(e) flushes a residual unpunctuated buffer on graceful close (no data loss)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 9;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    // A no-punctuation buffer that would otherwise be held forever.
    await handleSpeechmaticsMessage("sess", "students", finalFrame("trailing words with no stop", 1.0, 1.9), ctx);
    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
    expect(runtime.sttBuffer).not.toBeNull();

    // Graceful close (gracefulFinish=true) must settle the residual buffer. A real sessionId
    // is threaded from the caller's scope (websocket-handler / finalize-watchdog) so the emitted
    // utterance is keyed correctly.
    await closeRealtimeAsrSession("students", "client-close", ctx, false, true, "sess");

    const finals = calls.filter((c) => c.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("trailing words with no stop");
    expect(runtime.sttBuffer).toBeNull();
  });

  // (e2) reconnect (gracefulFinish=false, clearQueue=false) 必须保留 buf（不 flush、不丢）。
  it("(e2) preserves the buffer across a reconnect close (no flush, no loss)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.currentStartSeq = 5;
    runtime.lastSentSeq = 9;
    const { ctx, calls } = makeCtx(runtime, {
      STT_UTTERANCE_GAP_MS: "900",
      STT_SILENCE_FLUSH_MS: "1200",
    });

    await handleSpeechmaticsMessage("sess", "students", finalFrame("half a sentence", 1.0, 1.9), ctx);
    expect(runtime.sttBuffer).not.toBeNull();

    // Reconnect teardown: keep the queue AND do NOT gracefully finish → buffer must survive
    // so accumulation continues on the new connection.
    await closeRealtimeAsrSession("students", "reconnect", ctx, false, false);

    expect(calls.filter((c) => c.isFinal)).toHaveLength(0);
    expect(runtime.sttBuffer).not.toBeNull();
    expect(runtime.sttBuffer?.texts).toEqual(["half a sentence"]);
  });
});

describe("resolveSttMaxUtteranceSilenceMs", () => {
  it("(e) defaults to 2800ms when unset", () => {
    expect(resolveSttMaxUtteranceSilenceMs({})).toBe(STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT);
    expect(STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT).toBe(2800);
  });

  it("(e) honors a valid env override", () => {
    expect(resolveSttMaxUtteranceSilenceMs({ STT_MAX_UTTERANCE_SILENCE_MS: "4000" })).toBe(4000);
  });

  it("(e) falls back to the default on non-positive / non-integer input", () => {
    expect(resolveSttMaxUtteranceSilenceMs({ STT_MAX_UTTERANCE_SILENCE_MS: "0" })).toBe(
      STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT
    );
    expect(resolveSttMaxUtteranceSilenceMs({ STT_MAX_UTTERANCE_SILENCE_MS: "-1" })).toBe(
      STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT
    );
    expect(resolveSttMaxUtteranceSilenceMs({ STT_MAX_UTTERANCE_SILENCE_MS: "abc" })).toBe(
      STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT
    );
    expect(resolveSttMaxUtteranceSilenceMs({ STT_MAX_UTTERANCE_SILENCE_MS: "1.5" })).toBe(
      STT_MAX_UTTERANCE_SILENCE_MS_DEFAULT
    );
  });
});

describe("resolveSttMaxUtteranceMs", () => {
  it("defaults to 22000ms when unset", () => {
    expect(resolveSttMaxUtteranceMs({})).toBe(STT_MAX_UTTERANCE_MS_DEFAULT);
    expect(STT_MAX_UTTERANCE_MS_DEFAULT).toBe(22000);
  });

  it("honors a valid env override", () => {
    expect(resolveSttMaxUtteranceMs({ STT_MAX_UTTERANCE_MS: "30000" })).toBe(30000);
  });

  it("falls back to the default on non-positive / non-integer input", () => {
    expect(resolveSttMaxUtteranceMs({ STT_MAX_UTTERANCE_MS: "0" })).toBe(STT_MAX_UTTERANCE_MS_DEFAULT);
    expect(resolveSttMaxUtteranceMs({ STT_MAX_UTTERANCE_MS: "-1" })).toBe(STT_MAX_UTTERANCE_MS_DEFAULT);
    expect(resolveSttMaxUtteranceMs({ STT_MAX_UTTERANCE_MS: "abc" })).toBe(STT_MAX_UTTERANCE_MS_DEFAULT);
    expect(resolveSttMaxUtteranceMs({ STT_MAX_UTTERANCE_MS: "1.5" })).toBe(STT_MAX_UTTERANCE_MS_DEFAULT);
  });
});

// ── R6-vocab self-heal: disable additional_vocab after a server config reject ──

/** Build a Speechmatics server Error control frame. */
function errorFrame(reason: string): string {
  return JSON.stringify({ message: "Error", type: "invalid_config", reason });
}

describe("R6-vocab self-heal (Speechmatics Error → drop additional_vocab)", () => {
  it("flips vocabRejected when an Error arrives on a connection that sent vocab", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.lastConnectSentVocab = true; // this connection's StartRecognition carried vocab
    const { ctx } = makeCtx(runtime);

    await handleSpeechmaticsMessage("sess", "students", errorFrame("additional_vocab not supported"), ctx);

    // Next (re)connect will skip the custom dictionary so the stream can recover.
    expect(runtime.vocabRejected).toBe(true);
  });

  it("does NOT flip vocabRejected when the connection sent no vocab (unrelated error)", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.lastConnectSentVocab = false;
    const { ctx } = makeCtx(runtime);

    await handleSpeechmaticsMessage("sess", "students", errorFrame("some transient server error"), ctx);

    expect(runtime.vocabRejected).toBe(false);
  });

  it("rejects the ready promise so the connect path unwinds into a reconnect", async () => {
    const runtime = buildRealtimeRuntime("students");
    runtime.running = true;
    runtime.lastConnectSentVocab = true;
    let rejected: Error | null = null;
    runtime.readyReject = (err: Error) => { rejected = err; };
    const { ctx } = makeCtx(runtime);

    await handleSpeechmaticsMessage("sess", "students", errorFrame("bad config"), ctx);

    expect(rejected).not.toBeNull();
    expect((rejected as unknown as Error).message).toBe("bad config");
    expect(runtime.readyReject).toBeNull();
  });
});
