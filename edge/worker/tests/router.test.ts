import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleWorkerFetch } from "../src/router";
import type { Env } from "../src/config";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnv(overrides?: Partial<Env>): Env {
  return {
    WORKER_API_KEY: "", // dev mode — auth bypassed
    MEETING_SESSION: {
      idFromName: vi.fn().mockReturnValue({ toString: () => "do-id" }),
      get: vi.fn().mockReturnValue({
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      }),
    },
    RESULT_BUCKET: {
      get: vi.fn(),
      put: vi.fn(),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false, cursor: undefined }),
      delete: vi.fn(),
    },
    DB: undefined,
    ...overrides,
  } as unknown as Env;
}

function makeRequest(path: string, method = "GET", headers: Record<string, string> = {}): Request {
  return new Request(`https://worker.example.com${path}`, { method, headers });
}

// ── /health ───────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const req = makeRequest("/health");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
  });

  it("includes app name in response", async () => {
    const req = makeRequest("/health");
    const res = await handleWorkerFetch(req, makeEnv());
    const body = await res.json() as Record<string, unknown>;
    expect(typeof body.app).toBe("string");
  });

  it("does not require API key", async () => {
    const envWithKey = makeEnv({ WORKER_API_KEY: "secret-key" } as unknown as Partial<Env>);
    const req = makeRequest("/health"); // no x-api-key header
    const res = await handleWorkerFetch(req, envWithKey);
    // health check bypasses auth — should still return 200
    expect(res.status).toBe(200);
  });
});

// ── 404 for unknown routes ────────────────────────────────────────────────────

describe("unknown routes", () => {
  it("returns 404 for unrecognized path", async () => {
    const req = makeRequest("/unknown/route");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(404);
  });

  it("returns JSON error body for 404", async () => {
    const req = makeRequest("/not-a-real-endpoint");
    const res = await handleWorkerFetch(req, makeEnv());
    const body = await res.json() as Record<string, unknown>;
    expect(body.detail).toBeDefined();
  });

  it("returns 404 for /api/unknown", async () => {
    const req = makeRequest("/api/unknown");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(404);
  });
});

// ── /api/scheduling/webhook ────────────────────────────────────────────────────

describe("POST /api/scheduling/webhook", () => {
  it("returns 501 (not implemented)", async () => {
    const req = makeRequest("/api/scheduling/webhook", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(501);
  });

  it("returns phase 2 in body", async () => {
    const req = makeRequest("/api/scheduling/webhook", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    const body = await res.json() as Record<string, unknown>;
    expect(body.phase).toBe(2);
  });
});

// ── Method validation ─────────────────────────────────────────────────────────

describe("method validation — POST-only routes reject GET", () => {
  it("/v1/sessions/:id/resolve rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/resolve", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/finalize rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/finalize", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/asr-run rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/asr-run", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/config rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/config", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/export rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/export", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/cluster-map rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/cluster-map", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/feedback-open rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/feedback-open", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

describe("method validation — GET-only routes reject POST", () => {
  it("/v1/sessions/:id/state rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/state", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/utterances rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/utterances", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/result rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/result", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/events rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/events", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/unresolved-clusters rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/unresolved-clusters", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/feedback-ready rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/feedback-ready", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

describe("method validation — finalize-status is GET-only", () => {
  it("rejects POST to /v1/sessions/:id/finalize/status with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/finalize/status", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

describe("method validation — enrollment routes", () => {
  it("/v1/sessions/:id/enrollment/start rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/enrollment/start", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/enrollment/stop rejects GET with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/enrollment/stop", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/sessions/:id/enrollment/state rejects POST with 405", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/enrollment/state", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

// ── GDPR purge route ────────────────────────────────────────────────────────

describe("/v1/sessions/:id/data (GDPR purge)", () => {
  it("rejects GET with 405 (requires DELETE)", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/data", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("rejects POST with 405 (requires DELETE)", async () => {
    const req = makeRequest("/v1/sessions/sess-abc/data", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

// ── Auth gate ─────────────────────────────────────────────────────────────────

describe("auth gate", () => {
  it("returns 401 when WORKER_API_KEY is set but no key provided", async () => {
    const env = makeEnv({ WORKER_API_KEY: "super-secret" } as unknown as Partial<Env>);
    const req = makeRequest("/v1/sessions/sess-abc/state", "GET");
    const res = await handleWorkerFetch(req, env);
    expect(res.status).toBe(401);
  });

  it("passes auth with correct x-api-key header", async () => {
    const env = makeEnv({ WORKER_API_KEY: "super-secret" } as unknown as Partial<Env>);
    const req = makeRequest("/v1/sessions/sess-abc/state", "GET", { "x-api-key": "super-secret" });
    const res = await handleWorkerFetch(req, env);
    // Reaches DO proxy — returns mocked 200
    expect(res.status).toBe(200);
  });
});

// ── WebSocket routes reject non-upgrade ───────────────────────────────────────

describe("WebSocket ingest routes", () => {
  it("/v1/audio/ws/:id rejects non-WebSocket GET with 426", async () => {
    const req = makeRequest("/v1/audio/ws/sess-abc", "GET");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(426);
  });

  it("/v1/audio/ws/:id rejects POST with 405", async () => {
    const req = makeRequest("/v1/audio/ws/sess-abc", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });

  it("/v1/audio/ws/:id/:role rejects POST with 405", async () => {
    const req = makeRequest("/v1/audio/ws/sess-abc/teacher", "POST");
    const res = await handleWorkerFetch(req, makeEnv());
    expect(res.status).toBe(405);
  });
});

// ── D1 not configured ─────────────────────────────────────────────────────────

describe("D1 endpoints when DB not configured", () => {
  it("GET /v1/sessions returns 501 when DB is undefined", async () => {
    const env = makeEnv({ DB: undefined });
    const req = makeRequest("/v1/sessions", "GET");
    const res = await handleWorkerFetch(req, env);
    expect(res.status).toBe(501);
  });

  it("GET /v1/sessions/:id/scores returns 501 when DB is undefined", async () => {
    const env = makeEnv({ DB: undefined });
    const req = makeRequest("/v1/sessions/sess-abc/scores", "GET");
    const res = await handleWorkerFetch(req, env);
    expect(res.status).toBe(501);
  });
});
