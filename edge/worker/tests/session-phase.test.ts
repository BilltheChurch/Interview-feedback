import { describe, it, expect } from "vitest";
import type { SessionPhase, FinalizeStageCheckpoint } from "../src/types_v2";
import { SESSION_PHASE_TRANSITIONS } from "../src/types_v2";
import { transitionSessionPhase } from "../src/config";

// ── E6: Session Phase State Machine Tests ─────────────────────────────

describe("SessionPhase state machine", () => {
  const ALL_PHASES: SessionPhase[] = ["idle", "recording", "finalizing", "finalized", "archived"];

  it("defines transitions for every phase", () => {
    for (const phase of ALL_PHASES) {
      expect(SESSION_PHASE_TRANSITIONS[phase]).toBeDefined();
      expect(Array.isArray(SESSION_PHASE_TRANSITIONS[phase])).toBe(true);
    }
  });

  describe("valid transitions", () => {
    const validCases: [SessionPhase, SessionPhase][] = [
      ["idle", "recording"],
      ["recording", "finalizing"],
      ["finalizing", "finalized"],
      ["finalizing", "recording"],   // retry after failure
      ["finalized", "archived"],
      ["finalized", "finalizing"],   // re-finalize
      ["archived", "idle"],          // after GDPR purge
    ];

    for (const [from, to] of validCases) {
      it(`allows ${from} → ${to}`, () => {
        const result = transitionSessionPhase(from, to);
        expect(result.valid).toBe(true);
        expect(result.phase).toBe(to);
      });
    }
  });

  describe("invalid transitions", () => {
    const invalidCases: [SessionPhase, SessionPhase][] = [
      ["idle", "finalizing"],
      ["idle", "finalized"],
      ["idle", "archived"],
      ["recording", "idle"],
      ["recording", "finalized"],
      ["recording", "archived"],
      ["finalizing", "idle"],
      ["finalizing", "archived"],
      ["finalized", "idle"],
      ["finalized", "recording"],
      ["archived", "recording"],
      ["archived", "finalizing"],
      ["archived", "finalized"],
    ];

    for (const [from, to] of invalidCases) {
      it(`rejects ${from} → ${to}`, () => {
        const result = transitionSessionPhase(from, to);
        expect(result.valid).toBe(false);
        expect(result.phase).toBe(from); // stays at current
      });
    }
  });

  it("happy path: full lifecycle idle → recording → finalizing → finalized → archived", () => {
    let phase: SessionPhase = "idle";

    let r = transitionSessionPhase(phase, "recording");
    expect(r.valid).toBe(true);
    phase = r.phase;

    r = transitionSessionPhase(phase, "finalizing");
    expect(r.valid).toBe(true);
    phase = r.phase;

    r = transitionSessionPhase(phase, "finalized");
    expect(r.valid).toBe(true);
    phase = r.phase;

    r = transitionSessionPhase(phase, "archived");
    expect(r.valid).toBe(true);
    phase = r.phase;
    expect(phase).toBe("archived");
  });

  it("retry path: finalizing → recording (failure) → finalizing → finalized", () => {
    let phase: SessionPhase = "finalizing";

    // Failure: go back to recording for retry
    let r = transitionSessionPhase(phase, "recording");
    expect(r.valid).toBe(true);
    phase = r.phase;

    // Retry finalization
    r = transitionSessionPhase(phase, "finalizing");
    expect(r.valid).toBe(true);
    phase = r.phase;

    // Succeed
    r = transitionSessionPhase(phase, "finalized");
    expect(r.valid).toBe(true);
    expect(phase).toBe("finalizing");
  });

  it("re-finalize path: finalized → finalizing → finalized", () => {
    let phase: SessionPhase = "finalized";

    let r = transitionSessionPhase(phase, "finalizing");
    expect(r.valid).toBe(true);
    phase = r.phase;

    r = transitionSessionPhase(phase, "finalized");
    expect(r.valid).toBe(true);
    expect(r.phase).toBe("finalized");
  });
});

// ── E5: FinalizeStageCheckpoint Type Tests ────────────────────────────

describe("FinalizeStageCheckpoint", () => {
  it("constructs a valid checkpoint", () => {
    const checkpoint: FinalizeStageCheckpoint = {
      job_id: "fv2_test-123",
      completed_stage: "reconcile",
      saved_at: Date.now(),
      stage_data: { transcript_count: 42, locale: "en-US" },
    };
    expect(checkpoint.job_id).toBe("fv2_test-123");
    expect(checkpoint.completed_stage).toBe("reconcile");
    expect(checkpoint.stage_data.transcript_count).toBe(42);
  });

  it("accepts all finalization stages", () => {
    const stages = [
      "idle", "freeze", "drain", "replay_gap", "local_asr",
      "cluster", "reconcile", "stats", "events", "report", "persist"
    ];
    for (const stage of stages) {
      const cp: FinalizeStageCheckpoint = {
        job_id: `fv2_${stage}`,
        completed_stage: stage as FinalizeStageCheckpoint["completed_stage"],
        saved_at: Date.now(),
        stage_data: {},
      };
      expect(cp.completed_stage).toBe(stage);
    }
  });

  it("stage_data can hold arbitrary metadata", () => {
    const checkpoint: FinalizeStageCheckpoint = {
      job_id: "fv2_report",
      completed_stage: "report",
      saved_at: 1709500000000,
      stage_data: {
        report_source: "llm_synthesized",
        report_model: "qwen-plus",
        pipeline_mode: "llm_core_synthesis",
        nested: { claim_count: 15 },
      },
    };
    expect(checkpoint.stage_data.report_source).toBe("llm_synthesized");
    expect((checkpoint.stage_data.nested as Record<string, number>).claim_count).toBe(15);
  });
});
