# Inference Service (MVP-A)

FastAPI inference orchestrator for:
- audio normalization (16kHz/mono/PCM16)
- VAD segmentation
- SV embedding + score (`iic/speech_campplus_sv_zh_en_16k-common_advanced`)
- online clustering
- name extraction and binding policy
- diarization endpoint reserved as plugin (`/sd/diarize` => 501 for MVP-A)

## Quick Start

1. Copy environment template:

```bash
cd /Users/billthechurch/Interview-feedback/inference
cp .env.example .env
```

For production-like settings (fixed model revision + API key placeholder), use:

```bash
cp .env.production .env
```

2. Start service:

```bash
docker compose up --build
```

If `INFERENCE_API_KEY` is set, include `x-api-key` in every request.
The service also enforces:
- request body cap (`MAX_REQUEST_BODY_BYTES`)
- in-memory IP rate limiting (`RATE_LIMIT_*`)

3. Health check:

```bash
curl -s http://localhost:8000/health | jq
```

## Model Pre-download (Optional but Recommended)

Use `/Users/billthechurch/Interview-feedback/docs/mvp/ModelScope_模型下载与版本固定.md`.

## API Endpoints

- `GET /health`
- `POST /sv/extract_embedding`
- `POST /sv/score`
- `POST /speaker/resolve`
- `POST /sd/diarize` (501)

## Public Exposure

Use named Cloudflare Tunnel for a stable HTTPS endpoint:
- `/Users/billthechurch/Interview-feedback/scripts/cloudflare_tunnel_bootstrap.sh`
- `/Users/billthechurch/Interview-feedback/scripts/cloudflare_tunnel_run.sh`
- `/Users/billthechurch/Interview-feedback/docs/mvp/本地Docker与CloudflareTunnel联调手册.md`
