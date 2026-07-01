import { describe, it, expect } from "vitest";
import { buildStartRecognition, DEFAULT_SPEECHMATICS_CONFIG } from "../src/speechmatics-asr";
import { resolveSpeechmaticsPunctuation } from "../src/config";

// R-H: Chinese captions arrived with no punctuation. Speechmatics punctuation is on by
// default and every language pack (incl. cmn/cmn_en) supports it, so we request it
// explicitly with a documented-valid override:
//   punctuation_overrides.permitted_marks = ["all"]  (documented default; never rejected)
//   punctuation_overrides.sensitivity     = <0..1>   (higher → more marks)
// The whole block is env-gated (SPEECHMATICS_PUNCTUATION). When disabled we send NO
// punctuation_overrides field at all, so a rollback can never risk an invalid_config
// rejection of StartRecognition.

describe("buildStartRecognition — punctuation_overrides", () => {
  it("includes punctuation_overrides with permitted_marks=['all'] when a sensitivity is set", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: true,
      punctuationSensitivity: 0.5,
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.punctuation_overrides).toEqual({ permitted_marks: ["all"], sensitivity: 0.5 });
  });

  it("omits punctuation_overrides entirely when punctuationSensitivity is undefined (safe rollback)", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "cmn_en",
      diarization: true,
      // punctuationSensitivity intentionally omitted
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect("punctuation_overrides" in tc).toBe(false);
  });

  it("carries the sensitivity value through to the request", () => {
    const msg = buildStartRecognition({
      ...DEFAULT_SPEECHMATICS_CONFIG,
      language: "en",
      diarization: false,
      punctuationSensitivity: 0.8,
    });
    const tc = msg.transcription_config as Record<string, unknown>;
    expect(tc.punctuation_overrides).toEqual({ permitted_marks: ["all"], sensitivity: 0.8 });
  });
});

// ── resolveSpeechmaticsPunctuation — env gate + sensitivity ────────────────────

describe("resolveSpeechmaticsPunctuation", () => {
  function makeEnv(enabled?: string, sensitivity?: string) {
    const env: { SPEECHMATICS_PUNCTUATION?: string; SPEECHMATICS_PUNCTUATION_SENSITIVITY?: string } = {};
    if (enabled !== undefined) env.SPEECHMATICS_PUNCTUATION = enabled;
    if (sensitivity !== undefined) env.SPEECHMATICS_PUNCTUATION_SENSITIVITY = sensitivity;
    return env;
  }

  it("defaults to enabled (returns a sensitivity) when unset — punctuation is safe/on-by-default", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv())).toBe(0.5);
  });

  it("returns undefined (field omitted) when explicitly disabled", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv("false"))).toBeUndefined();
    expect(resolveSpeechmaticsPunctuation(makeEnv("0"))).toBeUndefined();
    expect(resolveSpeechmaticsPunctuation(makeEnv("off"))).toBeUndefined();
  });

  it("stays enabled for explicit truthy values", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv("true"))).toBe(0.5);
    expect(resolveSpeechmaticsPunctuation(makeEnv("1"))).toBe(0.5);
    expect(resolveSpeechmaticsPunctuation(makeEnv("on"))).toBe(0.5);
  });

  it("honours a valid in-range sensitivity override", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv("true", "0.8"))).toBe(0.8);
    expect(resolveSpeechmaticsPunctuation(makeEnv(undefined, "0"))).toBe(0);
    expect(resolveSpeechmaticsPunctuation(makeEnv(undefined, "1"))).toBe(1);
  });

  it("falls back to the default sensitivity for out-of-range or non-numeric input", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv(undefined, "2"))).toBe(0.5);
    expect(resolveSpeechmaticsPunctuation(makeEnv(undefined, "-1"))).toBe(0.5);
    expect(resolveSpeechmaticsPunctuation(makeEnv(undefined, "abc"))).toBe(0.5);
  });

  it("returns undefined when disabled even if a sensitivity is provided", () => {
    expect(resolveSpeechmaticsPunctuation(makeEnv("false", "0.8"))).toBeUndefined();
  });
});
