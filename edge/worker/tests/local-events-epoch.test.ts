import { describe, it, expect } from "vitest";
import { analyzeEventsLocally } from "../src/local_events_analyzer";
import { isEpochLikeTimestamp } from "../src/finalize_v2";

// A raw wall-clock epoch (ms) — desktop writes this as memo.created_at_ms via
// Date.now(). ~1.75e12 ms in mid-2025. When wrongly used as a session-relative
// offset it produces astronomical event timestamps (e.g. "29714713:08").
const EPOCH_MS = 1_751_000_000_000;

describe("analyzeEventsLocally: memo → event epoch sanity", () => {
  it("does NOT surface memo.created_at_ms epoch as event time when the memo has no anchor", () => {
    const events = analyzeEventsLocally({
      sessionId: "s1",
      transcript: [],
      stats: [],
      memos: [
        {
          memo_id: "m1",
          created_at_ms: EPOCH_MS, // raw epoch, no session-relative anchor
          type: "observation",
          text: "候选人反应偏慢 marker_no_anchor",
        },
      ],
    });
    const ev = events.find((e) => (e.quote ?? "").includes("marker_no_anchor"));
    expect(ev).toBeDefined();
    // The event start/end must NOT be the raw epoch — sanitized to 0.
    expect(ev!.time_range_ms).toEqual([0, 0]);
    expect(isEpochLikeTimestamp(ev!.time_range_ms[0])).toBe(false);
    expect(isEpochLikeTimestamp(ev!.time_range_ms[1])).toBe(false);
  });

  it("keeps a legitimate session-relative anchor range untouched (no false positive)", () => {
    const events = analyzeEventsLocally({
      sessionId: "s1",
      transcript: [],
      stats: [],
      memos: [
        {
          memo_id: "m2",
          created_at_ms: EPOCH_MS,
          type: "decision",
          text: "决定进入下一轮 marker_with_anchor",
          anchors: { mode: "time", time_range_ms: [12_000, 15_000] },
        },
      ],
    });
    const ev = events.find((e) => (e.quote ?? "").includes("marker_with_anchor"));
    expect(ev).toBeDefined();
    expect(ev!.time_range_ms).toEqual([12_000, 15_000]);
  });

  it("sanitizes an epoch-scale anchor range too (defensive)", () => {
    const events = analyzeEventsLocally({
      sessionId: "s1",
      transcript: [],
      stats: [],
      memos: [
        {
          memo_id: "m3",
          created_at_ms: EPOCH_MS,
          type: "observation",
          text: "笔记内容 marker_bad_anchor",
          // A corrupt anchor that itself carries epoch-scale values.
          anchors: { mode: "time", time_range_ms: [EPOCH_MS, EPOCH_MS] },
        },
      ],
    });
    const ev = events.find((e) => (e.quote ?? "").includes("marker_bad_anchor"));
    expect(ev).toBeDefined();
    expect(ev!.time_range_ms).toEqual([0, 0]);
  });

  it("never emits an epoch-scale time_range on ANY produced event", () => {
    const events = analyzeEventsLocally({
      sessionId: "s1",
      transcript: [],
      stats: [],
      memos: [
        { memo_id: "m1", created_at_ms: EPOCH_MS, type: "observation", text: "note one" },
        { memo_id: "m2", created_at_ms: EPOCH_MS + 5_000, type: "decision", text: "decision two" },
      ],
    });
    for (const ev of events) {
      expect(isEpochLikeTimestamp(ev.time_range_ms[0])).toBe(false);
      expect(isEpochLikeTimestamp(ev.time_range_ms[1])).toBe(false);
    }
  });
});
