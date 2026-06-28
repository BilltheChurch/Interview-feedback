import { describe, it, expect } from "vitest";
import { enforceQualityGates, resolveUnknownRatioThreshold } from "../src/finalize_v2";

describe("resolveUnknownRatioThreshold (B4)", () => {
  it("defaults to 0.25 for missing/invalid/out-of-range input", () => {
    expect(resolveUnknownRatioThreshold(undefined)).toBe(0.25);
    expect(resolveUnknownRatioThreshold("")).toBe(0.25);
    expect(resolveUnknownRatioThreshold("abc")).toBe(0.25);
    expect(resolveUnknownRatioThreshold("-0.1")).toBe(0.25);
    expect(resolveUnknownRatioThreshold("1.5")).toBe(0.25);
  });
  it("parses a valid 0..1 threshold", () => {
    expect(resolveUnknownRatioThreshold("0.4")).toBe(0.4);
    expect(resolveUnknownRatioThreshold("0")).toBe(0);
    expect(resolveUnknownRatioThreshold("1")).toBe(1);
  });
});

describe("enforceQualityGates unknown_ratio threshold (B4)", () => {
  it("fails at the default 0.25 threshold when ratio exceeds it", () => {
    const r = enforceQualityGates({ perPerson: [], unknownRatio: 0.4 });
    expect(r.passed).toBe(false);
    expect(r.failures.some((f) => f.includes("unknown_ratio"))).toBe(true);
  });
  it("passes when a higher configured threshold is supplied", () => {
    const r = enforceQualityGates({ perPerson: [], unknownRatio: 0.4, unknownRatioThreshold: 0.5 });
    expect(r.passed).toBe(true);
    expect(r.failures).toHaveLength(0);
  });
  it("respects a stricter configured threshold", () => {
    const r = enforceQualityGates({ perPerson: [], unknownRatio: 0.1, unknownRatioThreshold: 0.05 });
    expect(r.passed).toBe(false);
    expect(r.failures[0]).toContain("5.0%");
  });
});
