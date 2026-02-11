# Cloudflare Worker Gateway (Phase 2.3 Realtime)

Gateway responsibilities:
- WebSocket ingest for dual streams (`teacher` / `students`)
- Durable Object session state + speaker events
- Realtime FunASR forwarding (long-lived WS per stream)
- R2 chunk storage + `result.json` finalization

## 1. Prerequisites

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm install
wrangler whoami
```

If needed:

```bash
wrangler login
```

## 2. Required secrets

```bash
wrangler secret put INFERENCE_BASE_URL
wrangler secret put INFERENCE_API_KEY
wrangler secret put ALIYUN_DASHSCOPE_API_KEY
```

## 3. Runtime vars (`wrangler.jsonc`)

- `ASR_MODEL=fun-asr-realtime-2025-11-07`
- `ASR_REALTIME_ENABLED=true`
- `ASR_WS_URL=wss://dashscope.aliyuncs.com/api-ws/v1/inference/`
- `ASR_TIMEOUT_MS=45000`
- `ASR_STREAM_CHUNK_BYTES=12800`
- `ASR_SEND_PACING_MS=0`
- `ASR_DEBUG_LOG_EVENTS=false`

Legacy backfill path still available:
- `ASR_WINDOW_SECONDS`
- `ASR_HOP_SECONDS`

## 4. API Surface

- `GET /health`
- `GET /v1/audio/ws/:session_id`
- `GET /v1/audio/ws/:session_id/:stream_role` (`teacher|students`)
- `POST /v1/sessions/:session_id/config`
  - body:
    - `teams_participants: [{name,email?}] | ["name1","name2"]`
    - `teams_interviewer_name`
    - `interviewer_name`
- `GET /v1/sessions/:session_id/events?stream_role=...&limit=...`
- `GET /v1/sessions/:session_id/state`
- `GET /v1/sessions/:session_id/utterances?stream_role=...&view=raw|merged&limit=...`
- `POST /v1/sessions/:session_id/resolve?stream_role=...`
- `POST /v1/sessions/:session_id/asr-run?stream_role=...&max_windows=...` (backfill only)
- `POST /v1/sessions/:session_id/asr-reset?stream_role=...`
- `POST /v1/sessions/:session_id/finalize`

## 5. Realtime behavior

- Main path is realtime ASR:
  - ingest `chunk` -> enqueue -> long-lived ASR WS send (no 10s window replay)
- `asr_by_stream` now includes:
  - `mode`
  - `asr_ws_state`
  - `backlog_chunks`
  - `ingest_lag_seconds`
  - `last_emit_at`
  - `ingest_to_utterance_p50_ms`
  - `ingest_to_utterance_p95_ms`
- `state` now also includes:
  - `capture_by_stream.students.capture_state`
  - `capture_by_stream.students.recover_attempts`
  - `capture_by_stream.students.last_recover_at`
  - `capture_by_stream.students.last_recover_error`
  - `capture_by_stream.teacher.echo_suppressed_chunks`
  - `capture_by_stream.teacher.echo_suppression_recent_rate`
- ingest WS supports `capture_status` frames from desktop and persists them into session state.
- `utterances view=merged` uses overlap-aware merge (`merged v2`), not exact-string-only dedup.

## 6. Smoke Commands

WS ingest:

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http https://api.frontierace.ai \
  --base-ws wss://api.frontierace.ai \
  --session-id ws-smoke-realtime \
  --stream-role teacher \
  --chunks 6
```

Backfill route compatibility:

```bash
python /Users/billthechurch/Interview-feedback/scripts/smoke_asr_worker.py \
  --base-url https://api.frontierace.ai \
  --session-id soak-20260211-02 \
  --stream-role mixed \
  --view merged \
  --min-utterances 50 \
  --max-windows 1
```

## 7. Deploy

```bash
npm run deploy
```
