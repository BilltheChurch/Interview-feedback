# Interview Feedback MVP-A

This repository implements the MVP-A inference orchestrator for real-time interview recording:

- FastAPI inference service (`inference/`)
- Cloudflare Worker + Durable Object + R2 gateway skeleton (`edge/worker/`)
- Live task tracking (`Task.md`)
- Source product docs snapshot (`docs/source/`)
- Project execution docs (`docs/mvp/`)
- Smoke/regression scripts (`scripts/`)
- Local sample audio folder (`samples/`)

## Start Inference Service

```bash
cd /Users/billthechurch/Interview-feedback/inference
cp .env.example .env
docker compose up --build
```

## Run Smoke Test

```bash
python /Users/billthechurch/Interview-feedback/scripts/smoke_sv.py \
  --base-url http://localhost:8000 \
  --samples /Users/billthechurch/Interview-feedback/samples
```

## Next Stage (Cloudflare Worker/DO/R2)

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm install
wrangler whoami
npm run dev
```

## Prepare Sample Audio

```bash
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh alice /path/to/alice_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples
/Users/billthechurch/Interview-feedback/scripts/create_smoke_samples.sh bob /path/to/bob_raw.wav 0 12 6 /Users/billthechurch/Interview-feedback/samples
/Users/billthechurch/Interview-feedback/scripts/validate_samples.sh /Users/billthechurch/Interview-feedback/samples
```

## Desktop Phase 1 Self-check

```bash
cd /Users/billthechurch/Interview-feedback/desktop
npm install
npm run normalize:smoke
npm run dev
```

Desktop capture requirement (from PRD): run dual-input capture in meeting mode.
- Input A: local microphone (teacher)
- Input B: system/Teams audio (remote participants)
- Desktop app records mixed A+B locally, and uploads two realtime streams:
  - `teacher`: mic stream
  - `students`: system stream
- Desktop Phase 2.3 view now includes:
  - `Session Config` (`teams_participants` / interviewer fields)
  - `Live Transcript` (`raw` + `merged`)
  - `Speaker Events` (with `identity_source`)

## Worker WS Ingest Smoke

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm run dev -- --local --port 8787
```

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http http://127.0.0.1:8787 \
  --base-ws ws://127.0.0.1:8787 \
  --chunks 3 \
  --stream-role mixed
```

## Worker ASR Smoke (Phase 2)

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npx wrangler secret put ALIYUN_DASHSCOPE_API_KEY
```

```bash
python /Users/billthechurch/Interview-feedback/scripts/smoke_asr_worker.py \
  --base-url https://api.frontierace.ai \
  --session-id soak-20260211-02 \
  --stream-role mixed \
  --min-utterances 1 \
  --max-windows 1
```

## Worker Realtime Smoke (Phase 2.3)

```bash
curl -sS https://api.frontierace.ai/health | jq
```

```bash
curl -sS -X POST "https://api.frontierace.ai/v1/sessions/realtime-check/config" \
  -H "content-type: application/json" \
  -d '{"teams_participants":[{"name":"Bill"},{"name":"Alice"}],"teams_interviewer_name":"Bill","interviewer_name":"Bill Pre"}' | jq
```

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http https://api.frontierace.ai \
  --base-ws wss://api.frontierace.ai \
  --session-id realtime-check \
  --stream-role teacher \
  --chunks 6
```

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http https://api.frontierace.ai \
  --base-ws wss://api.frontierace.ai \
  --session-id realtime-check \
  --stream-role students \
  --chunks 6
```

```bash
curl -sS "https://api.frontierace.ai/v1/sessions/realtime-check/state" | jq
curl -sS "https://api.frontierace.ai/v1/sessions/realtime-check/events?limit=50" | jq
```

## Worker ASR Backfill (Model Re-run)

```bash
python /Users/billthechurch/Interview-feedback/scripts/backfill_asr_session.py \
  --base-url https://api.frontierace.ai \
  --session-id soak-20260211-02 \
  --stream-role mixed \
  --batch-windows 5 \
  --reset-first
```
