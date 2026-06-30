/**
 * asr-backpressure.test.ts — Unit tests for the Speechmatics AudioAdded backpressure helpers.
 *
 * Backpressure tracks how many frames have been sent to Speechmatics vs how many
 * Speechmatics has acknowledged via AudioAdded{seq_no}. When the lag exceeds a window,
 * the drain loop skips the current pass (non-fatal, not a permanent stop) and waits
 * for acks to reduce lag before sending more.
 *
 * Only the pure decision helpers are unit-tested here. The actual wiring
 * (runtime.lastAckedSeq update, drain-loop throttle) is an integration concern.
 */

import { describe, it, expect } from "vitest";
import { backpressureLag, shouldThrottle } from "../src/asr-helpers";
import { parseSpeechmaticsMessage } from "../src/speechmatics-asr";

describe("backpressureLag", () => {
  it("returns the positive difference when sentSeq > ackedSeq", () => {
    expect(backpressureLag(5, 2)).toBe(3);
  });

  it("returns 0 when sentSeq < ackedSeq (floored, never negative)", () => {
    // Can happen at startup if acks arrive before sent counter catches up
    expect(backpressureLag(2, 5)).toBe(0);
  });

  it("returns 0 when sentSeq equals ackedSeq (fully caught up)", () => {
    expect(backpressureLag(5, 5)).toBe(0);
  });

  it("returns 0 when both are 0 (initial state)", () => {
    expect(backpressureLag(0, 0)).toBe(0);
  });

  it("returns correct lag for large values", () => {
    expect(backpressureLag(1000, 950)).toBe(50);
  });
});

describe("shouldThrottle", () => {
  it("returns true when lag exceeds the window", () => {
    expect(shouldThrottle(51, 50)).toBe(true);
  });

  it("returns false when lag exactly equals the window (at threshold = no throttle)", () => {
    expect(shouldThrottle(50, 50)).toBe(false);
  });

  it("returns false when lag is below the window", () => {
    expect(shouldThrottle(10, 50)).toBe(false);
  });

  it("returns false when lag is 0 (fully acked)", () => {
    expect(shouldThrottle(0, 50)).toBe(false);
  });

  it("returns true when window is 0 and any lag exists", () => {
    expect(shouldThrottle(1, 0)).toBe(true);
  });

  it("returns false when window is 0 and lag is 0", () => {
    expect(shouldThrottle(0, 0)).toBe(false);
  });
});

describe("parseSpeechmaticsMessage AudioAdded sanity", () => {
  it("parses AudioAdded and surfaces seq_no", () => {
    const raw = JSON.stringify({ message: "AudioAdded", seq_no: 42 });
    const msg = parseSpeechmaticsMessage(raw);
    expect(msg).toMatchObject({ type: "AudioAdded", seq_no: 42 });
  });
});

describe("per-connection counter reset (deadlock avoidance)", () => {
  // Speechmatics restarts seq_no at 1 on every StartRecognition. The runtime must
  // reset both the send counter and the ack counter on each new WS connection
  // (verified by the connect/teardown wiring). This documents WHY: if the counters
  // carried over, the new connection's small acks could never catch up and the lag
  // would never fall below the window → permanent throttle. After a reset to 0, a
  // fresh send/ack pair yields a small bounded lag that drops back to 0 on ack.
  it("yields bounded lag that clears after acks once counters reset to 0", () => {
    // Pre-reset (stale) high-water values from a previous connection.
    let sent = 1200;
    let acked = 1180;
    // New connection established → both reset to 0.
    sent = 0;
    acked = 0;
    expect(backpressureLag(sent, acked)).toBe(0);
    expect(shouldThrottle(backpressureLag(sent, acked), 50)).toBe(false);

    // Send 3 frames before any ack on the fresh connection.
    sent = 3;
    expect(backpressureLag(sent, acked)).toBe(3);
    expect(shouldThrottle(backpressureLag(sent, acked), 50)).toBe(false);

    // Acks arrive (small seq_no on the new connection) → lag clears.
    acked = 3;
    expect(backpressureLag(sent, acked)).toBe(0);
  });
});
