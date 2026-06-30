/**
 * Tests for interview mode parsing from the WebSocket hello frame.
 *
 * The worker's updateSessionConfigFromHello method reads `message.mode` via
 * valueAsString, then only accepts the exact values "1v1" or "group".
 * This file locks that contract.
 */
import { describe, it, expect } from "vitest";
import { valueAsString } from "../src/config";

// Mirror the acceptance predicate from updateSessionConfigFromHello so the test
// is self-contained and doesn't need to spin up a Durable Object.
function parseModeFromHello(message: Record<string, unknown>): "1v1" | "group" | null {
  const raw = valueAsString(message.mode);
  if (raw === "1v1" || raw === "group") return raw;
  return null;
}

describe("hello frame mode parsing (P1 contract)", () => {
  it('accepts mode "group" and returns "group"', () => {
    expect(parseModeFromHello({ mode: "group" })).toBe("group");
  });

  it('accepts mode "1v1" and returns "1v1"', () => {
    expect(parseModeFromHello({ mode: "1v1" })).toBe("1v1");
  });

  it("returns null when mode field is absent", () => {
    expect(parseModeFromHello({})).toBeNull();
  });

  it("returns null when mode is undefined", () => {
    expect(parseModeFromHello({ mode: undefined })).toBeNull();
  });

  it("returns null when mode is null", () => {
    expect(parseModeFromHello({ mode: null })).toBeNull();
  });

  it('ignores invalid string value "panel"', () => {
    expect(parseModeFromHello({ mode: "panel" })).toBeNull();
  });

  it("ignores numeric mode value", () => {
    expect(parseModeFromHello({ mode: 1 })).toBeNull();
  });

  it("ignores empty string mode", () => {
    expect(parseModeFromHello({ mode: "" })).toBeNull();
  });

  it("ignores whitespace-only mode", () => {
    expect(parseModeFromHello({ mode: "  " })).toBeNull();
  });

  it("accepts mode with surrounding whitespace (valueAsString trims)", () => {
    // valueAsString trims — "  group  " → "group" which matches
    expect(parseModeFromHello({ mode: "  group  " })).toBe("group");
  });

  it("state.config.mode should not be overwritten when hello has no mode", () => {
    // Simulate the conditional write: only set mode when parseModeFromHello returns non-null
    const config: Record<string, unknown> = { mode: "group" };
    const parsed = parseModeFromHello({});
    if (parsed !== null) config.mode = parsed;
    // Mode unchanged because hello frame had no mode
    expect(config.mode).toBe("group");
  });

  it("state.config.mode is overwritten when hello supplies valid mode", () => {
    const config: Record<string, unknown> = { mode: "group" };
    const parsed = parseModeFromHello({ mode: "1v1" });
    if (parsed !== null) config.mode = parsed;
    expect(config.mode).toBe("1v1");
  });
});
