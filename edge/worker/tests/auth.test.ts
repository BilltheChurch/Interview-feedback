import { describe, it, expect } from "vitest";
import { validateApiKey, validateWsAuthFrame } from "../src/auth";

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

function makeWsRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers: { upgrade: "websocket", ...headers } });
}

describe("validateApiKey", () => {
  const SECRET = "sk-test-secret-key-12345";

  describe("dev mode (no WORKER_API_KEY configured)", () => {
    it("returns null when WORKER_API_KEY is empty string", () => {
      const req = makeRequest("https://example.com/session");
      const result = validateApiKey(req, { WORKER_API_KEY: "" });
      expect(result).toBeNull();
    });

    it("returns null when WORKER_API_KEY is undefined", () => {
      const req = makeRequest("https://example.com/session");
      const result = validateApiKey(req, {});
      expect(result).toBeNull();
    });
  });

  describe("valid API key (HTTP endpoints)", () => {
    it("accepts key via x-api-key header", () => {
      const req = makeRequest("https://example.com/session", {
        "x-api-key": SECRET,
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });
  });

  describe("WebSocket upgrade requests skip HTTP-level auth", () => {
    it("returns null for WebSocket upgrade even without x-api-key (auth deferred to first WS frame)", () => {
      const req = makeWsRequest("https://example.com/v1/audio/ws/session-1/teacher");
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });

    it("returns null for WebSocket upgrade with wrong x-api-key (auth deferred to first WS frame)", () => {
      const req = makeWsRequest("https://example.com/v1/audio/ws/session-1/teacher", {
        "x-api-key": "wrong-key",
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });
  });

  describe("invalid API key (HTTP endpoints)", () => {
    it("returns 401 when no key is provided", () => {
      const req = makeRequest("https://example.com/session");
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns 401 when key is wrong", () => {
      const req = makeRequest("https://example.com/session", {
        "x-api-key": "wrong-key",
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("returns JSON error body with detail field", async () => {
      const req = makeRequest("https://example.com/session", {
        "x-api-key": "wrong-key",
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).not.toBeNull();
      const body = await result!.json();
      expect(body).toEqual({ detail: "unauthorized" });
    });

    it("rejects key that differs by one character", () => {
      const almostRight = SECRET.slice(0, -1) + "X";
      const req = makeRequest("https://example.com/session", {
        "x-api-key": almostRight,
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });

    it("rejects key of different length", () => {
      const req = makeRequest("https://example.com/session", {
        "x-api-key": "short",
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).not.toBeNull();
      expect(result!.status).toBe(401);
    });
  });
});

describe("validateWsAuthFrame", () => {
  const SECRET = "sk-test-secret-key-12345";

  describe("dev mode (no WORKER_API_KEY configured)", () => {
    it("returns true when WORKER_API_KEY is empty string (dev mode)", () => {
      const result = validateWsAuthFrame({ type: "auth", key: "" }, { WORKER_API_KEY: "" });
      expect(result).toBe(true);
    });

    it("returns true when WORKER_API_KEY is undefined (dev mode)", () => {
      const result = validateWsAuthFrame({ type: "auth", key: "anything" }, {});
      expect(result).toBe(true);
    });
  });

  describe("valid auth frame", () => {
    it("returns true when type=auth and key matches", () => {
      const result = validateWsAuthFrame({ type: "auth", key: SECRET }, { WORKER_API_KEY: SECRET });
      expect(result).toBe(true);
    });
  });

  describe("invalid auth frame", () => {
    it("returns false when type is not auth", () => {
      const result = validateWsAuthFrame({ type: "hello", key: SECRET }, { WORKER_API_KEY: SECRET });
      expect(result).toBe(false);
    });

    it("returns false when key is wrong", () => {
      const result = validateWsAuthFrame({ type: "auth", key: "wrong-key" }, { WORKER_API_KEY: SECRET });
      expect(result).toBe(false);
    });

    it("returns false when key is missing", () => {
      const result = validateWsAuthFrame({ type: "auth" }, { WORKER_API_KEY: SECRET });
      expect(result).toBe(false);
    });

    it("returns false when key differs by one character", () => {
      const almostRight = SECRET.slice(0, -1) + "X";
      const result = validateWsAuthFrame({ type: "auth", key: almostRight }, { WORKER_API_KEY: SECRET });
      expect(result).toBe(false);
    });

    it("returns false for empty frame", () => {
      const result = validateWsAuthFrame({}, { WORKER_API_KEY: SECRET });
      expect(result).toBe(false);
    });
  });
});
