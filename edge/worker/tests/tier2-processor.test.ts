import { describe, it, expect } from "vitest";
import {
  tier2Enabled,
  tier2AutoTrigger,
  tier2BatchEndpoint,
  isTier2Terminal,
} from "../src/tier2-processor";
import type { Env } from "../src/config";

// ── Minimal Env factory ───────────────────────────────────────────────────────

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    TIER2_ENABLED: "false",
    TIER2_AUTO_TRIGGER: "false",
    TIER2_BATCH_ENDPOINT: "",
    INFERENCE_BASE_URL: "http://localhost:8000",
    ...overrides,
  } as unknown as Env;
}

// ── tier2Enabled ──────────────────────────────────────────────────────────────

describe("tier2Enabled", () => {
  it("returns false when TIER2_ENABLED is 'false'", () => {
    expect(tier2Enabled(makeEnv({ TIER2_ENABLED: "false" }))).toBe(false);
  });

  it("returns true when TIER2_ENABLED is 'true'", () => {
    expect(tier2Enabled(makeEnv({ TIER2_ENABLED: "true" }))).toBe(true);
  });

  it("returns false when TIER2_ENABLED is missing", () => {
    expect(tier2Enabled(makeEnv({ TIER2_ENABLED: undefined as unknown as string }))).toBe(false);
  });

  it("returns true when TIER2_ENABLED is '1'", () => {
    expect(tier2Enabled(makeEnv({ TIER2_ENABLED: "1" }))).toBe(true);
  });
});

// ── tier2AutoTrigger ──────────────────────────────────────────────────────────

describe("tier2AutoTrigger", () => {
  it("returns false when TIER2_AUTO_TRIGGER is 'false'", () => {
    expect(tier2AutoTrigger(makeEnv({ TIER2_AUTO_TRIGGER: "false" }))).toBe(false);
  });

  it("returns true when TIER2_AUTO_TRIGGER is 'true'", () => {
    expect(tier2AutoTrigger(makeEnv({ TIER2_AUTO_TRIGGER: "true" }))).toBe(true);
  });

  it("returns false when TIER2_AUTO_TRIGGER is missing", () => {
    expect(tier2AutoTrigger(makeEnv({ TIER2_AUTO_TRIGGER: undefined as unknown as string }))).toBe(false);
  });
});

// ── tier2BatchEndpoint ────────────────────────────────────────────────────────

describe("tier2BatchEndpoint", () => {
  it("uses TIER2_BATCH_ENDPOINT when explicitly set", () => {
    const env = makeEnv({
      TIER2_BATCH_ENDPOINT: "https://custom.endpoint/batch",
      INFERENCE_BASE_URL: "http://localhost:8000",
    });
    expect(tier2BatchEndpoint(env)).toBe("https://custom.endpoint/batch");
  });

  it("falls back to INFERENCE_BASE_URL/batch/process when TIER2_BATCH_ENDPOINT is empty", () => {
    const env = makeEnv({
      TIER2_BATCH_ENDPOINT: "",
      INFERENCE_BASE_URL: "http://localhost:8000",
    });
    expect(tier2BatchEndpoint(env)).toBe("http://localhost:8000/batch/process");
  });

  it("falls back when TIER2_BATCH_ENDPOINT is whitespace only", () => {
    const env = makeEnv({
      TIER2_BATCH_ENDPOINT: "   ",
      INFERENCE_BASE_URL: "https://if.example.ai",
    });
    expect(tier2BatchEndpoint(env)).toBe("https://if.example.ai/batch/process");
  });

  it("falls back when TIER2_BATCH_ENDPOINT is undefined", () => {
    const env = makeEnv({
      TIER2_BATCH_ENDPOINT: undefined as unknown as string,
      INFERENCE_BASE_URL: "http://127.0.0.1:8000",
    });
    expect(tier2BatchEndpoint(env)).toBe("http://127.0.0.1:8000/batch/process");
  });
});

// ── isTier2Terminal ───────────────────────────────────────────────────────────

describe("isTier2Terminal", () => {
  it("returns true for 'succeeded'", () => {
    expect(isTier2Terminal("succeeded")).toBe(true);
  });

  it("returns true for 'failed'", () => {
    expect(isTier2Terminal("failed")).toBe(true);
  });

  it("returns true for 'idle'", () => {
    expect(isTier2Terminal("idle")).toBe(true);
  });

  it("returns false for 'pending'", () => {
    expect(isTier2Terminal("pending")).toBe(false);
  });

  it("returns false for 'downloading'", () => {
    expect(isTier2Terminal("downloading")).toBe(false);
  });

  it("returns false for 'transcribing'", () => {
    expect(isTier2Terminal("transcribing")).toBe(false);
  });

  it("returns false for 'diarizing'", () => {
    expect(isTier2Terminal("diarizing")).toBe(false);
  });

  it("returns false for 'reconciling'", () => {
    expect(isTier2Terminal("reconciling")).toBe(false);
  });

  it("returns false for 'reporting'", () => {
    expect(isTier2Terminal("reporting")).toBe(false);
  });

  it("returns false for 'persisting'", () => {
    expect(isTier2Terminal("persisting")).toBe(false);
  });
});
