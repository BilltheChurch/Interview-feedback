import { DurableObject } from "cloudflare:workers";

interface AudioPayload {
  content_b64: string;
  format: "wav" | "pcm_s16le" | "mp3" | "m4a" | "ogg" | "flac";
  sample_rate?: number;
  channels?: number;
}

interface RosterEntry {
  name: string;
  email?: string | null;
}

interface ResolveRequest {
  audio: AudioPayload;
  asr_text?: string | null;
  roster?: RosterEntry[];
}

interface ClusterState {
  cluster_id: string;
  centroid: number[];
  sample_count: number;
  bound_name?: string | null;
}

interface SessionState {
  clusters: ClusterState[];
  bindings: Record<string, string>;
  roster?: RosterEntry[];
  config: Record<string, string | number | boolean>;
}

interface ResolveEvidence {
  sv_score: number;
  threshold_low: number;
  threshold_high: number;
  segment_count: number;
  name_hit?: string | null;
  roster_hit?: boolean | null;
}

interface ResolveResponse {
  session_id: string;
  cluster_id: string;
  speaker_name?: string | null;
  decision: "auto" | "confirm" | "unknown";
  evidence: ResolveEvidence;
  updated_state: SessionState;
}

interface SessionEvent {
  ts: string;
  cluster_id: string;
  speaker_name?: string | null;
  decision: "auto" | "confirm" | "unknown";
  evidence: ResolveEvidence;
}

interface FinalizeRequest {
  metadata?: Record<string, unknown>;
}

interface Env {
  INFERENCE_BASE_URL: string;
  INFERENCE_API_KEY?: string;
  INFERENCE_TIMEOUT_MS?: string;
  INFERENCE_RESOLVE_PATH?: string;
  RESULT_BUCKET: R2Bucket;
  MEETING_SESSION: DurableObjectNamespace<MeetingSessionDO>;
}

const DEFAULT_STATE: SessionState = {
  clusters: [],
  bindings: {},
  config: {}
};

const ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/(resolve|state|finalize)$/;

function jsonResponse(payload: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers
    }
  });
}

function badRequest(detail: string): Response {
  return jsonResponse({ detail }, 400);
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function safeSessionId(raw: string): string {
  const decoded = decodeURIComponent(raw);
  if (!decoded || decoded.length > 128) {
    throw new Error("session_id must be 1..128 chars");
  }
  return decoded;
}

function resultObjectKey(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return `sessions/${safe}/result.json`;
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function parseTimeoutMs(raw: string | undefined): number {
  const timeout = Number(raw ?? "15000");
  if (!Number.isFinite(timeout) || timeout <= 0) {
    return 15000;
  }
  return timeout;
}

async function proxyToDO(request: Request, env: Env, sessionId: string, action: string): Promise<Response> {
  const id = env.MEETING_SESSION.idFromName(sessionId);
  const stub = env.MEETING_SESSION.get(id);

  const headers = new Headers();
  const idemKey = request.headers.get("x-idempotency-key");
  if (idemKey) {
    headers.set("x-idempotency-key", idemKey);
  }
  headers.set("x-session-id", sessionId);

  let body: string | undefined;
  if (request.method !== "GET" && request.method !== "HEAD") {
    body = await request.text();
    headers.set("content-type", "application/json");
  }

  return stub.fetch("https://do.internal/" + action, {
    method: request.method,
    headers,
    body
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && request.method === "GET") {
      return jsonResponse({
        status: "ok",
        app: "interview-feedback-gateway",
        durable_object: "MEETING_SESSION",
        r2_bucket: "RESULT_BUCKET"
      });
    }

    const match = path.match(ROUTE_REGEX);
    if (!match) {
      return jsonResponse({ detail: "route not found" }, 404);
    }

    const [, rawSessionId, action] = match;

    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      return badRequest((error as Error).message);
    }

    if (action === "resolve" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "state" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "finalize" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }

    return proxyToDO(request, env, sessionId, action);
  }
};

export class MeetingSessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");
    const sessionId = request.headers.get("x-session-id") ?? "unknown-session";

    if (action === "state" && request.method === "GET") {
      const [state, events, updatedAt] = await Promise.all([
        this.ctx.storage.get<SessionState>("state"),
        this.ctx.storage.get<SessionEvent[]>("events"),
        this.ctx.storage.get<string>("updated_at")
      ]);

      return jsonResponse({
        session_id: sessionId,
        state: state ?? DEFAULT_STATE,
        event_count: events?.length ?? 0,
        updated_at: updatedAt ?? null
      });
    }

    if (action === "resolve" && request.method === "POST") {
      const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
      if (idempotencyKey) {
        const cached = await this.ctx.storage.get<ResolveResponse>(`idempotency:${idempotencyKey}`);
        if (cached) {
          return jsonResponse(cached, 200, { "x-idempotent-replay": "true" });
        }
      }

      let payload: ResolveRequest;
      try {
        payload = await readJson<ResolveRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      if (!payload?.audio?.content_b64 || !payload?.audio?.format) {
        return badRequest("audio.content_b64 and audio.format are required");
      }

      const currentState = (await this.ctx.storage.get<SessionState>("state")) ?? structuredClone(DEFAULT_STATE);
      if (payload.roster && payload.roster.length > 0) {
        currentState.roster = payload.roster;
      }

      const resolvePath = this.env.INFERENCE_RESOLVE_PATH ?? "/speaker/resolve";
      const baseUrl = normalizeBaseUrl(this.env.INFERENCE_BASE_URL);
      const timeoutMs = parseTimeoutMs(this.env.INFERENCE_TIMEOUT_MS);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      let inferenceResponse: Response;
      try {
        inferenceResponse = await fetch(baseUrl + resolvePath, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.env.INFERENCE_API_KEY
              ? { "x-api-key": this.env.INFERENCE_API_KEY }
              : {})
          },
          body: JSON.stringify({
            session_id: sessionId,
            audio: payload.audio,
            asr_text: payload.asr_text ?? null,
            state: currentState
          }),
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timeout);
        return jsonResponse({ detail: `inference request failed: ${(error as Error).message}` }, 502);
      }
      clearTimeout(timeout);

      const inferenceText = await inferenceResponse.text();
      if (!inferenceResponse.ok) {
        return jsonResponse(
          {
            detail: "inference backend returned non-success status",
            backend_status: inferenceResponse.status,
            backend_body: inferenceText
          },
          502
        );
      }

      let resolved: ResolveResponse;
      try {
        resolved = JSON.parse(inferenceText) as ResolveResponse;
      } catch {
        return jsonResponse({ detail: "inference backend returned non-JSON response" }, 502);
      }

      const event: SessionEvent = {
        ts: new Date().toISOString(),
        cluster_id: resolved.cluster_id,
        speaker_name: resolved.speaker_name ?? null,
        decision: resolved.decision,
        evidence: resolved.evidence
      };

      const events = (await this.ctx.storage.get<SessionEvent[]>("events")) ?? [];
      events.push(event);

      await this.ctx.storage.put("state", resolved.updated_state);
      await this.ctx.storage.put("events", events);
      await this.ctx.storage.put("updated_at", new Date().toISOString());

      if (idempotencyKey) {
        await this.ctx.storage.put(`idempotency:${idempotencyKey}`, resolved);
      }

      return jsonResponse(resolved);
    }

    if (action === "finalize" && request.method === "POST") {
      let payload: FinalizeRequest = {};
      try {
        payload = await readJson<FinalizeRequest>(request);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      const [state, events] = await Promise.all([
        this.ctx.storage.get<SessionState>("state"),
        this.ctx.storage.get<SessionEvent[]>("events")
      ]);

      const finalizedAt = new Date().toISOString();
      const result = {
        session_id: sessionId,
        finalized_at: finalizedAt,
        state: state ?? DEFAULT_STATE,
        events: events ?? [],
        metadata: payload.metadata ?? {}
      };

      const key = resultObjectKey(sessionId);
      await this.env.RESULT_BUCKET.put(key, JSON.stringify(result), {
        httpMetadata: {
          contentType: "application/json"
        }
      });

      await this.ctx.storage.put("finalized_at", finalizedAt);
      await this.ctx.storage.put("result_key", key);

      return jsonResponse({
        session_id: sessionId,
        result_key: key,
        event_count: (events ?? []).length,
        finalized_at: finalizedAt
      });
    }

    return jsonResponse({ detail: "route not found" }, 404);
  }
}
