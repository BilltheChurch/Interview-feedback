import { describe, it, expect } from "vitest";
import {
  createDefaultIncrementalStatus,
  incrementalIntervalMs,
  incrementalOverlapMs,
  incrementalCumulativeThreshold,
  incrementalAnalysisInterval,
  shouldScheduleIncremental,
  parseProcessChunkResponse,
  type IncrementalEnv,
  type ScheduleDecision,
} from "../src/incremental";
import type { IncrementalStatus } from "../src/types_v2";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build an IncrementalStatus with custom overrides. */
function makeStatus(overrides: Partial<IncrementalStatus> = {}): IncrementalStatus {
  return { ...createDefaultIncrementalStatus(), enabled: true, ...overrides };
}

/** Env with custom overrides (V0 INCREMENTAL_ENABLED removed). */
function makeEnv(overrides: Partial<IncrementalEnv> = {}): IncrementalEnv {
  return { ...overrides };
}

// ── createDefaultIncrementalStatus ───────────────────────────────────────────

describe("createDefaultIncrementalStatus", () => {
  it("returns idle/disabled defaults", () => {
    const s = createDefaultIncrementalStatus();
    expect(s.enabled).toBe(false);
    expect(s.status).toBe("idle");
    expect(s.increments_completed).toBe(0);
    expect(s.increments_failed).toBe(0);
    expect(s.last_processed_ms).toBe(0);
    expect(s.speakers_detected).toBe(0);
    expect(s.stable_speaker_map).toBe(false);
    expect(s.checkpoints_completed).toBe(0);
    expect(s.started_at).toBeNull();
    expect(s.last_increment_at).toBeNull();
    expect(s.error).toBeNull();
    expect(s.warnings).toEqual([]);
  });

  it("returns a fresh object each call (no shared state)", () => {
    const a = createDefaultIncrementalStatus();
    const b = createDefaultIncrementalStatus();
    expect(a).not.toBe(b);
    a.warnings.push("test");
    expect(b.warnings).toHaveLength(0);
  });
});

// ── Env parsing helpers ──────────────────────────────────────────────────────

describe("env parsing helpers", () => {
  describe("incrementalIntervalMs", () => {
    it("defaults to 180_000", () => {
      expect(incrementalIntervalMs({})).toBe(180_000);
    });

    it("parses custom value", () => {
      expect(incrementalIntervalMs({ INCREMENTAL_INTERVAL_MS: "60000" })).toBe(60_000);
    });

    it("uses fallback for non-positive number", () => {
      expect(incrementalIntervalMs({ INCREMENTAL_INTERVAL_MS: "0" })).toBe(180_000);
      expect(incrementalIntervalMs({ INCREMENTAL_INTERVAL_MS: "-1" })).toBe(180_000);
    });

    it("uses fallback for non-numeric string", () => {
      expect(incrementalIntervalMs({ INCREMENTAL_INTERVAL_MS: "abc" })).toBe(180_000);
    });

    it("floors floating-point values", () => {
      expect(incrementalIntervalMs({ INCREMENTAL_INTERVAL_MS: "120500.9" })).toBe(120_500);
    });
  });

  describe("incrementalOverlapMs", () => {
    it("defaults to 30_000", () => {
      expect(incrementalOverlapMs({})).toBe(30_000);
    });
  });

  describe("incrementalCumulativeThreshold", () => {
    it("defaults to 2", () => {
      expect(incrementalCumulativeThreshold({})).toBe(2);
    });
  });

  describe("incrementalAnalysisInterval", () => {
    it("defaults to 2", () => {
      expect(incrementalAnalysisInterval({})).toBe(2);
    });
  });
});

// ── shouldScheduleIncremental ────────────────────────────────────────────────
// Note: V1 callers gate on incrementalV1Enabled() before calling this function.
// The function itself no longer checks INCREMENTAL_ENABLED.

describe("shouldScheduleIncremental", () => {
  const noSchedule = (d: ScheduleDecision) => {
    expect(d.schedule).toBe(false);
  };

  it("returns no-op when status is 'processing'", () => {
    const env = makeEnv();
    const status = makeStatus({ status: "processing" });
    noSchedule(shouldScheduleIncremental(env, status, 360_000));
  });

  it("returns no-op when status is 'finalizing'", () => {
    const env = makeEnv();
    const status = makeStatus({ status: "finalizing" });
    noSchedule(shouldScheduleIncremental(env, status, 360_000));
  });

  it("returns no-op when unprocessed audio < interval", () => {
    const env = makeEnv();
    const status = makeStatus({ last_processed_ms: 0 });
    // 179s < 180s default interval
    noSchedule(shouldScheduleIncremental(env, status, 179_000));
  });

  it("schedules when unprocessed audio >= interval", () => {
    const env = makeEnv();
    const status = makeStatus({ last_processed_ms: 0, increments_completed: 0 });
    const d = shouldScheduleIncremental(env, status, 180_000);
    expect(d.schedule).toBe(true);
    expect(d.endMs).toBe(180_000);
    expect(d.incrementIndex).toBe(0);
  });

  it("uses cumulative mode (startMs=0) for first N increments", () => {
    const env = makeEnv({ INCREMENTAL_CUMULATIVE_THRESHOLD: "2" });

    // increment 0: cumulative
    const d0 = shouldScheduleIncremental(
      env,
      makeStatus({ increments_completed: 0, last_processed_ms: 0 }),
      180_000
    );
    expect(d0.schedule).toBe(true);
    expect(d0.startMs).toBe(0);

    // increment 1: still cumulative
    const d1 = shouldScheduleIncremental(
      env,
      makeStatus({ increments_completed: 1, last_processed_ms: 180_000 }),
      360_000
    );
    expect(d1.schedule).toBe(true);
    expect(d1.startMs).toBe(0);
  });

  it("switches to chunk mode with overlap after cumulative threshold", () => {
    const env = makeEnv({
      INCREMENTAL_CUMULATIVE_THRESHOLD: "2",
      INCREMENTAL_OVERLAP_MS: "30000",
    });

    // increment 2: chunk mode — startMs = last_processed - overlap
    const d = shouldScheduleIncremental(
      env,
      makeStatus({ increments_completed: 2, last_processed_ms: 360_000 }),
      540_000
    );
    expect(d.schedule).toBe(true);
    expect(d.startMs).toBe(360_000 - 30_000); // 330_000
    expect(d.endMs).toBe(540_000);
    expect(d.incrementIndex).toBe(2);
  });

  it("clamps startMs to 0 when overlap exceeds processed", () => {
    const env = makeEnv({
      INCREMENTAL_CUMULATIVE_THRESHOLD: "0", // all chunk mode
      INCREMENTAL_OVERLAP_MS: "200000", // overlap > processed
    });
    const d = shouldScheduleIncremental(
      env,
      makeStatus({ increments_completed: 1, last_processed_ms: 180_000 }),
      360_000
    );
    expect(d.schedule).toBe(true);
    expect(d.startMs).toBe(0); // Math.max(0, 180k - 200k)
  });

  it("allows re-scheduling from 'recording', 'idle', 'succeeded', 'failed' states", () => {
    const env = makeEnv();
    const base = { increments_completed: 0, last_processed_ms: 0 };
    for (const st of ["recording", "idle", "succeeded", "failed"] as const) {
      const d = shouldScheduleIncremental(env, makeStatus({ ...base, status: st }), 180_000);
      expect(d.schedule).toBe(true);
    }
  });

  it("uses custom interval from env", () => {
    const env = makeEnv({ INCREMENTAL_INTERVAL_MS: "60000" });
    const status = makeStatus({ last_processed_ms: 0, increments_completed: 0 });
    // 60s threshold
    noSchedule(shouldScheduleIncremental(env, status, 59_000));
    const d = shouldScheduleIncremental(env, status, 60_000);
    expect(d.schedule).toBe(true);
  });
});

// ── parseProcessChunkResponse ────────────────────────────────────────────────

describe("parseProcessChunkResponse", () => {
  it("parses a full valid response", () => {
    const json = {
      utterances: [
        {
          utterance_id: "u1",
          stream_role: "mixed",
          speaker_name: "Alice",
          cluster_id: "spk-0",
          text: "Hello",
          start_ms: 0,
          end_ms: 2000,
          duration_ms: 2000,
        },
      ],
      speaker_profiles: [
        { speaker_id: "spk-0", centroid: [0.1], total_speech_ms: 2000, display_name: "Alice", first_seen_increment: 0 },
      ],
      checkpoint: { summary: "test" },
      speaker_mapping: { "local-0": "spk-0" },
      speakers_detected: 1,
      stable_speaker_map: true,
    };
    const parsed = parseProcessChunkResponse(json);
    expect(parsed.utterances).toHaveLength(1);
    expect(parsed.utterances[0].text).toBe("Hello");
    expect(parsed.speakerProfiles).toHaveLength(1);
    expect(parsed.checkpoint).toEqual({ summary: "test" });
    expect(parsed.speakerMapping).toEqual({ "local-0": "spk-0" });
    expect(parsed.speakersDetected).toBe(1);
    expect(parsed.stableSpeakerMap).toBe(true);
  });

  it("returns safe defaults for empty/missing fields", () => {
    const parsed = parseProcessChunkResponse({});
    expect(parsed.utterances).toEqual([]);
    expect(parsed.speakerProfiles).toEqual([]);
    expect(parsed.checkpoint).toBeNull();
    expect(parsed.speakerMapping).toEqual({});
    expect(parsed.speakersDetected).toBe(0);
    expect(parsed.stableSpeakerMap).toBe(false);
  });

  it("returns empty array if utterances is not an array", () => {
    const parsed = parseProcessChunkResponse({ utterances: "not-array" });
    expect(parsed.utterances).toEqual([]);
  });

  it("returns null checkpoint for non-object checkpoint", () => {
    expect(parseProcessChunkResponse({ checkpoint: "string" }).checkpoint).toBeNull();
    expect(parseProcessChunkResponse({ checkpoint: 42 }).checkpoint).toBeNull();
    expect(parseProcessChunkResponse({ checkpoint: null }).checkpoint).toBeNull();
  });

  it("returns empty mapping for array or non-object speaker_mapping", () => {
    expect(parseProcessChunkResponse({ speaker_mapping: [1, 2] }).speakerMapping).toEqual({});
    expect(parseProcessChunkResponse({ speaker_mapping: "str" }).speakerMapping).toEqual({});
  });

  it("infers speakersDetected from profiles length when missing", () => {
    const parsed = parseProcessChunkResponse({
      speaker_profiles: [
        { speaker_id: "a", centroid: [], total_speech_ms: 0, display_name: null, first_seen_increment: 0 },
        { speaker_id: "b", centroid: [], total_speech_ms: 0, display_name: null, first_seen_increment: 0 },
      ],
    });
    expect(parsed.speakersDetected).toBe(2);
  });

  it("uses explicit speakersDetected when provided", () => {
    const parsed = parseProcessChunkResponse({
      speakers_detected: 5,
      speaker_profiles: [],
    });
    expect(parsed.speakersDetected).toBe(5);
  });
});

// ── parseProcessChunkResponse confidence + increment_index ──────────────────

describe("parseProcessChunkResponse confidence + increment_index", () => {
  it("extracts confidence from utterance", () => {
    const json = {
      utterances: [
        { utterance_id: "u1", text: "hello", start_ms: 0, end_ms: 1000, duration_ms: 1000, stream_role: "mixed", confidence: 0.42 },
      ],
      speaker_profiles: [],
      increment_index: 3,
    };
    const parsed = parseProcessChunkResponse(json);
    expect(parsed.utterances[0].confidence).toBe(0.42);
    expect(parsed.utterances[0].increment_index).toBe(3);
  });

  it("defaults confidence to 1.0 when missing", () => {
    const json = {
      utterances: [
        { utterance_id: "u1", text: "hi", start_ms: 0, end_ms: 500, duration_ms: 500, stream_role: "mixed" },
      ],
      speaker_profiles: [],
    };
    const parsed = parseProcessChunkResponse(json);
    expect(parsed.utterances[0].confidence).toBe(1.0);
    expect(parsed.utterances[0].increment_index).toBe(0);
  });
});
