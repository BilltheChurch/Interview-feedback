import { describe, it, expect } from "vitest";
import { validateApiKey } from "../src/auth";

function makeRequest(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
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

  describe("valid API key", () => {
    it("accepts key via x-api-key header", () => {
      const req = makeRequest("https://example.com/session", {
        "x-api-key": SECRET,
      });
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });

    it("accepts key via api_key query param (for WebSocket upgrade)", () => {
      const req = makeRequest(
        `https://example.com/session?api_key=${SECRET}`
      );
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });

    it("prefers header over query param when both provided", () => {
      const req = makeRequest(
        `https://example.com/session?api_key=wrong-key`,
        { "x-api-key": SECRET }
      );
      const result = validateApiKey(req, { WORKER_API_KEY: SECRET });
      expect(result).toBeNull();
    });
  });

  describe("invalid API key", () => {
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
