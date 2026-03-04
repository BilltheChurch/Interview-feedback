/**
 * websocket-handler.ts — WebSocket message parsing and dispatch for ingest sessions.
 *
 * Extracts the message routing logic from MeetingSessionDO.handleWebSocketRequest.
 * The DO class implements the WsHandlerContext interface and delegates to
 * dispatchWsMessage, keeping the handler testable and independent of DO internals.
 *
 * WS protocol messages handled:
 *  - hello        — session init, role validation, config update
 *  - status       — ingest status query
 *  - ping         — keepalive (responds with pong)
 *  - capture_status — audio capture state update
 *  - caption      — ACS Teams caption event (Final only)
 *  - session_config — captionSource configuration
 *  - close        — graceful close with ASR teardown
 *  - chunk        — binary PCM audio frame (base64-encoded in JSON)
 */

import {
  parseStreamRole,
  parseCaptureStatusPayload,
  parseChunkFrame,
  ingestStatusPayload,
  isWebSocketRequest,
  jsonResponse,
  log,
  getErrorMessage,
  WS_CLOSE_REASON_MAX_LEN,
  STORAGE_KEY_CAPTION_SOURCE,
  TARGET_FORMAT,
  type StreamRole,
  type IngestState
} from "./config";
import { TARGET_SAMPLE_RATE, TARGET_CHANNELS } from "./audio-utils";
import { validateWsAuthFrame } from "./auth";
import type { CaptionSource } from "./types_v2";
import type { CaptionEvent } from "./providers/types";

/**
 * Minimal context interface the DO class must satisfy to handle WS messages.
 * Keeps the handler decoupled from the full MeetingSessionDO class.
 */
export interface WsHandlerContext {
  /** In-memory session start timestamp (ms). 0 = not yet initialized. */
  sessionStartMs: number;
  /** In-memory caption source mode for this session. */
  captionSource: CaptionSource;
  /** In-memory caption event buffer. */
  captionBuffer: CaptionEvent[];

  /** Send a JSON payload over the WebSocket. */
  sendWsJson(socket: WebSocket, payload: unknown): void;
  /** Send an error frame over the WebSocket. */
  sendWsError(socket: WebSocket, detail: string): void;

  /** Serialize a mutation against DO state. */
  enqueueMutation<T>(fn: () => Promise<T>): Promise<T>;

  /** Transition session phase (e.g. idle → recording on first hello). */
  setSessionPhase(phase: "recording"): Promise<unknown>;

  /** Update session config fields from a hello message. */
  updateSessionConfigFromHello(message: Record<string, unknown>): Promise<void>;

  /** Load ingest state for all streams. */
  loadIngestByStream(sessionId: string): Promise<Record<StreamRole, IngestState>>;

  /** Build the ingest_by_stream payload shape for WS responses. */
  ingestByStreamPayload(sessionId: string, ingestByStream: Record<StreamRole, IngestState>): unknown;

  /** Apply a capture_status frame to storage and return stored state. */
  applyCaptureStatus(sessionId: string, frameRole: StreamRole, payload: unknown): Promise<unknown>;

  /** Schedule a batched flush of caption buffer to storage. */
  scheduleCaptionFlush(): void;

  /** Persist captionSource to storage (fire-and-forget). */
  persistCaptionSource(sessionId: string, src: CaptionSource): void;

  /** Close the realtime ASR session for a stream. */
  closeRealtimeAsrSession(role: StreamRole, reason: string, clearQueue: boolean): Promise<void>;

  /** Refresh ASR stream metrics after a close. */
  refreshAsrStreamMetrics(sessionId: string, role: StreamRole): Promise<void>;

  /** Check if realtime ASR is enabled. */
  asrRealtimeEnabled(): boolean;

  /** Handle a chunk frame (audio ingest). */
  handleChunkFrame(
    sessionId: string,
    connectionRole: StreamRole,
    server: WebSocket,
    frame: ReturnType<typeof parseChunkFrame>
  ): Promise<void>;
}

/**
 * Dispatch a single parsed WS message to the appropriate handler.
 * Returns true if the message was handled, false if the type is unknown.
 * Throws on validation errors (caller should catch and sendWsError).
 */
export async function dispatchWsMessage(
  ctx: WsHandlerContext,
  server: WebSocket,
  sessionId: string,
  connectionRole: StreamRole,
  message: Record<string, unknown>
): Promise<void> {
  const type = String(message.type ?? "");

  if (type === "hello") {
    const helloRole = message.stream_role
      ? parseStreamRole(String(message.stream_role), connectionRole)
      : connectionRole;
    if (helloRole !== connectionRole) {
      throw new Error(`hello.stream_role mismatch: expected ${connectionRole}, got ${helloRole}`);
    }
    if (ctx.sessionStartMs === 0) {
      ctx.sessionStartMs = Date.now();
      await ctx.setSessionPhase("recording");
    }
    await ctx.updateSessionConfigFromHello(message);

    const ingestByStream = await ctx.loadIngestByStream(sessionId);
    ctx.sendWsJson(server, {
      type: "ready",
      session_id: sessionId,
      stream_role: connectionRole,
      target_sample_rate: TARGET_SAMPLE_RATE,
      target_channels: TARGET_CHANNELS,
      target_format: TARGET_FORMAT,
      ingest: ingestStatusPayload(sessionId, connectionRole, ingestByStream[connectionRole]),
      ingest_by_stream: ctx.ingestByStreamPayload(sessionId, ingestByStream)
    });
    return;
  }

  if (type === "status") {
    const ingestByStream = await ctx.loadIngestByStream(sessionId);
    ctx.sendWsJson(server, {
      ...ingestStatusPayload(sessionId, connectionRole, ingestByStream[connectionRole]),
      ingest_by_stream: ctx.ingestByStreamPayload(sessionId, ingestByStream)
    });
    return;
  }

  if (type === "ping") {
    ctx.sendWsJson(server, { type: "pong", ts: Date.now(), stream_role: connectionRole });
    return;
  }

  if (type === "capture_status") {
    const parsed = parseCaptureStatusPayload(message);
    const frameRole = parsed.stream_role ?? connectionRole;
    if (frameRole !== connectionRole) {
      throw new Error(`capture_status.stream_role mismatch: expected ${connectionRole}, got ${frameRole}`);
    }
    const stored = await ctx.applyCaptureStatus(sessionId, frameRole, parsed.payload);
    ctx.sendWsJson(server, {
      type: "capture_status_ack",
      stream_role: frameRole,
      payload: stored
    });
    return;
  }

  if (type === "caption") {
    const resultType = String(message.resultType ?? "");
    if (resultType === "Final") {
      const rawTs = Number(message.timestamp ?? 0);
      const timestampMs = Number.isFinite(rawTs) ? rawTs - ctx.sessionStartMs : 0;
      ctx.captionBuffer.push({
        speaker: String(message.speaker ?? ""),
        text: String(message.text ?? ""),
        language: String(message.language ?? ""),
        timestamp_ms: timestampMs,
        teamsUserId: message.teamsUserId ? String(message.teamsUserId) : undefined
      });
      ctx.scheduleCaptionFlush();
    }
    return;
  }

  if (type === "session_config") {
    const src = String(message.captionSource ?? "");
    if (src === "acs-teams" || src === "none") {
      ctx.captionSource = src as CaptionSource;
      ctx.persistCaptionSource(sessionId, src as CaptionSource);
    }
    return;
  }

  if (type === "close") {
    const reason = String(message.reason ?? "client-close").slice(0, WS_CLOSE_REASON_MAX_LEN);
    if (ctx.asrRealtimeEnabled()) {
      await ctx.closeRealtimeAsrSession(connectionRole, `client-close:${reason}`, false);
      await ctx.refreshAsrStreamMetrics(sessionId, connectionRole);
    }
    ctx.sendWsJson(server, { type: "closing", reason, stream_role: connectionRole });
    server.close(1000, reason);
    return;
  }

  if (type === "chunk") {
    const frame = parseChunkFrame(message);
    const frameRole = frame.stream_role ?? connectionRole;
    if (frameRole !== connectionRole) {
      throw new Error(`chunk.stream_role mismatch: expected ${connectionRole}, got ${frameRole}`);
    }
    await ctx.handleChunkFrame(sessionId, connectionRole, server, frame);
    return;
  }

  throw new Error(`unsupported message type: ${type}`);
}

/**
 * Parse a raw WebSocket event.data string into a message object.
 * Throws on parse errors (caller should catch and sendWsError).
 */
export function parseWsFrame(data: unknown): Record<string, unknown> {
  if (typeof data !== "string") {
    throw new Error("websocket frame must be text JSON");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("websocket frame is not valid JSON");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("websocket frame must be an object");
  }
  return payload as Record<string, unknown>;
}

/**
 * Set up a WebSocket server with message, close, and error handlers.
 * The DO class calls this instead of wiring event listeners manually.
 *
 * @returns the client socket for the 101 response
 */
export function setupWebSocketPair(
  ctx: WsHandlerContext,
  sessionId: string,
  connectionRole: StreamRole,
  env: Record<string, unknown>
): { client: WebSocket; server: WebSocket } {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();

  // First-message auth gate. True once auth frame is validated.
  let authenticated = false;

  // Auth timeout: close connection if no auth frame within 10 seconds.
  const authTimeoutMs = 10_000;
  const authTimer = setTimeout(() => {
    if (!authenticated) {
      ctx.sendWsError(server, "auth timeout");
      server.close(4401, "auth timeout");
    }
  }, authTimeoutMs);

  let messageQueue: Promise<void> = Promise.resolve();

  server.addEventListener("message", (event) => {
    messageQueue = messageQueue
      .then(() =>
        ctx.enqueueMutation(async () => {
          const message = parseWsFrame(event.data);

          // Validate first message as auth frame before any normal dispatch.
          if (!authenticated) {
            if (!validateWsAuthFrame(message, env)) {
              ctx.sendWsError(server, "unauthorized");
              server.close(4401, "unauthorized");
              return;
            }
            authenticated = true;
            clearTimeout(authTimer);
            ctx.sendWsJson(server, { type: "auth_ok" });
            return;
          }

          await dispatchWsMessage(ctx, server, sessionId, connectionRole, message);
        })
      )
      .catch((error: Error) => {
        ctx.sendWsError(server, error.message);
      });
  });

  server.addEventListener("close", () => {
    clearTimeout(authTimer);
    if (ctx.asrRealtimeEnabled()) {
      ctx
        .closeRealtimeAsrSession(connectionRole, "ingest-ws-closed", false)
        .then(() => ctx.refreshAsrStreamMetrics(sessionId, connectionRole))
        .catch((err) => {
          log("warn", "ws-close: ASR teardown error", {
            component: "ws-handler",
            error: getErrorMessage(err)
          });
        });
    }
    server.close();
  });

  return { client, server };
}

/**
 * Handle the full WebSocket upgrade request.
 * Returns a 426 if not a WS request, or a 101 WebSocket response.
 * Auth is NOT performed at the HTTP upgrade level — it is deferred to the
 * first WebSocket message frame (see setupWebSocketPair).
 */
export function handleWebSocketUpgrade(
  ctx: WsHandlerContext,
  request: Request,
  sessionId: string,
  connectionRole: StreamRole,
  env: Record<string, unknown>
): Response {
  if (!isWebSocketRequest(request)) {
    return jsonResponse({ detail: "websocket upgrade required" }, 426);
  }

  const { client } = setupWebSocketPair(ctx, sessionId, connectionRole, env);

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
