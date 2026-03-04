/**
 * router.ts — HTTP request routing for the edge worker.
 *
 * Contains the top-level `fetch()` handler (the Worker entry point logic)
 * and the proxy helpers that forward requests to the Durable Object.
 */

import { validateApiKey } from "./auth";
import {
  type Env,
  type StreamRole,
  type HistoryIndexItem,
  jsonResponse,
  badRequest,
  safeSessionId,
  parseStreamRole,
  isWebSocketRequest,
  SESSION_ROUTE_REGEX,
  SESSION_ENROLL_ROUTE_REGEX,
  SESSION_FINALIZE_STATUS_ROUTE_REGEX,
  SESSION_TIER2_STATUS_ROUTE_REGEX,
  SESSION_INCREMENTAL_STATUS_ROUTE_REGEX,
  SESSION_HISTORY_ROUTE_REGEX,
  SESSION_PURGE_ROUTE_REGEX,
  WS_INGEST_ROUTE_REGEX,
  WS_INGEST_ROLE_ROUTE_REGEX,
  HISTORY_PREFIX,
  HISTORY_MAX_LIMIT
} from "./config";

export async function proxyToDO(request: Request, env: Env, sessionId: string, action: string): Promise<Response> {
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

  const query = new URL(request.url).search;
  return stub.fetch("https://do.internal/" + action + query, {
    method: request.method,
    headers,
    body
  });
}

export async function proxyWebSocketToDO(
  request: Request,
  env: Env,
  sessionId: string,
  streamRole: StreamRole
): Promise<Response> {
  const id = env.MEETING_SESSION.idFromName(sessionId);
  const stub = env.MEETING_SESSION.get(id);

  const headers = new Headers(request.headers);
  headers.set("x-session-id", sessionId);
  headers.set("x-stream-role", streamRole);

  return stub.fetch("https://do.internal/ingest-ws", {
    method: "GET",
    headers
  });
}

export async function handleWorkerFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health" && request.method === "GET") {
    return jsonResponse({ status: "ok", app: "interview-feedback-gateway" });
  }

  // ── Scheduling webhook placeholder (Phase 2: DualSync integration) ──
  if (path === "/api/scheduling/webhook" && request.method === "POST") {
    return jsonResponse({ detail: "not implemented", phase: 2 }, 501);
  }

  // ── Auth gate (skipped for /health, skipped when WORKER_API_KEY is empty) ──
  const authError = validateApiKey(request, env as unknown as Record<string, unknown>);
  if (authError) return authError;

  const wsRoleMatch = path.match(WS_INGEST_ROLE_ROUTE_REGEX);
  if (wsRoleMatch) {
    const [, rawSessionId, rawRole] = wsRoleMatch;
    if (request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (!isWebSocketRequest(request)) {
      return jsonResponse({ detail: "websocket upgrade required" }, 426);
    }

    let sessionId: string;
    let streamRole: StreamRole;
    try {
      sessionId = safeSessionId(rawSessionId);
      streamRole = parseStreamRole(rawRole, "mixed");
    } catch (error) {
      console.error("ws-ingest-v2 session/role parse error:", error);
      return badRequest("Request processing failed");
    }

    return proxyWebSocketToDO(request, env, sessionId, streamRole);
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
      console.error("ws-ingest session parse error:", error);
      return badRequest("Request processing failed");
    }

    return proxyWebSocketToDO(request, env, sessionId, "mixed");
  }

  // ── GDPR: Delete all session data ──
  const purgeMatch = path.match(SESSION_PURGE_ROUTE_REGEX);
  if (purgeMatch) {
    const [, rawSessionId] = purgeMatch;
    if (request.method !== "DELETE") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      console.error("purge-data session parse error:", error);
      return badRequest("Request processing failed");
    }
    return proxyToDO(request, env, sessionId, "purge-data");
  }

  const enrollMatch = path.match(SESSION_ENROLL_ROUTE_REGEX);
  if (enrollMatch) {
    const [, rawSessionId, enrollAction] = enrollMatch;
    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      console.error("enrollment session parse error:", error);
      return badRequest("Request processing failed");
    }

    const action = `enrollment-${enrollAction}`;
    if (action === "enrollment-start" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "enrollment-stop" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "enrollment-state" && request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    if (action === "enrollment-profiles" && request.method !== "POST") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    return proxyToDO(request, env, sessionId, action);
  }

  const finalizeStatusMatch = path.match(SESSION_FINALIZE_STATUS_ROUTE_REGEX);
  if (finalizeStatusMatch) {
    const [, rawSessionId] = finalizeStatusMatch;
    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      console.error("finalize-status session parse error:", error);
      return badRequest("Request processing failed");
    }
    if (request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    return proxyToDO(request, env, sessionId, "finalize-status");
  }

  const tier2StatusMatch = path.match(SESSION_TIER2_STATUS_ROUTE_REGEX);
  if (tier2StatusMatch) {
    const [, rawSessionId] = tier2StatusMatch;
    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      console.error("tier2-status session parse error:", error);
      return badRequest("Request processing failed");
    }
    if (request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    return proxyToDO(request, env, sessionId, "tier2-status");
  }

  const incrementalStatusMatch = path.match(SESSION_INCREMENTAL_STATUS_ROUTE_REGEX);
  if (incrementalStatusMatch) {
    const [, rawSessionId] = incrementalStatusMatch;
    let sessionId: string;
    try {
      sessionId = safeSessionId(rawSessionId);
    } catch (error) {
      console.error("incremental-status session parse error:", error);
      return badRequest("Request processing failed");
    }
    if (request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    return proxyToDO(request, env, sessionId, "incremental-status");
  }

  if (SESSION_HISTORY_ROUTE_REGEX.test(path)) {
    if (request.method !== "GET") {
      return jsonResponse({ detail: "method not allowed" }, 405);
    }
    const limitRaw = Number(url.searchParams.get("limit") ?? "20");
    const cursorRaw = String(url.searchParams.get("cursor") ?? "").trim();
    const limit = Math.max(1, Math.min(HISTORY_MAX_LIMIT, Number.isFinite(limitRaw) ? limitRaw : 20));
    const listing = await env.RESULT_BUCKET.list({
      prefix: HISTORY_PREFIX,
      cursor: cursorRaw || undefined,
      limit
    });
    const items: HistoryIndexItem[] = [];
    for (const obj of listing.objects) {
      const object = await env.RESULT_BUCKET.get(obj.key);
      if (!object) continue;
      try {
        const parsed = JSON.parse(await object.text()) as HistoryIndexItem;
        if (!parsed || typeof parsed !== "object") continue;
        items.push(parsed);
      } catch {
        continue;
      }
    }
    return jsonResponse({
      items,
      limit,
      cursor: listing.truncated ? listing.cursor ?? null : null,
      has_more: listing.truncated
    });
  }

  const match = path.match(SESSION_ROUTE_REGEX);
  if (!match) {
    return jsonResponse({ detail: "route not found" }, 404);
  }

  const [, rawSessionId, action] = match;

  let sessionId: string;
  try {
    sessionId = safeSessionId(rawSessionId);
  } catch (error) {
    console.error("session action parse error:", error);
    return badRequest("Request processing failed");
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
  if (action === "utterances" && request.method !== "GET") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "asr-run" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "asr-reset" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "config" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "events" && request.method !== "GET") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "cluster-map" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "unresolved-clusters" && request.method !== "GET") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "memos" && !["GET", "POST"].includes(request.method)) {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "speaker-logs" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "result" && request.method !== "GET") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "feedback-ready" && request.method !== "GET") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "feedback-open" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "feedback-regenerate-claim" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "feedback-claim-evidence" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }
  if (action === "export" && request.method !== "POST") {
    return jsonResponse({ detail: "method not allowed" }, 405);
  }

  return proxyToDO(request, env, sessionId, action);
}
