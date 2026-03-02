import { describe, it, expect } from "vitest";
import type { StoredUtterance } from "../src/types_v2";

describe("StoredUtterance dedup", () => {
  it("dedup key prevents duplicates from same increment", () => {
    const dedupKey = (u: { increment_index: number; utterance_id: string }) =>
      `${u.increment_index}:${u.utterance_id}`;

    const existing: StoredUtterance[] = [
      { increment_index: 0, utterance_id: "u1", text: "hi", start_ms: 0, end_ms: 1000, confidence: 0.5, speaker: "spk_00", stream_role: "mixed" },
    ];
    const incoming: StoredUtterance[] = [
      { increment_index: 0, utterance_id: "u1", text: "hi-dup", start_ms: 0, end_ms: 1000, confidence: 0.5, speaker: "spk_00", stream_role: "mixed" },
      { increment_index: 1, utterance_id: "u2", text: "hello", start_ms: 1000, end_ms: 2000, confidence: 0.3, speaker: "spk_01", stream_role: "teacher" },
    ];

    const seen = new Set(existing.map(dedupKey));
    const merged = [...existing];
    for (const u of incoming) {
      if (!seen.has(dedupKey(u))) {
        merged.push(u);
        seen.add(dedupKey(u));
      }
    }

    expect(merged).toHaveLength(2);
    expect(merged[0].text).toBe("hi");
    expect(merged[1].utterance_id).toBe("u2");
  });

  it("trims to MAX_STORED_UTTERANCES keeping latest", () => {
    const MAX = 5;
    const arr: StoredUtterance[] = Array.from({ length: 8 }, (_, i) => ({
      increment_index: i, utterance_id: `u${i}`, text: `t${i}`,
      start_ms: i * 1000, end_ms: (i + 1) * 1000,
      confidence: 0.5, speaker: "spk_00", stream_role: "mixed" as const,
    }));
    const trimmed = arr.length > MAX ? arr.slice(-MAX) : arr;
    expect(trimmed).toHaveLength(5);
    expect(trimmed[0].utterance_id).toBe("u3");
    expect(trimmed[4].utterance_id).toBe("u7");
  });
});
