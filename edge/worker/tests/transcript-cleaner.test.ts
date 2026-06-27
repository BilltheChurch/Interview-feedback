import { describe, it, expect } from "vitest";
import { cleanUtteranceText, cleanTranscript, type RawTranscriptItem } from "../src/transcript-cleaner";

describe("cleanUtteranceText (deterministic, no LLM)", () => {
  it("removes leading English fillers", () => {
    expect(cleanUtteranceText("um, I think the answer is yes")).toBe("I think the answer is yes");
    expect(cleanUtteranceText("uh so basically it works")).toBe("so basically it works");
    expect(cleanUtteranceText("Hmm, let me consider that")).toBe("let me consider that");
  });

  it("removes mid-sentence fillers and collapses whitespace", () => {
    expect(cleanUtteranceText("I uh really um think so")).toBe("I really think so");
  });

  it("does NOT butcher meaning-bearing words containing filler substrings", () => {
    // "summer", "her", "error", "very", "yeah", "ahead", "like", "you know" must survive
    expect(cleanUtteranceText("her summer was full of errors, very ahead")).toBe(
      "her summer was full of errors, very ahead"
    );
    expect(cleanUtteranceText("I like it, you know")).toBe("I like it, you know");
  });

  it("removes Chinese filler characters and strips the stray leading comma", () => {
    expect(cleanUtteranceText("嗯，我觉得呃可以的")).toBe("我觉得可以的");
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
      text: "welcome everyone",
      start_ms: 0,
      end_ms: 2000,
    });
    expect(cleaned[1].utterance_id).toBe("u3");
    expect(cleaned[1].speaker_name).toBe("S1");
    expect(cleaned[1].text).toBe("I think the design is solid");
  });

  it("normalizes missing speaker_name to null", () => {
    const cleaned = cleanTranscript([
      { utterance_id: "x", stream_role: "students", text: "real content here", start_ms: 0, end_ms: 1000 },
    ]);
    expect(cleaned[0].speaker_name).toBeNull();
  });
});
