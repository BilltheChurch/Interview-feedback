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
      transcription_config: {
        language: "cmn_en",
        enable_partials: true,
        max_delay: 1.0,
        operating_point: "enhanced",
        diarization: "speaker",
      },
    });
  });

  it("omits diarization for the teacher channel (single speaker, §9.3.4)", () => {
    const msg = buildStartRecognition({ ...DEFAULT_SPEECHMATICS_CONFIG, language: "en", diarization: false });
    const tc = (msg.transcription_config as Record<string, unknown>);
    expect(tc.diarization).toBeUndefined();
    expect(tc.language).toBe("en");
  });

  // R5: operating_point drives Speechmatics accuracy — enhanced is materially more
  // accurate than the server-side default (standard), especially for accented /
  // code-switched cmn_en interview speech.
  it("R5: defaults operating_point to enhanced", () => {
    const msg = buildStartRecognition({ ...DEFAULT_SPEECHMATICS_CONFIG, language: "cmn_en", diarization: true });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.operating_point).toBe("enhanced");
  });

  it("R5: honours an explicit standard operating_point override", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: false,
      operatingPoint: "standard",
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.operating_point).toBe("standard");
  });

  it("omits operating_point when explicitly unset", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "en",
      diarization: false,
      operatingPoint: undefined,
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect("operating_point" in tc).toBe(false);
  });

  // R6: max_delay is the final-transcript latency budget. Lower default (1.0s) trims
  // ~1s of lag versus the previous 2.0s.
  it("R6: defaults max_delay to 1.0", () => {
    const msg = buildStartRecognition({ ...DEFAULT_SPEECHMATICS_CONFIG, language: "cmn_en", diarization: true });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.max_delay).toBe(1.0);
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

// ── R6-vocab: additional_vocab (custom dictionary) ───────────────────────────

describe("buildStartRecognition — additional_vocab (R6-vocab)", () => {
  it("includes additional_vocab when a non-empty list is provided", () => {
    const vocab = [
      { content: "Imperial College London" },
      { content: "UCAS", sounds_like: ["you cass"] },
    ];
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: false,
      additionalVocab: vocab,
    });
    const tc = (msg as { transcription_config: Record<string, unknown> }).transcription_config;
    expect(tc.additional_vocab).toEqual(vocab);
  });

  it("omits the field entirely when undefined or empty (safe rollback shape)", () => {
    for (const additionalVocab of [undefined, [] as Array<{ content: string }>]) {
      const msg = buildStartRecognition({
        ...DEFAULT_SPEECHMATICS_CONFIG,
        language: "cmn_en",
        diarization: false,
        additionalVocab,
      });
      const tc = (msg as { transcription_config: Record<string, unknown> }).transcription_config;
      expect("additional_vocab" in tc).toBe(false);
    }
  });
});
