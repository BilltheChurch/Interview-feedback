import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { log } from "../src/config";

describe("log()", () => {
  let consoleSpy: { log: ReturnType<typeof vi.spyOn>; warn: ReturnType<typeof vi.spyOn>; error: ReturnType<typeof vi.spyOn> };

  beforeEach(() => {
    consoleSpy = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("JSON output format", () => {
    it("outputs valid JSON on console.log for info level", () => {
      log("info", "test message");
      expect(consoleSpy.log).toHaveBeenCalledOnce();
      const output = consoleSpy.log.mock.calls[0][0] as string;
      expect(() => JSON.parse(output)).not.toThrow();
    });

    it("includes level, msg, and ts fields", () => {
      log("info", "hello world");
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toBe("hello world");
      expect(typeof parsed.ts).toBe("string");
    });

    it("ts is a valid ISO 8601 timestamp", () => {
      log("debug", "ts test");
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
    });
  });

  describe("log levels route to correct console method", () => {
    it("info → console.log", () => {
      log("info", "info msg");
      expect(consoleSpy.log).toHaveBeenCalledOnce();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it("debug → console.log", () => {
      log("debug", "debug msg");
      expect(consoleSpy.log).toHaveBeenCalledOnce();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it("warn → console.warn", () => {
      log("warn", "warn msg");
      expect(consoleSpy.warn).toHaveBeenCalledOnce();
      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it("error → console.error", () => {
      log("error", "error msg");
      expect(consoleSpy.error).toHaveBeenCalledOnce();
      expect(consoleSpy.log).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });
  });

  describe("extra fields", () => {
    it("includes extra object when provided", () => {
      log("info", "with extra", { sessionId: "sess-123", action: "finalize" });
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.extra).toEqual({ sessionId: "sess-123", action: "finalize" });
    });

    it("includes durationMs in extra when provided", () => {
      log("info", "timed action", { durationMs: 345, action: "drain" });
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.extra.durationMs).toBe(345);
      expect(parsed.extra.action).toBe("drain");
    });

    it("omits extra field when not provided", () => {
      log("info", "no extra");
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.extra).toBeUndefined();
    });

    it("omits extra field when empty object provided", () => {
      log("info", "empty extra", {});
      const output = consoleSpy.log.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.extra).toBeUndefined();
    });

    it("preserves nested extra values", () => {
      log("warn", "nested", { error: "timeout", retries: 3, meta: { stage: "drain" } });
      const output = consoleSpy.warn.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.extra.meta.stage).toBe("drain");
    });
  });

  describe("level field in output", () => {
    it.each(["debug", "info", "warn", "error"] as const)("level=%s is present in output", (level) => {
      log(level, `${level} message`);
      const spy = level === "error" ? consoleSpy.error : level === "warn" ? consoleSpy.warn : consoleSpy.log;
      const output = spy.mock.calls[0][0] as string;
      const parsed = JSON.parse(output);
      expect(parsed.level).toBe(level);
    });
  });
});
