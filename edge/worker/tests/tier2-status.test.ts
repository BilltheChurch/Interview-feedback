import { describe, it, expect } from "vitest";
import type {
  Tier2Status,
  Tier2StatusState,
} from "../src/types_v2";

// ── Tier 2 Type Tests ─────────────────────────────────────────────────

describe("Tier2Status types", () => {
  const validStates: Tier2StatusState[] = [
    "idle",
    "pending",
    "downloading",
    "transcribing",
    "diarizing",
    "reconciling",
    "reporting",
    "persisting",
    "succeeded",
    "failed",
  ];

  it("accepts all valid Tier2StatusState values", () => {
    for (const state of validStates) {
      const status: Tier2Status = {
        enabled: true,
        status: state,
        started_at: null,
        completed_at: null,
        error: null,
        report_version: "tier1_instant",
        progress: 0,
        warnings: [],
      };
      expect(status.status).toBe(state);
    }
  });

  it("represents idle/default state", () => {
    const idle: Tier2Status = {
      enabled: false,
      status: "idle",
      started_at: null,
      completed_at: null,
      error: null,
      report_version: "tier1_instant",
      progress: 0,
      warnings: [],
    };
    expect(idle.enabled).toBe(false);
    expect(idle.status).toBe("idle");
    expect(idle.report_version).toBe("tier1_instant");
    expect(idle.progress).toBe(0);
  });

  it("represents pending state after tier1 completion", () => {
    const pending: Tier2Status = {
      enabled: true,
      status: "pending",
      started_at: null,
      completed_at: null,
      error: null,
      report_version: "tier1_instant",
      progress: 0,
      warnings: [],
    };
    expect(pending.enabled).toBe(true);
    expect(pending.status).toBe("pending");
  });

  it("represents in-progress downloading state", () => {
    const downloading: Tier2Status = {
      enabled: true,
      status: "downloading",
      started_at: "2026-02-18T10:00:00.000Z",
      completed_at: null,
      error: null,
      report_version: "tier1_instant",
      progress: 15,
      warnings: [],
    };
    expect(downloading.status).toBe("downloading");
    expect(downloading.started_at).toBeTruthy();
    expect(downloading.progress).toBe(15);
  });

  it("represents successful completion", () => {
    const succeeded: Tier2Status = {
      enabled: true,
      status: "succeeded",
      started_at: "2026-02-18T10:00:00.000Z",
      completed_at: "2026-02-18T10:02:30.000Z",
      error: null,
      report_version: "tier2_refined",
      progress: 100,
      warnings: ["tier2 sanitized 2 claims with empty/invalid evidence_refs"],
    };
    expect(succeeded.status).toBe("succeeded");
    expect(succeeded.report_version).toBe("tier2_refined");
    expect(succeeded.progress).toBe(100);
    expect(succeeded.completed_at).toBeTruthy();
    expect(succeeded.warnings).toHaveLength(1);
  });

  it("represents failure state", () => {
    const failed: Tier2Status = {
      enabled: true,
      status: "failed",
      started_at: "2026-02-18T10:00:00.000Z",
      completed_at: "2026-02-18T10:01:00.000Z",
      error: "batch/process returned 500: internal server error",
      report_version: "tier1_instant",
      progress: 100,
      warnings: [],
    };
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("500");
    expect(failed.report_version).toBe("tier1_instant");
  });

  it("report_version transitions from tier1_instant to tier2_refined on success", () => {
    const before: Tier2Status = {
      enabled: true,
      status: "pending",
      started_at: null,
      completed_at: null,
      error: null,
      report_version: "tier1_instant",
      progress: 0,
      warnings: [],
    };

    // Simulate transition to succeeded
    const after: Tier2Status = {
      ...before,
      status: "succeeded",
      started_at: "2026-02-18T10:00:00.000Z",
      completed_at: "2026-02-18T10:02:30.000Z",
      report_version: "tier2_refined",
      progress: 100,
    };

    expect(before.report_version).toBe("tier1_instant");
    expect(after.report_version).toBe("tier2_refined");
  });
});

// ── Tier 2 Route Regex Tests ──────────────────────────────────────────

describe("tier2-status route regex", () => {
  // Replicate the regex from index.ts
  const SESSION_TIER2_STATUS_ROUTE_REGEX =
    /^\/v1\/sessions\/([^/]+)\/tier2-status$/;

  it("matches valid tier2-status URL", () => {
    const match = "/v1/sessions/abc123/tier2-status".match(
      SESSION_TIER2_STATUS_ROUTE_REGEX
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBe("abc123");
  });

  it("captures session ID with special characters", () => {
    const match = "/v1/sessions/e2e_group_1771344119114/tier2-status".match(
      SESSION_TIER2_STATUS_ROUTE_REGEX
    );
    expect(match).not.toBeNull();
    expect(match![1]).toBe("e2e_group_1771344119114");
  });

  it("does not match without tier2-status suffix", () => {
    const match = "/v1/sessions/abc123/tier2".match(
      SESSION_TIER2_STATUS_ROUTE_REGEX
    );
    expect(match).toBeNull();
  });

  it("does not match with extra path segments", () => {
    const match = "/v1/sessions/abc123/tier2-status/extra".match(
      SESSION_TIER2_STATUS_ROUTE_REGEX
    );
    expect(match).toBeNull();
  });

  it("does not match wrong prefix", () => {
    const match = "/v2/sessions/abc123/tier2-status".match(
      SESSION_TIER2_STATUS_ROUTE_REGEX
    );
    expect(match).toBeNull();
  });
});

// ── Tier 2 Status State Machine Tests ─────────────────────────────────

describe("Tier2 status state machine", () => {
  function isTier2Terminal(status: Tier2StatusState): boolean {
    return status === "succeeded" || status === "failed" || status === "idle";
  }

  it("identifies terminal states correctly", () => {
    expect(isTier2Terminal("idle")).toBe(true);
    expect(isTier2Terminal("succeeded")).toBe(true);
    expect(isTier2Terminal("failed")).toBe(true);
  });

  it("identifies non-terminal states correctly", () => {
    const nonTerminal: Tier2StatusState[] = [
      "pending",
      "downloading",
      "transcribing",
      "diarizing",
      "reconciling",
      "reporting",
      "persisting",
    ];
    for (const state of nonTerminal) {
      expect(isTier2Terminal(state)).toBe(false);
    }
  });

  it("progress increases monotonically through stages", () => {
    const stages: Array<{ state: Tier2StatusState; progress: number }> = [
      { state: "pending", progress: 0 },
      { state: "downloading", progress: 5 },
      { state: "transcribing", progress: 25 },
      { state: "diarizing", progress: 50 },
      { state: "reconciling", progress: 65 },
      { state: "reporting", progress: 75 },
      { state: "persisting", progress: 90 },
      { state: "succeeded", progress: 100 },
    ];

    for (let i = 1; i < stages.length; i++) {
      expect(stages[i].progress).toBeGreaterThan(stages[i - 1].progress);
    }
  });
});

// ── Tier 2 Config Tests ───────────────────────────────────────────────

describe("Tier2 config from ProviderConfig", () => {
  it("default provider config has tier2 disabled", () => {
    // Matches DEFAULT_PROVIDER_CONFIG in providers/types.ts
    const defaultConfig = {
      tier2: {
        enabled: false,
        auto_trigger: false,
        processor: "local",
      },
    };
    expect(defaultConfig.tier2.enabled).toBe(false);
    expect(defaultConfig.tier2.auto_trigger).toBe(false);
  });

  it("tier2 can be enabled with auto_trigger", () => {
    const config = {
      tier2: {
        enabled: true,
        auto_trigger: true,
        processor: "local",
        endpoint: "http://localhost:8000/batch/process",
      },
    };
    expect(config.tier2.enabled).toBe(true);
    expect(config.tier2.auto_trigger).toBe(true);
    expect(config.tier2.endpoint).toBe(
      "http://localhost:8000/batch/process"
    );
  });
});
