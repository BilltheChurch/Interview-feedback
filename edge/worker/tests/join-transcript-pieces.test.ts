import { describe, it, expect } from "vitest";
import { joinTranscriptPieces } from "../src/config";

// R-H: Speechmatics emits word-level finals. The endpointing layer accumulates several
// finals into one utterance. Joining them with a plain ASCII space corrupts Chinese
// (CJK has no inter-word spaces), producing "你好 世界" and hiding sentence structure.
// joinTranscriptPieces chooses the separator per boundary: empty string across a CJK
// boundary (either side CJK, or a CJK-adjacent punctuation), a single space between
// Latin words.

describe("joinTranscriptPieces", () => {
  it("joins two CJK pieces with no space", () => {
    expect(joinTranscriptPieces(["你好", "世界"])).toBe("你好世界");
  });

  it("joins Latin words with a single space", () => {
    expect(joinTranscriptPieces(["hello", "world"])).toBe("hello world");
  });

  it("uses no space at a CJK→Latin boundary (Chinese side governs)", () => {
    expect(joinTranscriptPieces(["中文", "english"])).toBe("中文english");
  });

  it("uses no space at a Latin→CJK boundary (Chinese side governs)", () => {
    expect(joinTranscriptPieces(["ok", "好的"])).toBe("ok好的");
  });

  it("attaches CJK (full-width) punctuation without a space", () => {
    expect(joinTranscriptPieces(["你好", "。"])).toBe("你好。");
    expect(joinTranscriptPieces(["你好", "，", "世界"])).toBe("你好，世界");
  });

  it("attaches ASCII punctuation without a leading space", () => {
    expect(joinTranscriptPieces(["hello", ",", "world"])).toBe("hello, world");
    expect(joinTranscriptPieces(["hello", "."])).toBe("hello.");
  });

  it("keeps a real English sentence readable across many pieces", () => {
    expect(joinTranscriptPieces(["History", "and", "belonging", "."])).toBe(
      "History and belonging."
    );
  });

  it("keeps a real Chinese sentence contiguous across many pieces", () => {
    expect(joinTranscriptPieces(["我", "叫", "小明", "，", "很", "高兴", "认识", "你", "。"])).toBe(
      "我叫小明，很高兴认识你。"
    );
  });

  it("handles a code-switched cmn_en utterance", () => {
    // "yesterday 星期一 today is tuesday 明天是星期三"
    expect(
      joinTranscriptPieces(["yesterday", "星期一", "today", "is", "tuesday", "明天是星期三"])
    ).toBe("yesterday星期一today is tuesday明天是星期三");
  });

  it("ignores empty / whitespace-only pieces", () => {
    expect(joinTranscriptPieces(["你好", "", "  ", "世界"])).toBe("你好世界");
    expect(joinTranscriptPieces([])).toBe("");
    expect(joinTranscriptPieces(["   "])).toBe("");
  });

  it("collapses internal whitespace inside a Latin piece", () => {
    expect(joinTranscriptPieces(["hello   there", "world"])).toBe("hello there world");
  });
});
