import { describe, it, expect } from "vitest";
import { buildTranscriptFrame } from "../src/asr-helpers";

/**
 * A2 transcript downlink — wire contract.
 *
 * The Worker pushes these frames over the ingest WS and the Desktop
 * WebSocketService parses them into TranscriptSegment store entries. These tests
 * pin the exact field names both repos depend on; changing them is a breaking change.
 */
describe("buildTranscriptFrame (A2 downlink contract)", () => {
  it("produces the exact wire contract the Desktop expects", () => {
    const frame = buildTranscriptFrame("students", "S1", "hello world", true, 1000, 2000);
    expect(frame).toEqual({
      type: "transcript",
      role: "students",
      speaker: "S1",
      text: "hello world",
      is_final: true,
      ts_ms: 2000,
      start_ms: 1000,
      words: [],
    });
  });

  it("maps end position to ts_ms and start position to start_ms", () => {
    const frame = buildTranscriptFrame("teacher", null, "ok", false, 5000, 8000);
    expect(frame.ts_ms).toBe(8000);
    expect(frame.start_ms).toBe(5000);
    expect(frame.is_final).toBe(false);
    expect(frame.speaker).toBeNull();
    expect(frame.role).toBe("teacher");
  });

  it("passes through word-level detail when provided", () => {
    const words = [
      { text: "hi", start_ms: 0, end_ms: 500 },
      { text: "there", start_ms: 500, end_ms: 1000, speaker: "S2" },
    ];
    const frame = buildTranscriptFrame("students", "S2", "hi there", true, 0, 1000, words);
    expect(frame.words).toEqual(words);
  });

  it("defaults words to an empty array", () => {
    const frame = buildTranscriptFrame("teacher", "Interviewer", "next question", true, 0, 1500);
    expect(frame.words).toEqual([]);
  });
});
