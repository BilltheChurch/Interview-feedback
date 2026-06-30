import { describe, it, expect } from "vitest";
import { mergeFinalizeMetadataIntoConfig } from "../src/finalize-orchestrator";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const SAMPLE_PRESETS = [
  {
    key: "logical_reasoning",
    label_en: "Logical Reasoning",
    label_zh: "逻辑推理",
    description: "Evaluates structured thinking",
    weight: 1.0,
  },
  {
    key: "communication",
    label_en: "Communication",
    label_zh: "沟通能力",
    description: "Clarity and effectiveness",
    weight: 0.8,
  },
];

// ── mergeFinalizeMetadataIntoConfig ───────────────────────────────────────────

describe("mergeFinalizeMetadataIntoConfig", () => {
  // ── interview_type ──────────────────────────────────────────────────────────

  it("merges interview_type string from metadata into config", () => {
    const config: Record<string, unknown> = {};
    const metadata = { interview_type: "technical" };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBe("technical");
  });

  it("overwrites existing interview_type in config", () => {
    const config: Record<string, unknown> = { interview_type: "behavioral" };
    const metadata = { interview_type: "academic" };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBe("academic");
  });

  it("does not touch interview_type when absent from metadata", () => {
    const config: Record<string, unknown> = { interview_type: "group" };
    const metadata = {};
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBe("group");
  });

  it("ignores interview_type when value is not a string (number)", () => {
    const config: Record<string, unknown> = {};
    const metadata = { interview_type: 42 };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBeUndefined();
  });

  it("ignores interview_type when value is null", () => {
    const config: Record<string, unknown> = {};
    const metadata = { interview_type: null };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBeUndefined();
  });

  // ── dimension_presets ───────────────────────────────────────────────────────

  it("merges dimension_presets array from metadata into config", () => {
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: SAMPLE_PRESETS };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toEqual(SAMPLE_PRESETS);
  });

  it("overwrites existing dimension_presets in config", () => {
    const config: Record<string, unknown> = {
      dimension_presets: [{ key: "old", label_en: "Old", label_zh: "旧", description: "", weight: 1 }],
    };
    const metadata = { dimension_presets: SAMPLE_PRESETS };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toEqual(SAMPLE_PRESETS);
  });

  it("does not touch dimension_presets when absent from metadata", () => {
    const original = [{ key: "existing", label_en: "E", label_zh: "存在", description: "", weight: 1 }];
    const config: Record<string, unknown> = { dimension_presets: original };
    const metadata = {};
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toEqual(original);
  });

  it("ignores dimension_presets when value is not an array (string)", () => {
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: "not-an-array" };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toBeUndefined();
  });

  it("ignores dimension_presets when value is an object (not array)", () => {
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: { key: "bad" } };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toBeUndefined();
  });

  it("ignores dimension_presets when value is null", () => {
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: null };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toBeUndefined();
  });

  // ── per-item validation (worker is the trust boundary before the LLM) ──────

  it("filters dimension_presets to only items with a non-empty string key", () => {
    const config: Record<string, unknown> = {};
    const metadata = {
      dimension_presets: [
        SAMPLE_PRESETS[0],          // valid
        { label_en: "x" },          // garbage: no key
        "junk",                     // garbage: not an object
        42,                         // garbage: not an object
        { key: "" },                // garbage: empty key
        { key: 123 },               // garbage: non-string key
        null,                       // garbage: null
        SAMPLE_PRESETS[1],          // valid
      ],
    };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toEqual([SAMPLE_PRESETS[0], SAMPLE_PRESETS[1]]);
  });

  it("treats an all-garbage dimension_presets array as absent (config unchanged → fallback to defaults)", () => {
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: [{}, "x", 7, null, { key: "" }] };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toBeUndefined();
  });

  it("treats an empty dimension_presets array as absent (config unchanged → fallback to defaults)", () => {
    // Contract change (was: empty array stored). Empty / all-invalid → treated as
    // absent so downstream falls back to default dimensions, never an empty rubric.
    const config: Record<string, unknown> = {};
    const metadata = { dimension_presets: [] };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toBeUndefined();
  });

  it("does not overwrite existing dimension_presets when incoming array has zero valid items", () => {
    const existing = [{ key: "existing", label_en: "E", label_zh: "存在", description: "", weight: 1 }];
    const config: Record<string, unknown> = { dimension_presets: existing };
    const metadata = { dimension_presets: [{}, "junk"] };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.dimension_presets).toEqual(existing);
  });

  // ── back-compat: both fields absent ────────────────────────────────────────

  it("leaves config unchanged when metadata has neither field", () => {
    const config: Record<string, unknown> = {
      free_form_notes: "some notes",
      diarization_backend: "cloud",
    };
    const metadata = {};
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config).toEqual({
      free_form_notes: "some notes",
      diarization_backend: "cloud",
    });
  });

  // ── both fields present simultaneously ─────────────────────────────────────

  it("merges both interview_type and dimension_presets together", () => {
    const config: Record<string, unknown> = {};
    const metadata = { interview_type: "behavioral", dimension_presets: SAMPLE_PRESETS };
    mergeFinalizeMetadataIntoConfig(config, metadata);
    expect(config.interview_type).toBe("behavioral");
    expect(config.dimension_presets).toEqual(SAMPLE_PRESETS);
  });
});
