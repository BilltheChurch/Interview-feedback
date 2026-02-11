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

interface IngestState {
  meeting_id: string;
  last_seq: number;
  received_chunks: number;
  duplicate_chunks: number;
  missing_chunks: number;
  bytes_stored: number;
  started_at: string;
  updated_at: string;
}

interface AudioChunkFrame {
  type: "chunk";
  meeting_id: string;
  seq: number;
  timestamp_ms: number;
  sample_rate: number;
  channels: number;
  format: "pcm_s16le";
  content_b64: string;
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

const RESOLVE_ROUTE_REGEX = /^\/v1\/sessions\/([^/]+)\/(resolve|state|finalize)$/;
const WS_INGEST_ROUTE_REGEX = /^\/v1\/audio\/ws\/([^/]+)$/;
const STORAGE_KEY_STATE = "state";
const STORAGE_KEY_EVENTS = "events";
const STORAGE_KEY_UPDATED_AT = "updated_at";
const STORAGE_KEY_INGEST_STATE = "ingest_state";
const STORAGE_KEY_FINALIZED_AT = "finalized_at";
const STORAGE_KEY_RESULT_KEY = "result_key";
const TARGET_FORMAT = "pcm_s16le";
const TARGET_SAMPLE_RATE = 16000;
const TARGET_CHANNELS = 1;
const ONE_SECOND_PCM_BYTES = 32000;

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

function safeObjectSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, "_");
}

function resultObjectKey(sessionId: string): string {
  return `sessions/${safeObjectSegment(sessionId)}/result.json`;
}

function chunkObjectKey(sessionId: string, seq: number): string {
  const seqPart = String(seq).padStart(8, "0");
  return `sessions/${safeObjectSegment(sessionId)}/chunks/${seqPart}.pcm`;
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

function isWebSocketRequest(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function decodeBase64ToBytes(contentB64: string): Uint8Array {
  const binary = atob(contentB64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseChunkFrame(value: unknown): AudioChunkFrame {
  if (!value || typeof value !== "object") {
    throw new Error("frame payload must be an object");
  }

  const frame = value as Partial<AudioChunkFrame>;
  if (frame.type !== "chunk") {
    throw new Error("frame.type must be chunk");
  }
  if (!frame.meeting_id || typeof frame.meeting_id !== "string") {
    throw new Error("frame.meeting_id is required");
  }
  if (!Number.isInteger(frame.seq) || Number(frame.seq) <= 0) {
    throw new Error("frame.seq must be a positive integer");
  }
  if (!Number.isFinite(frame.timestamp_ms) || Number(frame.timestamp_ms) <= 0) {
    throw new Error("frame.timestamp_ms must be a positive number");
  }
  if (frame.sample_rate !== TARGET_SAMPLE_RATE) {
    throw new Error(`frame.sample_rate must be ${TARGET_SAMPLE_RATE}`);
  }
  if (frame.channels !== TARGET_CHANNELS) {
    throw new Error(`frame.channels must be ${TARGET_CHANNELS}`);
  }
  if (frame.format !== TARGET_FORMAT) {
    throw new Error(`frame.format must be ${TARGET_FORMAT}`);
  }
  if (!frame.content_b64 || typeof frame.content_b64 !== "string") {
    throw new Error("frame.content_b64 is required");
  }

  return frame as AudioChunkFrame;
}

function buildIngestState(sessionId: string): IngestState {
  const now = new Date().toISOString();
  return {
    meeting_id: sessionId,
    last_seq: 0,
    received_chunks: 0,
    duplicate_chunks: 0,
    missing_chunks: 0,
    bytes_stored: 0,
    started_at: now,
    updated_at: now
  };
}

function ingestStatusPayload(sessionId: string, ingest: IngestState) {
  return {
    type: "status",
    session_id: sessionId,
    meeting_id: ingest.meeting_id,
    last_seq: ingest.last_seq,
    received_chunks: ingest.received_chunks,
    duplicate_chunks: ingest.duplicate_chunks,
    missing_chunks: ingest.missing_chunks,
    bytes_stored: ingest.bytes_stored,
    started_at: ingest.started_at,
    updated_at: ingest.updated_at
  };
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

async function proxyWebSocketToDO(request: Request, env: Env, sessionId: string): Promise<Response> {
  const id = env.MEETING_SESSION.idFromName(sessionId);
  const stub = env.MEETING_SESSION.get(id);

  const headers = new Headers(request.headers);
  headers.set("x-session-id", sessionId);

  return stub.fetch("https://do.internal/ingest-ws", {
    method: "GET",
    headers
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

    const wsMatch = path.match(WS_INGEST_ROUTE_REGEX);
    if (wsMatch) {
      const [, rawSessionId] = wsMatch;
      if (request.method !== "GET") {
        return jsonResponse({ detail: "method not allowed" }, 405);
      }
      if (!isWebSocketRequest(request)) {
        return jsonResponse({ detail: "websocket upgrade required" }, 426);
      }

      let sessionId: string;
      try {
        sessionId = safeSessionId(rawSessionId);
      } catch (error) {
        return badRequest((error as Error).message);
      }

      return proxyWebSocketToDO(request, env, sessionId);
    }

    const match = path.match(RESOLVE_ROUTE_REGEX);
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

  private sendWsJson(socket: WebSocket, payload: unknown): void {
    socket.send(JSON.stringify(payload));
  }

  private sendWsError(socket: WebSocket, detail: string): void {
    this.sendWsJson(socket, {
      type: "error",
      detail
    });
  }

  private async loadIngestState(sessionId: string): Promise<IngestState> {
    const current = await this.ctx.storage.get<IngestState>(STORAGE_KEY_INGEST_STATE);
    if (current) {
      return current;
    }
    const created = buildIngestState(sessionId);
    await this.ctx.storage.put(STORAGE_KEY_INGEST_STATE, created);
    return created;
  }

  private async storeIngestState(state: IngestState): Promise<void> {
    state.updated_at = new Date().toISOString();
    await this.ctx.storage.put(STORAGE_KEY_INGEST_STATE, state);
  }

  private async handleChunkFrame(sessionId: string, socket: WebSocket, frame: AudioChunkFrame): Promise<void> {
    const ingest = await this.loadIngestState(sessionId);
    if (ingest.meeting_id && ingest.meeting_id !== frame.meeting_id) {
      throw new Error(`meeting_id mismatch: expected ${ingest.meeting_id}`);
    }

    if (frame.seq <= ingest.last_seq) {
      ingest.duplicate_chunks += 1;
      await this.storeIngestState(ingest);
      this.sendWsJson(socket, {
        type: "ack",
        seq: frame.seq,
        status: "duplicate",
        last_seq: ingest.last_seq,
        missing_count: ingest.missing_chunks,
        duplicate_count: ingest.duplicate_chunks
      });
      return;
    }

    if (frame.seq > ingest.last_seq + 1) {
      ingest.missing_chunks += frame.seq - ingest.last_seq - 1;
    }

    const bytes = decodeBase64ToBytes(frame.content_b64);
    if (bytes.byteLength !== ONE_SECOND_PCM_BYTES) {
      throw new Error(`chunk byte length must be ${ONE_SECOND_PCM_BYTES}, got ${bytes.byteLength}`);
    }

    const key = chunkObjectKey(sessionId, frame.seq);
    await this.env.RESULT_BUCKET.put(key, bytes, {
      httpMetadata: {
        contentType: "application/octet-stream"
      },
      customMetadata: {
        session_id: sessionId,
        meeting_id: frame.meeting_id,
        seq: String(frame.seq),
        timestamp_ms: String(frame.timestamp_ms),
        sample_rate: String(frame.sample_rate),
        channels: String(frame.channels),
        format: frame.format
      }
    });

    ingest.last_seq = frame.seq;
    ingest.received_chunks += 1;
    ingest.bytes_stored += bytes.byteLength;
    await this.storeIngestState(ingest);

    this.sendWsJson(socket, {
      type: "ack",
      seq: frame.seq,
      status: "stored",
      key,
      last_seq: ingest.last_seq,
      missing_count: ingest.missing_chunks,
      duplicate_count: ingest.duplicate_chunks
    });
  }

  private async handleWebSocketRequest(request: Request, sessionId: string): Promise<Response> {
    if (!isWebSocketRequest(request)) {
      return jsonResponse({ detail: "websocket upgrade required" }, 426);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    let messageQueue: Promise<void> = Promise.resolve();

    server.addEventListener("message", (event) => {
      messageQueue = messageQueue
        .then(async () => {
          if (typeof event.data !== "string") {
            throw new Error("websocket frame must be text JSON");
          }

          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            throw new Error("websocket frame is not valid JSON");
          }

          if (!payload || typeof payload !== "object") {
            throw new Error("websocket frame must be an object");
          }

          const message = payload as Record<string, unknown>;
          const type = String(message.type ?? "");

          if (type === "hello") {
            const ingest = await this.loadIngestState(sessionId);
            this.sendWsJson(server, {
              type: "ready",
              session_id: sessionId,
              target_sample_rate: TARGET_SAMPLE_RATE,
              target_channels: TARGET_CHANNELS,
              target_format: TARGET_FORMAT,
              ingest: ingestStatusPayload(sessionId, ingest)
            });
            return;
          }

          if (type === "status") {
            const ingest = await this.loadIngestState(sessionId);
            this.sendWsJson(server, ingestStatusPayload(sessionId, ingest));
            return;
          }

          if (type === "ping") {
            this.sendWsJson(server, { type: "pong", ts: Date.now() });
            return;
          }

          if (type === "close") {
            const reason = String(message.reason ?? "client-close").slice(0, 120);
            this.sendWsJson(server, { type: "closing", reason });
            server.close(1000, reason);
            return;
          }

          if (type === "chunk") {
            const frame = parseChunkFrame(message);
            await this.handleChunkFrame(sessionId, server, frame);
            return;
          }

          throw new Error(`unsupported message type: ${type}`);
        })
        .catch((error: Error) => {
          this.sendWsError(server, error.message);
        });
    });

    server.addEventListener("close", () => {
      server.close();
    });

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.replace(/^\//, "");
    const sessionId = request.headers.get("x-session-id") ?? "unknown-session";

    if (action === "ingest-ws" && request.method === "GET") {
      return this.handleWebSocketRequest(request, sessionId);
    }

    if (action === "state" && request.method === "GET") {
      const [state, events, updatedAt, ingest] = await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<SessionEvent[]>(STORAGE_KEY_EVENTS),
        this.ctx.storage.get<string>(STORAGE_KEY_UPDATED_AT),
        this.ctx.storage.get<IngestState>(STORAGE_KEY_INGEST_STATE)
      ]);

      return jsonResponse({
        session_id: sessionId,
        state: state ?? DEFAULT_STATE,
        event_count: events?.length ?? 0,
        updated_at: updatedAt ?? null,
        ingest: ingest ? ingestStatusPayload(sessionId, ingest) : null
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

      const currentState = (await this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE)) ?? structuredClone(DEFAULT_STATE);
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

      const events = (await this.ctx.storage.get<SessionEvent[]>(STORAGE_KEY_EVENTS)) ?? [];
      events.push(event);

      await this.ctx.storage.put(STORAGE_KEY_STATE, resolved.updated_state);
      await this.ctx.storage.put(STORAGE_KEY_EVENTS, events);
      await this.ctx.storage.put(STORAGE_KEY_UPDATED_AT, new Date().toISOString());

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

      const [state, events, ingest] = await Promise.all([
        this.ctx.storage.get<SessionState>(STORAGE_KEY_STATE),
        this.ctx.storage.get<SessionEvent[]>(STORAGE_KEY_EVENTS),
        this.ctx.storage.get<IngestState>(STORAGE_KEY_INGEST_STATE)
      ]);

      const finalizedAt = new Date().toISOString();
      const result = {
        session_id: sessionId,
        finalized_at: finalizedAt,
        state: state ?? DEFAULT_STATE,
        events: events ?? [],
        ingest: ingest ? ingestStatusPayload(sessionId, ingest) : null,
        metadata: payload.metadata ?? {}
      };

      const key = resultObjectKey(sessionId);
      await this.env.RESULT_BUCKET.put(key, JSON.stringify(result), {
        httpMetadata: {
          contentType: "application/json"
        }
      });

      await this.ctx.storage.put(STORAGE_KEY_FINALIZED_AT, finalizedAt);
      await this.ctx.storage.put(STORAGE_KEY_RESULT_KEY, key);

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
