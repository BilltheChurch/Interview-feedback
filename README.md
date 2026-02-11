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

## Worker WS Ingest Smoke

```bash
cd /Users/billthechurch/Interview-feedback/edge/worker
npm run dev -- --local --port 8787
```

```bash
node /Users/billthechurch/Interview-feedback/scripts/ws_ingest_smoke.mjs \
  --base-http http://127.0.0.1:8787 \
  --base-ws ws://127.0.0.1:8787 \
  --chunks 3
```
