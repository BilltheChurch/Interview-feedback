import { describe, it, expect } from "vitest";
import {
  buildEvidence,
  buildMultiEvidence,
  sanitizeSessionRelativeMs,
  sanitizeTimeRange,
  isEpochLikeTimestamp,
  type TranscriptItem,
} from "../src/finalize_v2";
import type { MemoItem, MemoSpeakerBinding } from "../src/types_v2";

// A raw wall-clock epoch (ms) — this is what desktop writes as memo.created_at_ms
// via Date.now(). ~1.75e12 ms in mid-2025. When wrongly formatted as a
// session-relative offset it produces the astronomical "29714713:08" timestamp.
const EPOCH_MS = 1_751_000_000_000;

function memo(overrides: Partial<MemoItem> = {}): MemoItem {
  return {
    memo_id: "m1",
    created_at_ms: EPOCH_MS,
    author_role: "teacher",
    type: "observation",
    tags: [],
    text: "而且现在的情况是，我说完一句话之后候选人才反应过来",
    ...overrides,
  };
}

describe("start_ms sanity guard", () => {
  it("flags epoch-scale timestamps as epoch-like", () => {
    expect(isEpochLikeTimestamp(EPOCH_MS)).toBe(true);
    expect(isEpochLikeTimestamp(12_000)).toBe(false); // 12s into session
    expect(isEpochLikeTimestamp(0)).toBe(false);
  });

  it("collapses epoch / negative / non-finite values to 0", () => {
    expect(sanitizeSessionRelativeMs(EPOCH_MS)).toBe(0);
    expect(sanitizeSessionRelativeMs(-5)).toBe(0);
    expect(sanitizeSessionRelativeMs(Number.NaN)).toBe(0);
  });

  it("keeps plausible session-relative timestamps untouched", () => {
    expect(sanitizeSessionRelativeMs(12_000)).toBe(12_000);
    expect(sanitizeTimeRange([1_000, 3_500])).toEqual([1_000, 3_500]);
    expect(sanitizeTimeRange([EPOCH_MS, EPOCH_MS])).toEqual([0, 0]);
  });
});

describe("buildEvidence: memo with no transcript match", () => {
  const transcript: TranscriptItem[] = [
    {
      utterance_id: "u1",
      stream_role: "students",
      cluster_id: "c1",
      speaker_name: "Alice",
      decision: "auto",
      text: "I would design the system using a message queue and workers.",
      start_ms: 5_000,
      end_ms: 9_000,
      duration_ms: 4_000,
    },
  ];

  it("does NOT emit a candidate quote from the note text", () => {
    const noteText = "这是面试官的私人笔记，与转写完全无关的内容 xyzzy";
    const evidence = buildEvidence({
      memos: [memo({ text: noteText })],
      transcript,
    });
    const noteEv = evidence.find((e) => e.quote.includes("xyzzy"));
    expect(noteEv).toBeDefined();
    // Must NOT be a candidate "quote"
    expect(noteEv!.type).toBe("note");
    // Must NOT carry a null-speaker candidate identity
    expect(noteEv!.speaker.display_name).toBeNull();
    expect(noteEv!.speaker.person_id).toBeNull();
    // Must NOT surface the raw epoch as a session timestamp
    expect(noteEv!.time_range_ms).toEqual([0, 0]);
  });

  it("never surfaces an epoch-scale start_ms on any evidence item", () => {
    const evidence = buildEvidence({ memos: [memo()], transcript });
    for (const ev of evidence) {
      expect(isEpochLikeTimestamp(ev.time_range_ms[0])).toBe(false);
      expect(isEpochLikeTimestamp(ev.time_range_ms[1])).toBe(false);
    }
  });
});

describe("buildMultiEvidence: unmatched memo becomes an attributed note", () => {
  // Bob is the only speaker in the transcript; the memo binds to Alice, who has
  // NO utterances → no semantic/speaker match → the note-fallback path fires.
  const transcript: TranscriptItem[] = [
    {
      utterance_id: "u1",
      stream_role: "students",
      cluster_id: "c1",
      speaker_name: "Bob",
      decision: "auto",
      text: "Completely unrelated answer about databases and indexing.",
      start_ms: 4_000,
      end_ms: 8_000,
      duration_ms: 4_000,
    },
  ];

  const bindings: MemoSpeakerBinding[] = [
    { memo_id: "m1", extracted_names: ["Alice"], matched_speaker_keys: ["Alice"], confidence: 0.9 },
  ];

  it("emits a note-type evidence bound to the memo target person, not null/unknown", () => {
    const noteText = "面试官笔记：候选人反应偏慢 marker_qwerty";
    const evidence = buildMultiEvidence({
      memos: [memo({ text: noteText })],
      transcript,
      bindings,
    });
    const noteEv = evidence.find((e) => e.quote.includes("marker_qwerty"));
    expect(noteEv).toBeDefined();
    expect(noteEv!.type).toBe("note");
    // Bound to Alice (single resolved speaker), never a null/unknown candidate line
    expect(noteEv!.speaker.display_name).toBe("Alice");
    // No epoch timestamp
    expect(noteEv!.time_range_ms).toEqual([0, 0]);
  });

  it("leaves the note unattributed when the memo binds to no speaker", () => {
    const evidence = buildMultiEvidence({
      memos: [memo({ text: "无归属笔记 marker_zzz" })],
      transcript,
      bindings: [], // no binding resolved
    });
    const noteEv = evidence.find((e) => e.quote.includes("marker_zzz"));
    expect(noteEv).toBeDefined();
    expect(noteEv!.type).toBe("note");
    expect(noteEv!.speaker.display_name).toBeNull();
    expect(noteEv!.time_range_ms).toEqual([0, 0]);
  });
});
