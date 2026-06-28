import { describe, it, expect } from "vitest";
import {
  buildStartRecognition,
  buildEndOfStream,
  parseSpeechmaticsMessage,
  DEFAULT_SPEECHMATICS_CONFIG,
} from "../src/speechmatics-asr";

describe("buildStartRecognition", () => {
  it("includes diarization=speaker when diarization is enabled", () => {
    const msg = buildStartRecognition({ ...DEFAULT_SPEECHMATICS_CONFIG, language: "cmn_en", diarization: true });
    expect(msg).toEqual({
      message: "StartRecognition",
      audio_format: { type: "raw", encoding: "pcm_s16le", sample_rate: 16000 },
      transcription_config: { language: "cmn_en", enable_partials: true, max_delay: 2.0, diarization: "speaker" },
    });
  });

  it("omits diarization for the teacher channel (single speaker, §9.3.4)", () => {
    const msg = buildStartRecognition({ ...DEFAULT_SPEECHMATICS_CONFIG, language: "en", diarization: false });
    const tc = (msg.transcription_config as Record<string, unknown>);
    expect(tc.diarization).toBeUndefined();
    expect(tc.language).toBe("en");
  });
});

describe("buildEndOfStream", () => {
  it("carries the last sequence number", () => {
    expect(buildEndOfStream(42)).toEqual({ message: "EndOfStream", last_seq_no: 42 });
  });
});

describe("parseSpeechmaticsMessage", () => {
  it("returns null for invalid JSON", () => {
    expect(parseSpeechmaticsMessage("not json")).toBeNull();
  });

  it("parses RecognitionStarted with language pack", () => {
    const m = parseSpeechmaticsMessage(JSON.stringify({
      message: "RecognitionStarted", id: "sess1",
      language_pack_info: { language_description: "English and Mandarin" },
    }));
    expect(m).toEqual({ type: "RecognitionStarted", id: "sess1", language_pack: { language_description: "English and Mandarin" } });
  });

  it("parses AudioAdded seq_no", () => {
    expect(parseSpeechmaticsMessage(JSON.stringify({ message: "AudioAdded", seq_no: 7 }))).toEqual({ type: "AudioAdded", seq_no: 7 });
  });

  it("parses AddTranscript with per-word speaker labels + timestamps (validated shape)", () => {
    const raw = JSON.stringify({
      message: "AddTranscript",
      metadata: { start_time: 0.07, end_time: 1.51 },
      results: [
        { type: "word", start_time: 0.07, end_time: 0.55, alternatives: [{ content: "History", confidence: 0.95, speaker: "S1" }] },
        { type: "word", start_time: 0.55, end_time: 0.71, alternatives: [{ content: "and", confidence: 0.9, speaker: "S1" }] },
        { type: "word", start_time: 0.71, end_time: 1.51, alternatives: [{ content: "belonging", confidence: 0.88, speaker: "S2" }] },
        { type: "punctuation", start_time: 1.51, end_time: 1.51, alternatives: [{ content: ".", speaker: "S2" }] },
      ],
    });
    const m = parseSpeechmaticsMessage(raw);
    expect(m?.type).toBe("Transcript");
    if (m?.type !== "Transcript") return;
    const t = m.transcript;
    expect(t.is_partial).toBe(false);
    expect(t.text).toBe("History and belonging.");
    expect(t.start_ms).toBe(70);
    expect(t.end_ms).toBe(1510);
    expect(t.speakers.sort()).toEqual(["S1", "S2"]);
    expect(t.words).toHaveLength(4);
    expect(t.words[0]).toEqual({ text: "History", start_ms: 70, end_ms: 550, speaker: "S1", confidence: 0.95, is_punctuation: false });
    expect(t.words[3].is_punctuation).toBe(true);
  });

  it("marks AddPartialTranscript as partial", () => {
    const m = parseSpeechmaticsMessage(JSON.stringify({
      message: "AddPartialTranscript", results: [{ type: "word", start_time: 0, end_time: 0.3, alternatives: [{ content: "hi" }] }],
    }));
    expect(m?.type).toBe("Transcript");
    if (m?.type !== "Transcript") return;
    expect(m.transcript.is_partial).toBe(true);
    expect(m.transcript.text).toBe("hi");
    expect(m.transcript.words[0].speaker).toBeNull();
  });

  it("parses Error and Warning", () => {
    expect(parseSpeechmaticsMessage(JSON.stringify({ message: "Error", type: "quota_exceeded", reason: "no quota" })))
      .toEqual({ type: "Error", code: "quota_exceeded", reason: "no quota", raw: { message: "Error", type: "quota_exceeded", reason: "no quota" } });
    expect(parseSpeechmaticsMessage(JSON.stringify({ message: "Warning", reason: "slow" })))
      .toEqual({ type: "Warning", reason: "slow" });
  });

  it("parses EndOfTranscript and Unknown", () => {
    expect(parseSpeechmaticsMessage(JSON.stringify({ message: "EndOfTranscript" }))).toEqual({ type: "EndOfTranscript" });
    const u = parseSpeechmaticsMessage(JSON.stringify({ message: "SomethingNew", x: 1 }));
    expect(u?.type).toBe("Unknown");
  });
});
