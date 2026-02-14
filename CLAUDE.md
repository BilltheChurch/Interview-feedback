# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Interview Feedback MVP-A** is a monorepo implementing a realtime interview recording and processing system with three main components:

1. **Inference Service** (`inference/`) — FastAPI backend for audio processing
   - Audio normalization (16kHz/mono/PCM16)
   - Voice Activity Detection (VAD) segmentation
   - Speaker Verification (SV) embedding via ModelScope
   - Online clustering for speaker identification
   - Diarization endpoint (reserved as plugin)

2. **Edge Gateway** (`edge/worker/`) — Cloudflare Worker + Durable Objects + R2
   - Realtime WebSocket audio ingest and chunking
   - Automatic Speech Recognition (ASR) via Aliyun DashScope
   - Speaker resolution and enrollment
   - Finalization pipeline (v2 reconciliation)
   - Session state management via Durable Objects
   - Result storage in R2 buckets

3. **Desktop Capture App** (`desktop/`) — Electron application
   - Dual-stream audio capture (microphone + system audio)
   - Audio normalization and local recording
   - Realtime WebSocket upload to Edge Gateway
   - Session configuration UI
   - Live transcript and speaker events view

## Key Architecture Patterns

### Audio Pipeline
- **Normalization**: All audio is strictly enforced as 16kHz/mono/pcm_s16le before processing
- **Streaming**: Dual WebSocket streams per session (`teacher` = microphone, `students` = system audio)
- **Chunking**: 1-second PCM chunks with sequence tracking for reliability
- **Echo Suppression**: Chunk-by-chunk correlation-based filtering for dual-stream scenarios

### Failover & Reliability
- **Circuit Breaker Pattern** (Worker → Inference): Configurable timeout, retry, and backoff
- **Failover Routing**: Primary + secondary inference endpoints (wrangler.jsonc vars)
- **Stream Recovery**: Exponential backoff (1s → 2s → 5s) for network failures
- **State Durability**: Durable Objects persist session state across Worker restarts

### Configuration Management
- **Environment Files**: `.env.example`, `.env.production` for different deployment tiers
- **Wrangler Vars**: Worker behavior (timeouts, model names, feature flags) in `wrangler.jsonc`
- **API Keys**: Inference service key, Aliyun DashScope key via Wrangler secrets

## Development Setup

### Inference Service
```bash
cd inference
cp .env.example .env        # or .env.production for production-like settings
docker compose up --build   # Starts FastAPI service + dependencies
curl http://localhost:8000/health  # Verify service is running
```

**Key Endpoints:**
- `POST /sv/extract_embedding` — Extract speaker embedding from audio chunk
- `POST /sv/score` — Score similarity between two embeddings
- `POST /speaker/resolve` — Resolve speaker identity for a window
- `POST /speaker/enroll` — Enroll speaker in session
- `GET /health` — Service health check

**Environment Variables:**
- `INFERENCE_API_KEY` — (Optional) API key for request validation
- `MODEL_REVISION_SV` — ModelScope speaker verification model revision
- `MAX_REQUEST_BODY_BYTES` — Request size limit
- `RATE_LIMIT_*` — In-memory IP rate limiting thresholds

**Run Tests:**
```bash
cd inference
python -m pytest tests/ -v
python -m pytest tests/test_speaker_verify.py -v  # Single test file
```

### Edge Worker (Cloudflare)
```bash
cd edge/worker
npm install
npm run dev                 # Local development server (port 8787)
npm run typecheck          # TypeScript validation
npm run deploy             # Deploy to Cloudflare (requires auth)
```

**Key Files:**
- `src/index.ts` — Main request router and WebSocket handler
- `src/types_v2.ts` — Type definitions for session state and events
- `src/inference_client.ts` — Failover-aware HTTP client to inference backend
- `src/finalize_v2.ts` — Report generation and event reconciliation logic
- `wrangler.jsonc` — Configuration (vars, secrets, bindings, routes)

**Configuration in wrangler.jsonc:**
- `INFERENCE_BASE_URL_PRIMARY/SECONDARY` — Backend endpoints
- `INFERENCE_FAILOVER_ENABLED` — Enable circuit breaker
- `ASR_ENABLED`, `ASR_MODEL` — Speech recognition configuration
- `FINALIZE_V2_ENABLED` — Enable v2 finalization pipeline

### Desktop Application (Electron)
```bash
cd desktop
npm install
npm run dev                 # Start Electron app in dev mode
npm run normalize:smoke     # Test audio normalization on sample files
```

**Key Files:**
- `main.js` — Electron main process (window creation, IPC)
- `renderer.js` — UI event handlers and WebSocket management
- `preload.js` — IPC bridge to main process
- `lib/audio_capture.js` — WebRTC audio capture (microphone + system audio)
- `lib/audio_processor.js` — Audio normalization and chunking
- `lib/ws_uploader.js` — Dual WebSocket client (teacher/students streams)

**UI Workflow:**
1. Init microphone and system audio capture
2. Monitor audio levels (Mic, System, Mixed)
3. Configure session (interviewer name, participants list)
4. Click Start Upload → Opens two WebSocket connections
5. Observe live transcript and speaker events in refresh-able panels

## Testing & Validation

### Inference Smoke Test
```bash
python scripts/smoke_sv.py --base-url http://localhost:8000 --samples samples/
```

### Worker WebSocket Ingest Smoke
```bash
cd edge/worker && npm run dev -- --local --port 8787

# In another terminal:
node scripts/ws_ingest_smoke.mjs \
  --base-http http://127.0.0.1:8787 \
  --base-ws ws://127.0.0.1:8787 \
  --chunks 3 --stream-role mixed
```

### Quality Gate Regression
```bash
node scripts/quality_gate_regression.mjs
```

### Speaker Accuracy Evaluation
```bash
node scripts/eval_speaker_accuracy.mjs
```

## Debugging & Troubleshooting

### Inference Service
- **Health Check**: `curl http://localhost:8000/health | jq`
- **Logs**: Run `docker logs <container_id>` for service output
- **Model Issues**: Check `.cache/modelscope/` for downloaded models
- **Request Validation**: If `INFERENCE_API_KEY` is set, include `x-api-key` header

### Worker
- **Local Dev**: `npm run dev` starts wrangler dev server with hot reload
- **Type Checking**: `npm run typecheck` validates TypeScript before deploy
- **Secrets**: Use `npx wrangler secret put KEY_NAME` to set sensitive values
- **Circuit Breaker**: Check wrangler.jsonc vars for timeout/retry configuration

### Desktop
- **Audio Capture Issues**: Verify microphone and system audio permissions in macOS Settings
- **WebSocket Failures**: Check network connectivity to Edge Gateway endpoint
- **Normalization**: Run `npm run normalize:smoke` to test FFmpeg integration

## Important Files & Conventions

### API Contract
- Consult `docs/mvp/Inference_API_Contract.md` for complete inference endpoint spec
- Worker routes documented in `wrangler.jsonc` (routes array)
- Desktop WebSocket protocol defined in `edge/worker/src/types_v2.ts`

### Documentation
- **Project Execution**: `docs/mvp/MVP-A_实施总计划.md`
- **Phase Progress**: `docs/mvp/AI_Handoff_项目进展总览_2026-02-12.md`
- **ASR Details**: `docs/mvp/Phase2_ASR_实施与验收.md`
- **Testing**: `docs/mvp/测试计划与验收清单.md`

### Global Requirements
- Use **Neon** exclusively for database operations (no Firebase)
- Keep **OpenSpec** documentation synchronized with code changes
- Maintain separate `.env` files for dev/staging/production

## Common Development Tasks

### Add a New Inference Endpoint
1. Define request/response schemas in `inference/app/schemas.py`
2. Implement handler in `inference/app/main.py`
3. Add tests to `inference/tests/`
4. Update `docs/mvp/Inference_API_Contract.md`

### Extend Worker Session State
1. Modify session type in `edge/worker/src/types_v2.ts`
2. Update Durable Object class in `edge/worker/src/index.ts`
3. Migration tag in `wrangler.jsonc` (increment if schema changes)
4. Add TypeScript test

### Modify Desktop Capture Logic
1. Update `lib/audio_processor.js` for processing changes
2. Update `lib/ws_uploader.js` for protocol changes
3. Test with `npm run normalize:smoke`
4. Verify in UI with `npm run dev`

## Deployment

### Inference Service (Docker)
```bash
cd inference
docker build -t interview-feedback-inference .
docker run -p 8000:8000 --env-file .env interview-feedback-inference
```

### Edge Worker (Cloudflare)
```bash
cd edge/worker
npm run deploy
# Requires Wrangler auth and project setup
```

### Desktop (Electron Packaging)
```bash
cd desktop
npm run build  # Build for distribution (if configured)
```

## Circuit Breaker Configuration

The Worker implements automatic failover via circuit breaker:
- **INFERENCE_FAILOVER_ENABLED**: Enable/disable automatic failover
- **INFERENCE_TIMEOUT_MS**: Request timeout (default 60000ms)
- **INFERENCE_RETRY_MAX**: Max retry attempts (default 2)
- **INFERENCE_RETRY_BACKOFF_MS**: Backoff between retries (default 180ms)
- **INFERENCE_CIRCUIT_OPEN_MS**: Circuit open duration (default 15000ms)

When primary endpoint times out/fails, Worker automatically routes to `INFERENCE_BASE_URL_SECONDARY`. Update these in `wrangler.jsonc` before deploy.
