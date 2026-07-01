import { describe, it, expect } from "vitest";
import { cleanUtteranceText, cleanTranscript, type RawTranscriptItem } from "../src/transcript-cleaner";

describe("cleanUtteranceText (deterministic, no LLM)", () => {
  it("removes leading English fillers", () => {
    // Note: a deterministic sentence-final period is appended when missing (see below).
    expect(cleanUtteranceText("um, I think the answer is yes")).toBe("I think the answer is yes.");
    expect(cleanUtteranceText("uh so basically it works")).toBe("so basically it works.");
    expect(cleanUtteranceText("Hmm, let me consider that")).toBe("let me consider that.");
  });

  it("removes mid-sentence fillers and collapses whitespace", () => {
    expect(cleanUtteranceText("I uh really um think so")).toBe("I really think so.");
  });

  it("does NOT butcher meaning-bearing words containing filler substrings", () => {
    // "summer", "her", "error", "very", "yeah", "ahead", "like", "you know" must survive
    expect(cleanUtteranceText("her summer was full of errors, very ahead")).toBe(
      "her summer was full of errors, very ahead."
    );
    expect(cleanUtteranceText("I like it, you know")).toBe("I like it, you know.");
  });

  it("removes Chinese filler characters and strips the stray leading comma", () => {
    expect(cleanUtteranceText("嗯，我觉得呃可以的")).toBe("我觉得可以的。");
  });

  it("normalizes spacing before punctuation", () => {
    expect(cleanUtteranceText("hello , world .")).toBe("hello, world.");
  });

  it("returns empty string for pure-filler utterances", () => {
    expect(cleanUtteranceText("um uh hmm")).toBe("");
    expect(cleanUtteranceText("嗯 呃")).toBe("");
  });

  it("handles empty input", () => {
    expect(cleanUtteranceText("")).toBe("");
  });
});

describe("cleanUtteranceText — deterministic sentence-final punctuation", () => {
  // Speechmatics cmn_en emits no Chinese sentence-final punctuation on the output side,
  // so a deterministic one-punctuation-per-utterance pass restores readability. Each
  // utterance is one pause = one sentence.
  it("appends a Chinese period when a CJK utterance has no sentence-final punctuation", () => {
    expect(cleanUtteranceText("新购的形式可以看得到")).toBe("新购的形式可以看得到。");
  });

  it("appends an English period when a Latin utterance has no sentence-final punctuation", () => {
    expect(cleanUtteranceText("We will be")).toBe("We will be.");
  });

  it("does NOT double-punctuate when the utterance already ends in punctuation", () => {
    expect(cleanUtteranceText("Hello?")).toBe("Hello?");
    expect(cleanUtteranceText("你好。")).toBe("你好。");
    expect(cleanUtteranceText("对！")).toBe("对！");
    expect(cleanUtteranceText("Right, exactly.")).toBe("Right, exactly.");
    expect(cleanUtteranceText("那是什么？")).toBe("那是什么？");
  });

  it("does not append to empty or pure-whitespace input", () => {
    expect(cleanUtteranceText("")).toBe("");
    expect(cleanUtteranceText("   ")).toBe("");
  });

  it("does not append to pure-filler input (still empty after cleaning)", () => {
    expect(cleanUtteranceText("um uh hmm")).toBe("");
    expect(cleanUtteranceText("嗯 呃")).toBe("");
  });

  it("uses a Chinese question mark for interrogative sentence-final particles", () => {
    expect(cleanUtteranceText("新购的形式可以看得到吗")).toBe("新购的形式可以看得到吗？");
    expect(cleanUtteranceText("你觉得呢")).toBe("你觉得呢？");
    // `吧` is a suggestion/statement particle, not interrogative → default period.
    expect(cleanUtteranceText("我们开始吧")).toBe("我们开始吧。");
  });
});

describe("cleanTranscript", () => {
  const items: RawTranscriptItem[] = [
    { utterance_id: "u1", stream_role: "teacher", speaker_name: "Interviewer", text: "um, welcome everyone", start_ms: 0, end_ms: 2000 },
    { utterance_id: "u2", stream_role: "students", speaker_name: null, text: "uh hmm", start_ms: 2000, end_ms: 3000 },
    { utterance_id: "u3", stream_role: "students", speaker_name: "S1", text: "I think the design is solid", start_ms: 3000, end_ms: 6000 },
  ];

  it("cleans text, preserves metadata, and drops pure-filler utterances", () => {
    const cleaned = cleanTranscript(items);
    expect(cleaned).toHaveLength(2); // u2 (pure filler) dropped
    expect(cleaned[0]).toEqual({
      utterance_id: "u1",
      stream_role: "teacher",
      speaker_name: "Interviewer",
      text: "welcome everyone.",
      start_ms: 0,
      end_ms: 2000,
    });
    expect(cleaned[1].utterance_id).toBe("u3");
    expect(cleaned[1].speaker_name).toBe("S1");
    expect(cleaned[1].text).toBe("I think the design is solid.");
  });

  it("normalizes missing speaker_name to null", () => {
    const cleaned = cleanTranscript([
      { utterance_id: "x", stream_role: "students", text: "real content here", start_ms: 0, end_ms: 1000 },
    ]);
    expect(cleaned[0].speaker_name).toBeNull();
  });
});
