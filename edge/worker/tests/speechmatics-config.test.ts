import { describe, it, expect } from "vitest";
import { buildStartRecognition, DEFAULT_SPEECHMATICS_CONFIG } from "../src/speechmatics-asr";
import {
  resolveMaxSpeakers,
  resolveSpeechmaticsOperatingPoint,
  resolveSpeechmaticsMaxDelay,
} from "../src/config";

// ── buildStartRecognition — maxSpeakers / speaker_diarization_config ──────────

describe("buildStartRecognition — speaker_diarization_config", () => {
  it("sets max_speakers in speaker_diarization_config when diarization=true and maxSpeakers is provided", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: true,
      maxSpeakers: 6,
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.speaker_diarization_config).toEqual({ max_speakers: 6 });
  });

  it("omits speaker_diarization_config when diarization=true but maxSpeakers is undefined", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: true,
      // maxSpeakers intentionally omitted
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect("speaker_diarization_config" in tc).toBe(false);
  });

  it("never emits speaker_diarization_config when diarization=false, even with maxSpeakers set", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "en",
      diarization: false,
      maxSpeakers: 4,
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect("speaker_diarization_config" in tc).toBe(false);
    // Also ensure diarization itself is not set
    expect(tc.diarization).toBeUndefined();
  });
});

// ── resolveMaxSpeakers — pure env parser ──────────────────────────────────────

describe("resolveMaxSpeakers", () => {
  function makeEnv(val: string | undefined): { ASR_MAX_SPEAKERS?: string } {
    return val !== undefined ? { ASR_MAX_SPEAKERS: val } : {};
  }

  it("returns the parsed integer when ASR_MAX_SPEAKERS is a valid number >= 2", () => {
    expect(resolveMaxSpeakers(makeEnv("6"))).toBe(6);
    expect(resolveMaxSpeakers(makeEnv("2"))).toBe(2);
    expect(resolveMaxSpeakers(makeEnv("10"))).toBe(10);
  });

  it("returns undefined when ASR_MAX_SPEAKERS is unset", () => {
    expect(resolveMaxSpeakers(makeEnv(undefined))).toBeUndefined();
  });

  it("returns undefined when ASR_MAX_SPEAKERS is '1' (below minimum of 2)", () => {
    expect(resolveMaxSpeakers(makeEnv("1"))).toBeUndefined();
  });

  it("returns undefined when ASR_MAX_SPEAKERS is '0' (below minimum of 2)", () => {
    expect(resolveMaxSpeakers(makeEnv("0"))).toBeUndefined();
  });

  it("returns undefined when ASR_MAX_SPEAKERS is a non-numeric string", () => {
    expect(resolveMaxSpeakers(makeEnv("abc"))).toBeUndefined();
    expect(resolveMaxSpeakers(makeEnv("6abc"))).toBeUndefined(); // partial-numeric rejected
  });

  it("returns undefined when ASR_MAX_SPEAKERS is an empty string", () => {
    expect(resolveMaxSpeakers(makeEnv(""))).toBeUndefined();
  });
});

// ── resolveSpeechmaticsOperatingPoint — R5 accuracy knob ──────────────────────

describe("resolveSpeechmaticsOperatingPoint", () => {
  function makeEnv(val: string | undefined): { SPEECHMATICS_OPERATING_POINT?: string } {
    return val !== undefined ? { SPEECHMATICS_OPERATING_POINT: val } : {};
  }

  it("defaults to 'enhanced' when unset (R5 accuracy)", () => {
    expect(resolveSpeechmaticsOperatingPoint(makeEnv(undefined))).toBe("enhanced");
    expect(resolveSpeechmaticsOperatingPoint(makeEnv(""))).toBe("enhanced");
  });

  it("honours 'standard' and 'enhanced' overrides (case/space-insensitive)", () => {
    expect(resolveSpeechmaticsOperatingPoint(makeEnv("standard"))).toBe("standard");
    expect(resolveSpeechmaticsOperatingPoint(makeEnv("enhanced"))).toBe("enhanced");
    expect(resolveSpeechmaticsOperatingPoint(makeEnv(" STANDARD "))).toBe("standard");
  });

  it("falls back to 'enhanced' for unrecognized values", () => {
    expect(resolveSpeechmaticsOperatingPoint(makeEnv("turbo"))).toBe("enhanced");
  });
});

// ── resolveSpeechmaticsMaxDelay — R6 latency knob ─────────────────────────────

describe("resolveSpeechmaticsMaxDelay", () => {
  function makeEnv(val: string | undefined): { SPEECHMATICS_MAX_DELAY?: string } {
    return val !== undefined ? { SPEECHMATICS_MAX_DELAY: val } : {};
  }

  it("defaults to 1.0 when unset (R6 lower latency)", () => {
    expect(resolveSpeechmaticsMaxDelay(makeEnv(undefined))).toBe(1.0);
    expect(resolveSpeechmaticsMaxDelay(makeEnv(""))).toBe(1.0);
  });

  it("parses a valid in-range float", () => {
    expect(resolveSpeechmaticsMaxDelay(makeEnv("1.5"))).toBe(1.5);
    expect(resolveSpeechmaticsMaxDelay(makeEnv("0.7"))).toBe(0.7);
    expect(resolveSpeechmaticsMaxDelay(makeEnv("4"))).toBe(4);
  });

  it("clamps values below the Speechmatics minimum (0.7)", () => {
    expect(resolveSpeechmaticsMaxDelay(makeEnv("0.1"))).toBe(0.7);
    expect(resolveSpeechmaticsMaxDelay(makeEnv("-3"))).toBe(0.7);
  });

  it("clamps values above the Speechmatics maximum (4)", () => {
    expect(resolveSpeechmaticsMaxDelay(makeEnv("10"))).toBe(4);
  });

  it("falls back to 1.0 for non-numeric input", () => {
    expect(resolveSpeechmaticsMaxDelay(makeEnv("abc"))).toBe(1.0);
  });
});
