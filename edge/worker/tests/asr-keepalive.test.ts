/**
 * asr-keepalive.test.ts — Unit tests for the shouldSendKeepalive pure helper.
 *
 * The decision logic is pure (no timers, no WS, no DO) so it can be exhaustively
 * unit-tested here. Timer / DO-alarm wiring and actual WS sends are integration
 * concerns validated by a live gate.
 */

import { describe, it, expect } from "vitest";
import { shouldSendKeepalive, makeSilencePcm16 } from "../src/asr-helpers";

describe("shouldSendKeepalive", () => {
  const INTERVAL = 5000;

  it("returns true when idle duration exactly equals the interval", () => {
    expect(shouldSendKeepalive(1000, 6000, INTERVAL)).toBe(true);
  });

  it("returns true when idle duration exceeds the interval", () => {
    expect(shouldSendKeepalive(1000, 7500, INTERVAL)).toBe(true);
  });

  it("returns false when a real frame was just sent (idle < interval)", () => {
    // Simulates: real audio chunk sent 2s ago, interval is 5s → no keepalive needed
    expect(shouldSendKeepalive(1000, 3000, INTERVAL)).toBe(false);
  });

  it("returns false when idle duration is just under the interval", () => {
    expect(shouldSendKeepalive(1000, 5999, INTERVAL)).toBe(false);
  });

  it("returns false when lastAudioMs equals nowMs (frame sent this instant)", () => {
    expect(shouldSendKeepalive(5000, 5000, INTERVAL)).toBe(false);
  });

  it("returns false when lastAudioMs is in the future (clock skew guard)", () => {
    expect(shouldSendKeepalive(9000, 8000, INTERVAL)).toBe(false);
  });

  it("uses the provided interval, not a hardcoded value", () => {
    // Different interval: 2000 ms
    expect(shouldSendKeepalive(1000, 3000, 2000)).toBe(true);
    expect(shouldSendKeepalive(1000, 2999, 2000)).toBe(false);
  });
});

describe("makeSilencePcm16", () => {
  it("returns a zero-filled buffer of the expected byte length", () => {
    // 100 ms of 16kHz mono PCM16: 16000 samples/s * 0.1 s * 2 bytes/sample = 3200 bytes
    const buf = makeSilencePcm16(100);
    expect(buf.byteLength).toBe(3200);
    // All bytes must be zero (silence = no signal)
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it("respects custom duration", () => {
    // 50 ms → 1600 bytes
    const buf = makeSilencePcm16(50);
    expect(buf.byteLength).toBe(1600);
  });
});
