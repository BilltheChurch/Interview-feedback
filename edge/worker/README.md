# Cloudflare Worker Gateway (Phase 2/3/4 Skeleton)

This worker is the next-stage gateway between clients and inference:

- Worker: request auth/routing
- Durable Object: per-session state (`clusters`, `bindings`, `events`)
- R2: finalized `result.json` archive

## 1. Prerequisites

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm install
wrangler whoami
```

If `wrangler whoami` fails, login first:

```bash
wrangler login
```

## 2. Required resources

- Durable Object class: `MeetingSessionDO` (managed by migration in `wrangler.jsonc`)
- R2 bucket: `interview-feedback-results`

Create bucket (idempotent):

```bash
wrangler r2 bucket create interview-feedback-results
```

## 3. Required secrets

```bash
wrangler secret put INFERENCE_BASE_URL
wrangler secret put INFERENCE_API_KEY
```

Optional runtime vars in `wrangler.jsonc`:

- `INFERENCE_TIMEOUT_MS` (default `15000`)
- `INFERENCE_RESOLVE_PATH` (default `/speaker/resolve`)

## 4. Local dev

```bash
npm run dev
```

Health check:

```bash
curl -s http://localhost:8787/health | jq
```

## 5. API surface

- `GET /health`
- `POST /v1/sessions/:session_id/resolve`
  - body: `{ audio, asr_text?, roster? }`
  - forwards to inference `/speaker/resolve`
  - persists updated state + event in Durable Object
- `GET /v1/sessions/:session_id/state`
  - returns current DO state snapshot
- `POST /v1/sessions/:session_id/finalize`
  - writes `sessions/<session_id>/result.json` to R2

## 6. Deploy

```bash
npm run deploy
```

On first deploy, Wrangler applies DO migration tag `v1`.
