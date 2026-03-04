/**
 * Validate API key from request headers for HTTP endpoints.
 * Returns null if authorized, or a 401 Response if not.
 * If WORKER_API_KEY is not set (empty/undefined), auth is skipped (dev mode).
 *
 * NOTE: WebSocket connections are NOT authenticated here at the HTTP upgrade
 * level. Instead, auth is performed via first-message frame after WS accept.
 * See validateWsAuthFrame() below.
 */
export function validateApiKey(request: Request, env: Record<string, unknown>): Response | null {
  const key = env.WORKER_API_KEY as string | undefined;
  if (!key) return null; // dev mode — no key configured

  // For WebSocket upgrade requests, skip HTTP-level auth — WS auth is done
  // via first-message frame after connection is accepted (see validateWsAuthFrame).
  const upgrade = request.headers.get('upgrade');
  if (upgrade && upgrade.toLowerCase() === 'websocket') return null;

  // HTTP endpoints: validate x-api-key header only (no query param fallback).
  const incoming = request.headers.get('x-api-key') || '';

  if (!timingSafeEqual(incoming, key)) {
    return new Response(JSON.stringify({ detail: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  return null;
}

/**
 * Validate the first WebSocket auth frame.
 * Expected frame: { type: "auth", key: "..." }
 * Returns true if auth passes (or no key is configured — dev mode).
 */
export function validateWsAuthFrame(
  frame: Record<string, unknown>,
  env: Record<string, unknown>
): boolean {
  const key = env.WORKER_API_KEY as string | undefined;
  if (!key) return true; // dev mode — no key configured

  if (frame.type !== 'auth') return false;
  const incoming = String(frame.key ?? '');
  return timingSafeEqual(incoming, key);
}

function timingSafeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}
