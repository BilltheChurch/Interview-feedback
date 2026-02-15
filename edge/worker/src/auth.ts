/**
 * Validate API key from request headers or query params.
 * Returns null if authorized, or a 401 Response if not.
 * If WORKER_API_KEY is not set (empty/undefined), auth is skipped (dev mode).
 */
export function validateApiKey(request: Request, env: Record<string, unknown>): Response | null {
  const key = env.WORKER_API_KEY as string | undefined;
  if (!key) return null; // dev mode — no key configured

  const url = new URL(request.url);
  const incoming = request.headers.get('x-api-key') || url.searchParams.get('api_key');

  if (!incoming || !timingSafeEqual(incoming, key)) {
    return new Response(JSON.stringify({ detail: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
